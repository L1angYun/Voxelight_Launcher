use crate::{
    errors::{AppError, AppResult},
    minecraft,
    storage::{safe_join, LauncherState},
};
use fastnbt::Value as Nbt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream, ToSocketAddrs, UdpSocket},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;

const MAX_SERVERS_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub index: usize,
    pub name: String,
    pub address: String,
    pub icon: Option<String>,
    pub hide_address: bool,
    pub snapshot: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    name: String,
    address: String,
    hide_address: bool,
}

#[derive(Deserialize)]
pub struct ServerExpected {
    index: usize,
    snapshot: String,
}

struct ServerTarget<'a> {
    path: PathBuf,
    version_id: &'a str,
    instance_id: Option<&'a str>,
}

impl ServerTarget<'_> {
    fn snapshot(&self, bytes: Option<&[u8]>) -> [u8; 32] {
        let mut hash = Sha256::new();
        for field in [
            self.path.as_os_str().as_encoded_bytes(),
            self.version_id.as_bytes(),
            self.instance_id.unwrap_or_default().as_bytes(),
        ] {
            hash.update((field.len() as u64).to_be_bytes());
            hash.update(field);
        }
        hash.update([
            u8::from(self.instance_id.is_some()),
            u8::from(bytes.is_some()),
        ]);
        hash.update(bytes.unwrap_or_default());
        hash.finalize().into()
    }
}

struct ServerFile {
    root: HashMap<String, Nbt>,
    gzip: bool,
    snapshot: [u8; 32],
}

fn row_snapshot(snapshot: &[u8; 32], index: usize) -> String {
    let mut hash = Sha256::new();
    hash.update(snapshot);
    hash.update((index as u64).to_be_bytes());
    format!("{:x}", hash.finalize())
}

fn snapshot_changed() -> AppError {
    AppError::new("server.snapshotChanged")
}

fn require_expected(
    file: &ServerFile,
    index: usize,
    expected: Option<&ServerExpected>,
) -> AppResult<()> {
    if matches!(expected, Some(value) if value.index == index && value.snapshot == row_snapshot(&file.snapshot, index))
        && matches!(file.root.get("servers"), Some(Nbt::List(rows)) if matches!(rows.get(index), Some(Nbt::Compound(_))))
    {
        Ok(())
    } else {
        Err(snapshot_changed())
    }
}

fn target<'a>(
    state: &LauncherState,
    version: &'a str,
    instance_id: Option<&'a str>,
) -> Result<ServerTarget<'a>, String> {
    let data = state.snapshot()?;
    let instance = instance_id
        .map(|id| {
            data.instances
                .iter()
                .find(|i| i.id == id)
                .ok_or("实例不存在")
        })
        .transpose()?;
    let root = minecraft::game_directory(&data.config, version, instance)?;
    Ok(ServerTarget {
        path: safe_join(&root, "servers.dat")?,
        version_id: version,
        instance_id,
    })
}

fn read_servers(target: &ServerTarget<'_>) -> Result<ServerFile, String> {
    let file = match fs::File::open(&target.path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(ServerFile {
                root: HashMap::new(),
                gzip: false,
                snapshot: target.snapshot(None),
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SERVERS_FILE_BYTES {
        return Err("服务器列表文件过大".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SERVERS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SERVERS_FILE_BYTES {
        return Err("服务器列表文件过大".into());
    }
    let gzip = bytes.starts_with(&[31, 139]);
    let snapshot = target.snapshot(Some(&bytes));
    let data = if gzip {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .take(MAX_SERVERS_FILE_BYTES + 1)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        if out.len() as u64 > MAX_SERVERS_FILE_BYTES {
            return Err("服务器列表解压过大".into());
        }
        out
    } else {
        bytes
    };
    Ok(ServerFile {
        root: fastnbt::from_bytes(&data)
            .map_err(|e| format!("servers.dat 格式错误，未覆盖原文件：{e}"))?,
        gzip,
        snapshot,
    })
}
fn entries(root: &HashMap<String, Nbt>, snapshot: &[u8; 32]) -> Vec<ServerEntry> {
    let Some(Nbt::List(list)) = root.get("servers") else {
        return Vec::new();
    };
    list.iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let Nbt::Compound(row) = value else {
                return None;
            };
            let text = |key: &str| match row.get(key) {
                Some(Nbt::String(value)) => value.clone(),
                _ => String::new(),
            };
            Some(ServerEntry {
                index,
                name: text("name"),
                address: text("ip"),
                icon: row.get("icon").and_then(|v| {
                    if let Nbt::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                }),
                hide_address: matches!(row.get("hideAddress"), Some(Nbt::Byte(1))),
                snapshot: row_snapshot(snapshot, index),
            })
        })
        .collect()
}
fn write_servers(target: &ServerTarget<'_>, file: &ServerFile) -> Result<[u8; 32], String> {
    let path = &target.path;
    let data = fastnbt::to_bytes(&file.root).map_err(|e| e.to_string())?;
    let bytes = if file.gzip {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&data).map_err(|e| e.to_string())?;
        encoder.finish().map_err(|e| e.to_string())?
    } else {
        data
    };
    let directory = path.parent().ok_or("目录无效")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::copy(
            path,
            directory.join(format!("servers.dat.backup-{}", uuid::Uuid::new_v4())),
        )
        .map_err(|e| e.to_string())?;
    }
    let temp = directory.join(format!("servers-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    Ok(target.snapshot(Some(&bytes)))
}
#[tauri::command]
pub fn list_servers(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> Result<Vec<ServerEntry>, String> {
    let target = target(&state, &version_id, instance_id.as_deref())?;
    let file = read_servers(&target)?;
    Ok(entries(&file.root, &file.snapshot))
}
fn save_server_inner(
    target: &ServerTarget<'_>,
    entry: ServerInput,
    index: Option<usize>,
    expected: Option<&ServerExpected>,
) -> AppResult<Vec<ServerEntry>> {
    split_address(&entry.address)?;
    if entry.name.trim().is_empty()
        || entry.name.len() > 256
        || entry.name.chars().any(char::is_control)
    {
        return Err("服务器名称需要为可显示文字".into());
    }
    let mut file = read_servers(target)?;
    if let Some(index) = index {
        require_expected(&file, index, expected)?;
    } else if expected.is_some() {
        return Err(snapshot_changed());
    }
    let list = file
        .root
        .entry("servers".into())
        .or_insert_with(|| Nbt::List(Vec::new()));
    let Nbt::List(list) = list else {
        return Err("服务器列表结构无效，原文件已保留".into());
    };
    let mut row = if let Some(i) = index {
        if let Some(Nbt::Compound(row)) = list.get(i) {
            row.clone()
        } else {
            return Err(snapshot_changed());
        }
    } else {
        HashMap::new()
    };
    row.insert("name".into(), Nbt::String(entry.name.trim().into()));
    row.insert("ip".into(), Nbt::String(entry.address.trim().into()));
    row.insert(
        "hideAddress".into(),
        Nbt::Byte(i8::from(entry.hide_address)),
    );
    if let Some(i) = index {
        list[i] = Nbt::Compound(row)
    } else {
        list.push(Nbt::Compound(row));
    }
    let snapshot = write_servers(target, &file)?;
    Ok(entries(&file.root, &snapshot))
}

#[tauri::command]
pub async fn save_server(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    entry: ServerInput,
    index: Option<usize>,
    expected: Option<ServerExpected>,
) -> AppResult<Vec<ServerEntry>> {
    let _guard = state.operation.lock().await;
    let target = target(&state, &version_id, instance_id.as_deref())?;
    save_server_inner(&target, entry, index, expected.as_ref())
}

fn remove_server_inner(
    target: &ServerTarget<'_>,
    index: usize,
    expected: Option<&ServerExpected>,
) -> AppResult<Vec<ServerEntry>> {
    let mut file = read_servers(target)?;
    require_expected(&file, index, expected)?;
    let Some(Nbt::List(list)) = file.root.get_mut("servers") else {
        return Err(snapshot_changed());
    };
    list.remove(index);
    let snapshot = write_servers(target, &file)?;
    Ok(entries(&file.root, &snapshot))
}

#[tauri::command]
pub async fn remove_server(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    index: usize,
    expected: Option<ServerExpected>,
) -> AppResult<Vec<ServerEntry>> {
    let _guard = state.operation.lock().await;
    let target = target(&state, &version_id, instance_id.as_deref())?;
    remove_server_inner(&target, index, expected.as_ref())
}

pub fn split_address(address: &str) -> Result<(String, u16), String> {
    let value = address.trim();
    if value.is_empty()
        || value.len() > 300
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains(['/', '\\', '@', '?', '#'])
    {
        return Err("请输入主机名或 IP，可附端口，例如 example.org:25565".into());
    }
    let (host, port): (String, u16) = if let Some(rest) = value.strip_prefix('[') {
        let (end, suffix) = rest.split_once(']').ok_or("IPv6 地址需使用方括号")?;
        let port = if suffix.is_empty() {
            25565
        } else {
            suffix
                .strip_prefix(':')
                .ok_or("端口格式错误")?
                .parse::<u16>()
                .map_err(|_| "端口无效")?
        };
        (end.into(), port)
    } else if value.matches(':').count() == 1 {
        let (host, port) = value.rsplit_once(':').ok_or("地址无效")?;
        (host.into(), port.parse::<u16>().map_err(|_| "端口无效")?)
    } else {
        (value.into(), 25565)
    };
    if host.is_empty() || port == 0 {
        return Err("主机名或端口无效".into());
    }
    Ok((host, port))
}
fn varint(mut value: u32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 127) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 128;
        }
        out.push(byte);
        if value == 0 {
            return out;
        }
    }
}
fn read_varint(stream: &mut impl Read) -> Result<u32, String> {
    let mut value = 0u32;
    for n in 0..5 {
        let mut byte = [0];
        stream.read_exact(&mut byte).map_err(|e| e.to_string())?;
        value |= u32::from(byte[0] & 127) << (7 * n);
        if byte[0] & 128 == 0 {
            return Ok(value);
        }
    }
    Err("服务器数据中的 VarInt 过长".into())
}
fn packet(stream: &mut TcpStream, data: &[u8]) -> Result<(), String> {
    stream
        .write_all(&varint(data.len() as u32))
        .and_then(|_| stream.write_all(data))
        .map_err(|e| e.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub address: String,
    pub online: bool,
    pub latency_ms: Option<u64>,
    pub version: Option<String>,
    pub players_online: Option<u64>,
    pub players_max: Option<u64>,
    pub description: String,
    pub icon: Option<String>,
    pub error: Option<String>,
}
fn ping(address: String) -> Result<ServerStatus, String> {
    let (host, port) = split_address(&address)?;
    let started = Instant::now();
    let endpoints = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .take(8)
        .collect::<Vec<_>>();
    let mut last = String::new();
    let mut connection = None;
    for endpoint in endpoints {
        match TcpStream::connect_timeout(&endpoint, Duration::from_secs(2)) {
            Ok(value) => {
                connection = Some(value);
                break;
            }
            Err(error) => last = error.to_string(),
        }
    }
    let mut stream = connection.ok_or_else(|| format!("无法连接服务器：{last}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    let mut hello = vec![0];
    hello.extend(varint(u32::MAX));
    hello.extend(varint(host.len() as u32));
    hello.extend(host.as_bytes());
    hello.extend(port.to_be_bytes());
    hello.push(1);
    packet(&mut stream, &hello)?;
    packet(&mut stream, &[0])?;
    let length = read_varint(&mut stream)? as usize;
    if length > 1024 * 1024 {
        return Err("服务器响应超出大小限制".into());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let mut cursor = std::io::Cursor::new(bytes);
    if read_varint(&mut cursor)? != 0 {
        return Err("服务器状态包类型不正确".into());
    }
    let size = read_varint(&mut cursor)? as usize;
    if size > 1024 * 1024 {
        return Err("服务器状态文本过大".into());
    }
    let mut text = vec![0; size];
    cursor.read_exact(&mut text).map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_slice(&text).map_err(|e| e.to_string())?;
    fn plain(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Object(map) => {
                let mut text = map
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                if let Some(extra) = map.get("extra").and_then(|v| v.as_array()) {
                    for item in extra {
                        text.push_str(&plain(item));
                    }
                }
                text
            }
            _ => String::new(),
        }
    }
    Ok(ServerStatus {
        address,
        online: true,
        latency_ms: Some(started.elapsed().as_millis() as u64),
        version: data["version"]["name"].as_str().map(str::to_owned),
        players_online: data["players"]["online"].as_u64(),
        players_max: data["players"]["max"].as_u64(),
        description: plain(&data["description"]),
        icon: data["favicon"]
            .as_str()
            .filter(|s| s.starts_with("data:image/png;base64,") && s.len() < 128 * 1024)
            .map(str::to_owned),
        error: None,
    })
}
#[tauri::command]
pub async fn ping_server(address: String) -> Result<ServerStatus, String> {
    split_address(&address)?;
    let original = address.clone();
    Ok(tokio::task::spawn_blocking(move || ping(address))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|error| ServerStatus {
            address: original,
            online: false,
            latency_ms: None,
            version: None,
            players_online: None,
            players_max: None,
            description: String::new(),
            icon: None,
            error: Some(error),
        }))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanWorld {
    pub motd: String,
    pub address: String,
    pub port: u16,
}
#[tauri::command]
pub async fn discover_lan() -> Result<Vec<LanWorld>, String> {
    tokio::task::spawn_blocking(|| {
        let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 4445))
            .map_err(|e| format!("无法监听局域网广播端口 4445：{e}"))?;
        socket
            .join_multicast_v4(&Ipv4Addr::new(224, 0, 2, 60), &Ipv4Addr::UNSPECIFIED)
            .map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_millis(350)))
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut buffer = [0; 4096];
        while start.elapsed() < Duration::from_secs(4) {
            if let Ok((size, peer)) = socket.recv_from(&mut buffer) {
                let data = String::from_utf8_lossy(&buffer[..size]);
                let extract = |a: &str, b: &str| {
                    data.split_once(a)
                        .and_then(|(_, v)| v.split_once(b))
                        .map(|(v, _)| v.to_owned())
                };
                if let (Some(motd), Some(port)) =
                    (extract("[MOTD]", "[/MOTD]"), extract("[AD]", "[/AD]"))
                {
                    if let Ok(port) = port.parse::<u16>() {
                        let address = format!("{}:{port}", peer.ip());
                        if port > 0 && seen.insert(address.clone()) {
                            results.push(LanWorld {
                                motd,
                                address,
                                port,
                            });
                        }
                    }
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_handle_ipv6_and_reject_urls() {
        assert_eq!(split_address("[::1]:25566").unwrap(), ("::1".into(), 25566));
        assert_eq!(
            split_address("example.org").unwrap(),
            ("example.org".into(), 25565)
        );
        assert!(split_address("https://example.org").is_err());
        assert!(split_address("host:0").is_err());
    }
    #[test]
    fn nbt_server_entries_preserve_unknown_fields() {
        let mut row = HashMap::new();
        row.insert("name".into(), Nbt::String("Test".into()));
        row.insert("ip".into(), Nbt::String("localhost:25565".into()));
        row.insert("acceptTextures".into(), Nbt::Byte(1));
        let root = HashMap::from([("servers".into(), Nbt::List(vec![Nbt::Compound(row)]))]);
        let bytes = fastnbt::to_bytes(&root).unwrap();
        let decoded = fastnbt::from_bytes(&bytes).unwrap();
        assert_eq!(entries(&decoded, &[0; 32])[0].address, "localhost:25565");
        assert_eq!(root, decoded);
    }

    fn fixture_bytes(marker: i8) -> Vec<u8> {
        let row = Nbt::Compound(HashMap::from([
            ("name".into(), Nbt::String("Fixture bookmark".into())),
            ("ip".into(), Nbt::String("bookmark.example.invalid".into())),
            ("acceptTextures".into(), Nbt::Byte(marker)),
        ]));
        fastnbt::to_bytes(&HashMap::from([(
            "servers".to_string(),
            Nbt::List(vec![row.clone(), row]),
        )]))
        .unwrap()
    }

    fn fixture_with_size(size: usize) -> Vec<u8> {
        let mut root: HashMap<String, Nbt> = fastnbt::from_bytes(&fixture_bytes(1)).unwrap();
        root.insert(
            "padding".into(),
            Nbt::ByteArray(fastnbt::ByteArray::new(vec![])),
        );
        let overhead = fastnbt::to_bytes(&root).unwrap().len();
        root.insert(
            "padding".into(),
            Nbt::ByteArray(fastnbt::ByteArray::new(vec![0; size - overhead])),
        );
        let bytes = fastnbt::to_bytes(&root).unwrap();
        assert_eq!(bytes.len(), size);
        bytes
    }

    fn assert_servers_file_limit(gzip: bool, expected_error: &str) {
        let directory = crate::instances::StagingDirectory::create(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/server-bookmark-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let target = ServerTarget {
            path: directory.path().join("servers.dat"),
            version_id: "A",
            instance_id: None,
        };
        let encode = |size| {
            let bytes = fixture_with_size(size);
            if gzip {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(&bytes).unwrap();
                encoder.finish().unwrap()
            } else {
                bytes
            }
        };
        let limit = 16 * 1024 * 1024;
        fs::write(&target.path, encode(limit)).unwrap();
        let accepted = read_servers(&target).unwrap();
        assert_eq!(accepted.gzip, gzip);
        assert_eq!(entries(&accepted.root, &accepted.snapshot).len(), 2);
        drop(accepted);

        let original = encode(limit + 1);
        if gzip {
            assert!(original.len() < limit, "must reach the decoded size check");
        } else {
            assert_eq!(original.len(), limit + 1);
        }
        fs::write(&target.path, &original).unwrap();
        assert_eq!(read_servers(&target).err().as_deref(), Some(expected_error));
        let error = save_server_inner(
            &target,
            ServerInput {
                name: "New bookmark".into(),
                address: "new.example.invalid".into(),
                hide_address: false,
            },
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error.detail.as_deref(), Some(expected_error));
        assert!(
            fs::read(&target.path).unwrap() == original,
            "original bytes were changed"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn m08_servers_raw_file_rejects_bytes_beyond_sixteen_mib() {
        assert_servers_file_limit(false, "服务器列表文件过大");
    }

    #[test]
    fn m08_servers_gzip_rejects_decoded_bytes_beyond_sixteen_mib() {
        assert_servers_file_limit(true, "服务器列表解压过大");
    }

    fn bookmark(target: &ServerTarget<'_>, index: usize) -> ServerExpected {
        let file = read_servers(target).unwrap();
        let row = &entries(&file.root, &file.snapshot)[index];
        ServerExpected {
            index: row.index,
            snapshot: row.snapshot.clone(),
        }
    }

    #[test]
    fn snapshots_reject_cross_environment_and_cross_row_without_writes() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/server-bookmark-tests").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let bytes = fixture_bytes(1);
        let a = ServerTarget {
            path: directory.join("servers-a.dat"),
            version_id: "A",
            instance_id: None,
        };
        let b = ServerTarget {
            path: directory.join("servers-b.dat"),
            version_id: "B",
            instance_id: None,
        };
        fs::write(&a.path, &bytes).unwrap();
        fs::write(&b.path, &bytes).unwrap();

        let expected = bookmark(&a, 0);
        assert_eq!(
            remove_server_inner(&b, 0, Some(&expected))
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        let forged_index = ServerExpected {
            index: 1,
            snapshot: expected.snapshot.clone(),
        };
        assert_eq!(
            remove_server_inner(&a, 1, Some(&forged_index))
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        // Shared game directories use the same bytes and path for different version requests.
        let shared_b = ServerTarget {
            path: a.path.clone(),
            version_id: "B",
            instance_id: None,
        };
        assert_eq!(
            remove_server_inner(&shared_b, 0, Some(&expected))
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        assert_eq!(fs::read(&a.path).unwrap(), bytes);
        assert_eq!(fs::read(&b.path).unwrap(), bytes);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn changed_file_rejects_stale_edits_and_fresh_edit_and_delete_keep_unknown_nbt() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/server-bookmark-tests").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let target = ServerTarget {
            path: directory.join("servers.dat"),
            version_id: "A",
            instance_id: None,
        };
        fs::write(&target.path, fixture_bytes(1)).unwrap();
        let stale = bookmark(&target, 0);
        // A field not represented by ServerEntry changed externally.
        let changed = fixture_bytes(0);
        fs::write(&target.path, &changed).unwrap();
        let input = || ServerInput {
            name: "Edited bookmark".into(),
            address: "edited.example.invalid".into(),
            hide_address: true,
        };

        assert_eq!(
            remove_server_inner(&target, 0, Some(&stale))
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        assert_eq!(
            save_server_inner(&target, input(), Some(0), None)
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        assert_eq!(
            save_server_inner(&target, input(), Some(0), Some(&stale))
                .unwrap_err()
                .code,
            "server.snapshotChanged"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(fs::read(&target.path).unwrap(), changed);

        let edited =
            save_server_inner(&target, input(), Some(0), Some(&bookmark(&target, 0))).unwrap();
        assert_eq!(edited.len(), 2);
        assert_eq!(edited[0].address, "edited.example.invalid");
        assert!(edited[0].hide_address);
        assert_eq!(edited[0].snapshot, bookmark(&target, 0).snapshot);
        let remaining = remove_server_inner(&target, 1, Some(&bookmark(&target, 1))).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].address, "edited.example.invalid");
        let file = read_servers(&target).unwrap();
        let Nbt::List(rows) = &file.root["servers"] else {
            panic!("server rows changed type")
        };
        let Nbt::Compound(row) = &rows[0] else {
            panic!("server row changed type")
        };
        assert_eq!(row["acceptTextures"], Nbt::Byte(0));
        assert_eq!(
            save_server_inner(&target, input(), None, None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 4);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn varint_round_trips_status_handshake_values() {
        for value in [0, 47, 255, 65535, u32::MAX] {
            assert_eq!(
                read_varint(&mut std::io::Cursor::new(varint(value))).unwrap(),
                value
            );
        }
    }
}
