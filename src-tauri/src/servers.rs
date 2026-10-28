use crate::{
    errors::{expected, AppResult},
    minecraft,
    storage::{safe_join, LauncherState},
};
use fastnbt::Value as Nbt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream, ToSocketAddrs, UdpSocket},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub index: usize,
    pub name: String,
    pub address: String,
    pub icon: Option<String>,
    pub hide_address: bool,
}
fn target(
    state: &LauncherState,
    version: &str,
    instance_id: Option<&str>,
) -> Result<PathBuf, String> {
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
    safe_join(&root, "servers.dat")
}
fn read_servers(path: &std::path::Path) -> Result<(HashMap<String, Nbt>, bool), String> {
    if !path.exists() {
        return Ok((HashMap::new(), false));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("服务器列表文件过大".into());
    }
    let gzip = bytes.starts_with(&[31, 139]);
    let data = if gzip {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        if out.len() > 16 * 1024 * 1024 {
            return Err("服务器列表解压过大".into());
        }
        out
    } else {
        bytes
    };
    Ok((
        fastnbt::from_bytes(&data)
            .map_err(|e| format!("servers.dat 格式错误，未覆盖原文件：{e}"))?,
        gzip,
    ))
}
fn entries(root: &HashMap<String, Nbt>) -> Vec<ServerEntry> {
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
            })
        })
        .collect()
}
fn write_servers(
    path: &std::path::Path,
    root: &HashMap<String, Nbt>,
    gzip: bool,
) -> Result<(), String> {
    let data = fastnbt::to_bytes(root).map_err(|e| e.to_string())?;
    let bytes = if gzip {
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
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn list_servers(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> Result<Vec<ServerEntry>, String> {
    let (path, _) = (target(&state, &version_id, instance_id.as_deref())?, ());
    let (root, _) = read_servers(&path)?;
    Ok(entries(&root))
}
async fn save_server_inner(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    entry: ServerEntry,
    index: Option<usize>,
) -> Result<Vec<ServerEntry>, String> {
    let _guard = state.operation.lock().await;
    split_address(&entry.address)?;
    if entry.name.trim().is_empty()
        || entry.name.len() > 256
        || entry.name.chars().any(char::is_control)
    {
        return Err("服务器名称需要为可显示文字".into());
    }
    let path = target(&state, &version_id, instance_id.as_deref())?;
    let (mut root, gzip) = read_servers(&path)?;
    let list = root
        .entry("servers".into())
        .or_insert_with(|| Nbt::List(Vec::new()));
    let Nbt::List(list) = list else {
        return Err("服务器列表结构无效，原文件已保留".into());
    };
    let mut row = if let Some(i) = index {
        if i >= list.len() {
            return Err("服务器不存在".into());
        }
        if let Nbt::Compound(row) = &list[i] {
            row.clone()
        } else {
            HashMap::new()
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
    write_servers(&path, &root, gzip)?;
    Ok(entries(&root))
}

#[tauri::command]
pub async fn save_server(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    entry: ServerEntry,
    index: Option<usize>,
) -> AppResult<Vec<ServerEntry>> {
    save_server_inner(state, version_id, instance_id, entry, index)
        .await
        .map_err(expected)
}

async fn remove_server_inner(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    index: usize,
) -> Result<Vec<ServerEntry>, String> {
    let _guard = state.operation.lock().await;
    let path = target(&state, &version_id, instance_id.as_deref())?;
    let (mut root, gzip) = read_servers(&path)?;
    let Some(Nbt::List(list)) = root.get_mut("servers") else {
        return Err("服务器列表为空".into());
    };
    if index >= list.len() {
        return Err("服务器不存在".into());
    }
    list.remove(index);
    write_servers(&path, &root, gzip)?;
    Ok(entries(&root))
}

#[tauri::command]
pub async fn remove_server(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    index: usize,
) -> AppResult<Vec<ServerEntry>> {
    remove_server_inner(state, version_id, instance_id, index)
        .await
        .map_err(expected)
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
        assert_eq!(entries(&decoded)[0].address, "localhost:25565");
        assert_eq!(root, decoded);
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
