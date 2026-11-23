// SPDX-License-Identifier: GPL-3.0-only
//! Third-party server software (Spigot, Paper, Fabric and others), imported as
//! a server JAR or an existing server folder. What is imported is copied into
//! the launcher's data folder; it is only ever run as `java -jar <jar> nogui`
//! from there, never as a script or with an arguments file, and nothing here
//! runs it. Detection reads a few small entries of a JAR and is a default only.
use super::*;
use crate::{
    instances::{
        checked_absolute, collect_files_controlled, copy_snapshot_controlled, rename_owned_directory,
        sha256, sync_checkpoint, StagingDirectory,
    },
    path_grants::{PathGrants, PathUse},
};

pub(crate) const IMPORT_INSTALLER: &str = "这是服务端安装器，不是服务端。请先运行它安装服务端，再导入安装生成的文件夹。";
pub(crate) const IMPORT_ARGS_FILE: &str = "这个服务端只能用参数文件启动（1.17 及以后没有 shim JAR 的 Forge，或 NeoForge），启动器暂不支持导入。";
pub(crate) const IMPORT_NEEDS_FOLDER: &str = "这个 JAR 无法单独启动：它需要安装时所在文件夹里的库和服务端文件。请改为导入那个文件夹。";
pub(crate) const IMPORT_JAR_NAME: &str = "服务端 JAR 的文件名无法使用：须以 .jar 结尾，不能以 @ 或 - 开头，也不能是 Windows 保留的名称。请重命名后再导入";
pub(crate) const IMPORT_PROPERTIES_TEXT: &str = "导入的 server.properties 不是 UTF-8 文本、超过 1 MiB 或无法读取";
pub(crate) const IMPORT_NO_JAR: &str = "这个文件夹里没有启动器能运行的服务端 JAR。";
/// Followed by the server.properties key the launcher cannot manage.
pub(crate) const IMPORT_PROPERTIES: &str = "导入的 server.properties 中有超出启动器范围的设置：";
pub(crate) const IMPORT_NOT_JAR: &str = "所选文件不是有效的 JAR";
pub(crate) const IMPORT_OWN_DATA: &str = "不能导入启动器自己的数据文件夹或其中的内容";
pub(crate) const IMPORT_LINKS: &str = "服务端文件夹中有符号链接、目录联接或特殊文件，无法导入";
pub(crate) const IMPORT_TOO_LARGE: &str = "要导入的服务端超过启动器的限制（10 万个文件、32 GiB、64 层目录，或超过 2 GiB 的 JAR），无法导入";
pub(crate) const IMPORT_CHANGED: &str = "复制期间服务端的文件发生变化或无法读取。如果它正在运行，请先停止，再重新导入。";

const ENTRY_LIMIT: u64 = 64 * 1024;
const MAX_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_FILES: u64 = 100_000;
const MAX_DEPTH: usize = 64;
const MAX_JAR_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_JAR_ENTRIES: u64 = 500_000;
const MAX_CENTRAL_DIRECTORY: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    Jar,
    Folder,
}

impl ImportKind {
    fn purpose(self) -> PathUse {
        match self {
            Self::Jar => PathUse::ServerJar,
            Self::Folder => PathUse::ServerFolder,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerImportInspection {
    kind: ImportKind,
    software: Option<&'static str>,
    minecraft_version: Option<String>,
    jars: Vec<String>,
    /// What each of `jars` says about itself, in the same order.
    details: Vec<JarDetail>,
    default_jar: Option<String>,
    total_bytes: u64,
    file_count: u64,
    unsupported: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JarDetail {
    jar: String,
    software: Option<&'static str>,
    minecraft_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportServerRequest {
    kind: ImportKind,
    path: String,
    name: String,
    version_id: String,
    jar: String,
}

/// What a JAR says about itself, read without running it.
struct JarFacts {
    software: Option<&'static str>,
    version: Option<String>,
    installer: bool,
    main: Option<String>,
}

/// A loader's launch JAR, or a JAR with no entry point, cannot start alone: it
/// needs the libraries and Minecraft server JAR of the folder it came from.
/// The Fabric server launcher fetches what it needs itself.
fn needs_folder(facts: &JarFacts) -> bool {
    match facts.main.as_deref() {
        None => true,
        Some("net.fabricmc.installer.ServerLauncher") => false,
        Some(main) => ["net.fabricmc.loader.", "org.quiltmc.loader.", "net.minecraftforge.", "cpw.mods.", "net.neoforged."]
            .iter()
            .any(|prefix| main.starts_with(prefix)),
    }
}

/// Version order for choosing a default among JARs of one kind: newest first.
fn version_order(version: Option<&str>) -> Vec<u64> {
    version
        .map(|value| value.split(|c: char| !c.is_ascii_digit()).filter(|part| !part.is_empty()).map(|part| part.parse().unwrap_or(0)).collect())
        .unwrap_or_default()
}

/// A small text entry of a JAR, or nothing when it is missing, large or not text.
fn small_entry(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<String> {
    let entry = archive.by_name(name).ok()?;
    if entry.size() > ENTRY_LIMIT {
        return None;
    }
    let mut text = String::new();
    entry.take(ENTRY_LIMIT).read_to_string(&mut text).ok()?;
    Some(text)
}

/// The Main-Class of a JAR. A signed JAR's manifest lists a digest for every
/// entry and can be far over the limit, so only its start is read: Main-Class
/// is in the main section, before the first blank line.
fn manifest_main(archive: &mut zip::ZipArchive<fs::File>) -> Option<String> {
    let entry = archive.by_name("META-INF/MANIFEST.MF").ok()?;
    let mut bytes = Vec::new();
    entry.take(ENTRY_LIMIT).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
    main_class(text.split("\n\n").next().unwrap_or_default())
}

/// The entry count and central-directory size a zip declares at its end, read
/// before it is parsed: the parser indexes every entry, so a JAR declaring
/// millions of them is refused first.
fn declared_size(file: &mut fs::File) -> Result<(u64, u64), String> {
    use std::io::SeekFrom;
    const END: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const LOCATOR: [u8; 4] = [0x50, 0x4b, 0x06, 0x07];
    const END64: [u8; 4] = [0x50, 0x4b, 0x06, 0x06];
    let length = file.metadata().map_err(|_| IMPORT_NOT_JAR)?.len();
    let tail = length.min(22 + 65_535) as usize;
    if tail < 22 {
        return Err(IMPORT_NOT_JAR.into());
    }
    let mut bytes = vec![0; tail];
    file.seek(SeekFrom::End(-(tail as i64))).map_err(|_| IMPORT_NOT_JAR)?;
    file.read_exact(&mut bytes).map_err(|_| IMPORT_NOT_JAR)?;
    let at = (0..=tail - 22).rev().find(|&index| bytes[index..index + 4] == END).ok_or(IMPORT_NOT_JAR)?;
    let mut entries = u16::from_le_bytes([bytes[at + 10], bytes[at + 11]]) as u64;
    let mut size = u32::from_le_bytes([bytes[at + 12], bytes[at + 13], bytes[at + 14], bytes[at + 15]]) as u64;
    if entries == 0xFFFF || size == 0xFFFF_FFFF {
        // Zip64: the locator just before the end record points at the zip64 record.
        let locator = at.checked_sub(20).filter(|&index| bytes[index..index + 4] == LOCATOR).ok_or(IMPORT_NOT_JAR)?;
        let offset = u64::from_le_bytes(bytes[locator + 8..locator + 16].try_into().expect("eight bytes"));
        let mut record = [0u8; 56];
        file.seek(SeekFrom::Start(offset)).map_err(|_| IMPORT_NOT_JAR)?;
        file.read_exact(&mut record).map_err(|_| IMPORT_NOT_JAR)?;
        if record[..4] != END64 {
            return Err(IMPORT_NOT_JAR.into());
        }
        entries = u64::from_le_bytes(record[32..40].try_into().expect("eight bytes"));
        size = u64::from_le_bytes(record[40..48].try_into().expect("eight bytes"));
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| IMPORT_NOT_JAR)?;
    Ok((entries, size))
}

fn main_class(manifest: &str) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in manifest.lines() {
        // A manifest wraps long values onto lines that start with a space.
        match (line.strip_prefix(' '), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(line.to_owned()),
        }
    }
    lines
        .iter()
        .find_map(|line| line.strip_prefix("Main-Class:"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn installer_class(main: &str) -> bool {
    main.starts_with("net.minecraftforge.installer.")
        || main.starts_with("net.neoforged.installer.")
        || main.starts_with("org.quiltmc.installer.")
        || main == "net.fabricmc.installer.Main"
}

fn software(main: Option<&str>, name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    let named = |known: &[(&str, &'static str)]| {
        known.iter().find(|(word, _)| name.contains(word)).map(|(_, software)| *software)
    };
    match main {
        Some("io.papermc.paperclip.Main" | "io.papermc.paperclip.Paperclip" | "com.destroystokyo.paperclip.Paperclip") => {
            Some(named(&[("purpur", "Purpur"), ("folia", "Folia")]).unwrap_or("Paper"))
        }
        Some("org.bukkit.craftbukkit.bootstrap.Main") => {
            Some(if name.contains("craftbukkit") { "CraftBukkit" } else { "Spigot" })
        }
        Some("org.bukkit.craftbukkit.Main") => Some(if name.contains("spigot") { "Spigot" } else { "CraftBukkit" }),
        Some("net.fabricmc.installer.ServerLauncher") => Some("Fabric"),
        Some(main) if main.starts_with("net.fabricmc.loader.") => Some("Fabric"),
        Some(main) if main.starts_with("org.quiltmc.loader.") => Some("Quilt"),
        Some(main) if main.starts_with("net.minecraftforge.") || main.starts_with("cpw.mods.") => Some("Forge"),
        Some(main) if main.starts_with("net.neoforged.") => Some("NeoForge"),
        Some("net.minecraft.bundler.Main" | "net.minecraft.server.Main" | "net.minecraft.server.MinecraftServer") => {
            Some("Vanilla")
        }
        _ => named(&[
            ("purpur", "Purpur"),
            ("folia", "Folia"),
            ("paper", "Paper"),
            ("spigot", "Spigot"),
            ("craftbukkit", "CraftBukkit"),
            ("mohist", "Mohist"),
            ("arclight", "Arclight"),
            ("fabric", "Fabric"),
            ("quilt", "Quilt"),
            ("neoforge", "NeoForge"),
            ("forge", "Forge"),
        ]),
    }
}

/// A Minecraft version id the launcher can look up, or nothing.
fn version_id(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() <= 64
        && validate_id(value).is_ok()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c)))
    .then(|| value.to_owned())
}

fn version_in_name(name: &str) -> Option<String> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?:^|[^0-9])((?:1|2[6-9])\.[0-9]{1,2}(?:\.[0-9]{1,2})?)(?:[^0-9]|$)")
            .expect("constant version pattern")
    });
    pattern.captures(name).map(|found| found[1].to_owned())
}

fn jar_facts(path: &Path) -> Result<JarFacts, String> {
    let mut file = fs::File::open(path).map_err(|_| "无法读取所选服务端 JAR")?;
    if file.metadata().map_err(|_| "无法读取所选服务端 JAR")?.len() > MAX_JAR_BYTES {
        return Err(IMPORT_TOO_LARGE.into());
    }
    let (entries, directory) = declared_size(&mut file)?;
    if entries > MAX_JAR_ENTRIES || directory > MAX_CENTRAL_DIRECTORY {
        return Err(IMPORT_TOO_LARGE.into());
    }
    let mut archive = zip::ZipArchive::new(file).map_err(|_| IMPORT_NOT_JAR)?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let main = manifest_main(&mut archive);
    let installer = main.as_deref().is_some_and(installer_class) || name.to_ascii_lowercase().contains("installer");
    // A loader profile names its game version in inheritsFrom, a vanilla server in id.
    let from_json = small_entry(&mut archive, "version.json")
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|json| {
            json["inheritsFrom"].as_str().or_else(|| json["id"].as_str()).and_then(version_id)
        });
    let mut version = from_json;
    if version.is_none() {
        // The Fabric server launcher's own settings.
        version = small_entry(&mut archive, "install.properties").and_then(|text| {
            text.lines()
                .filter_map(property_pair)
                .find(|(key, _)| *key == "game-version")
                .and_then(|(_, value)| version_id(value))
        });
    }
    if version.is_none() {
        // A bundler (vanilla 1.18+, Paperclip): `<hash>\t<id>\t<version>/<file>.jar`.
        version = small_entry(&mut archive, "META-INF/versions.list")
            .and_then(|text| text.lines().next().and_then(|line| line.split('\t').nth(2)).and_then(|path| path.split('/').next()).and_then(version_id));
    }
    if version.is_none() {
        // Paperclip's download record: `<hash>\t<url>\tmojang_<version>.jar`.
        version = small_entry(&mut archive, "META-INF/download-context").and_then(|text| {
            text.lines().next().and_then(|line| line.split('\t').nth(2))
                .and_then(|file| file.strip_prefix("mojang_")?.strip_suffix(".jar").and_then(version_id))
        });
    }
    if version.is_none() {
        version = version_in_name(name.strip_suffix(".jar").unwrap_or(name));
    }
    Ok(JarFacts { software: software(main.as_deref(), name), version, installer, main })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    let mut link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        link |= metadata.file_attributes() & 0x400 != 0;
    }
    link
}

/// How many files a folder holds and their size, refusing links and the same
/// limits the copy enforces, without reading any file.
fn measure(root: &Path) -> Result<(u64, u64), String> {
    let (mut files, mut bytes, mut walked) = (0u64, 0u64, 0u64);
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        if depth > MAX_DEPTH {
            return Err(IMPORT_TOO_LARGE.into());
        }
        for entry in fs::read_dir(&dir).map_err(|_| "无法读取服务端文件夹")? {
            walked += 1;
            if walked > MAX_FILES * 2 {
                return Err(IMPORT_TOO_LARGE.into());
            }
            let path = entry.map_err(|_| "无法读取服务端文件夹")?.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取服务端文件夹")?;
            if is_link(&metadata) {
                return Err(IMPORT_LINKS.into());
            } else if metadata.is_dir() {
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
                if files > MAX_FILES || bytes > MAX_BYTES {
                    return Err(IMPORT_TOO_LARGE.into());
                }
            } else {
                return Err(IMPORT_LINKS.into());
            }
        }
    }
    Ok((files, bytes))
}

/// Forge and NeoForge 1.17+ start from a generated arguments file instead of a JAR.
fn arguments_file_server(root: &Path) -> Option<&'static str> {
    [
        ("libraries/net/minecraftforge/forge", "Forge"),
        ("libraries/net/neoforged/neoforge", "NeoForge"),
        ("libraries/net/neoforged/forge", "NeoForge"),
    ]
    .into_iter()
    .find(|(folder, _)| {
        fs::read_dir(root.join(folder)).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                let dir = entry.path();
                dir.join("win_args.txt").is_file() || dir.join("unix_args.txt").is_file()
            })
        })
    })
    .map(|(_, software)| software)
}

fn inspect(kind: ImportKind, path: &Path) -> Result<ServerImportInspection, String> {
    let path = checked_absolute(path)?;
    let metadata = fs::metadata(&path).map_err(|_| "无法读取所选服务端")?;
    match kind {
        ImportKind::Jar => {
            if !metadata.is_file() {
                return Err("请选择服务端 JAR 文件".into());
            }
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned();
            if !runnable_jar(&name) {
                return Err(IMPORT_JAR_NAME.into());
            }
            let facts = jar_facts(&path)?;
            let unsupported = if facts.installer {
                Some("installer")
            } else if needs_folder(&facts) {
                Some("needsFolder")
            } else {
                None
            };
            let jars = if unsupported.is_some() { Vec::new() } else { vec![name] };
            Ok(ServerImportInspection {
                kind,
                software: facts.software,
                details: jars
                    .iter()
                    .map(|jar| JarDetail { jar: jar.clone(), software: facts.software, minecraft_version: facts.version.clone() })
                    .collect(),
                minecraft_version: facts.version,
                default_jar: jars.first().cloned(),
                jars,
                total_bytes: metadata.len(),
                file_count: 1,
                unsupported,
            })
        }
        ImportKind::Folder => {
            if !metadata.is_dir() {
                return Err("请选择服务端文件夹".into());
            }
            let (file_count, total_bytes) = measure(&path)?;
            let mut found = Vec::new();
            for entry in fs::read_dir(&path).map_err(|_| "无法读取服务端文件夹")?.flatten() {
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
                if !runnable_jar(&name) || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                // A JAR that cannot be read as one, or an installer, is not offered.
                if let Ok(facts) = jar_facts(&entry.path()) {
                    if !facts.installer && facts.main.is_some() {
                        found.push((name, facts));
                    }
                }
            }
            let arguments = arguments_file_server(&path);
            if arguments.is_some() {
                // Such a server starts through a JAR that loads the loader:
                // Forge's shim, or a hybrid such as Arclight. A vanilla or
                // unknown JAR beside it would start without the loader.
                found.retain(|(_, facts)| facts.software.is_some_and(|software| software != "Vanilla"));
            }
            found.sort_by(|a, b| a.0.cmp(&b.0));
            // Third-party server software first (a hybrid such as Arclight
            // before the bare loader it runs on), then a vanilla server, then
            // the rest; the newest version of one kind first.
            let rank = |facts: &JarFacts| match facts.software {
                Some("Forge" | "NeoForge") => 1,
                Some("Vanilla") => 2,
                Some(_) => 0,
                None => 3,
            };
            let chosen = found.iter().min_by_key(|(name, facts)| {
                (rank(facts), std::cmp::Reverse(version_order(facts.version.as_deref())), name.clone())
            });
            Ok(ServerImportInspection {
                kind,
                software: chosen.and_then(|(_, facts)| facts.software).or(arguments),
                minecraft_version: chosen.and_then(|(_, facts)| facts.version.clone()),
                default_jar: chosen.map(|(name, _)| name.clone()),
                unsupported: match (found.is_empty(), arguments.is_some()) {
                    (true, true) => Some("argsFile"),
                    (true, false) => Some("noJar"),
                    (false, _) => None,
                },
                details: found
                    .iter()
                    .map(|(jar, facts)| JarDetail { jar: jar.clone(), software: facts.software, minecraft_version: facts.version.clone() })
                    .collect(),
                jars: found.into_iter().map(|(name, _)| name).collect(),
                total_bytes,
                file_count,
            })
        }
    }
}

/// A copy failure the user can act on: a running server locks its world and
/// changes it while it is copied.
fn copy_problem(error: String) -> String {
    let unreadable = ["无法读取实例文件：", "读取实例文件失败：", "复制实例文件失败："];
    // Windows: ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION. Other copy
    // failures, such as a full disk, keep their own message.
    let locked = error.ends_with("(os error 32)") || error.ends_with("(os error 33)");
    if error == crate::instances::COPY_CHANGED
        || error == crate::instances::COPY_MISMATCH
        || (locked && unreadable.iter().any(|prefix| error.starts_with(prefix)))
    {
        IMPORT_CHANGED.into()
    } else {
        error
    }
}

/// server.properties the launcher cannot read as UTF-8 text.
fn properties_problem(error: String) -> String {
    match error.as_str() {
        "server.properties 过大" | "server.properties 不是有效 UTF-8 文本" | "无法读取 server.properties" => IMPORT_PROPERTIES_TEXT.into(),
        _ => error,
    }
}

/// The launcher never copies its own data folder, or a folder in it, into itself.
fn outside_launcher_data(state: &LauncherState, source: &Path) -> Result<(), String> {
    let data = state.data_dir.canonicalize().unwrap_or_else(|_| state.data_dir.clone());
    let source = source.canonicalize().map_err(|_| "无法读取所选服务端")?;
    if source.starts_with(&data) || data.starts_with(&source) {
        return Err(IMPORT_OWN_DATA.into());
    }
    Ok(())
}

fn validate_request(request: &ImportServerRequest) -> Result<(), String> {
    if request.name.trim().is_empty()
        || request.name.trim().chars().count() > 80
        || request.name.chars().any(char::is_control)
    {
        return Err("服务端名称须为 1–80 个字符且不含控制字符".into());
    }
    validate_id(&request.version_id)
}

/// The launcher's settings from an imported server.properties. A key the
/// launcher cannot manage fails the import by name; the file is never changed.
fn imported_settings(text: &str) -> Result<ServerSettings, String> {
    let base = ServerSettings::default();
    settings_from_properties(text, &base).map_err(|problem| {
        ["server-port", "max-players", "view-distance", "online-mode", "white-list", "motd", "difficulty", "gamemode", "server-ip"]
            .into_iter()
            .find(|key| {
                let only: Vec<&str> = text.lines().filter(|line| property_pair(line).is_some_and(|(k, _)| k == *key)).collect();
                settings_from_properties(&only.join("\n"), &base).is_err()
            })
            .map_or(problem, |key| format!("{IMPORT_PROPERTIES}{key}"))
    })
}

#[cfg(test)]
fn import_into(
    state: &LauncherState,
    request: &ImportServerRequest,
    source: &Path,
) -> Result<ServerDefinition, String> {
    import_with(state, request, source, None)
}

fn import_with(
    state: &LauncherState,
    request: &ImportServerRequest,
    source: &Path,
    control: Option<&LauncherState>,
) -> Result<ServerDefinition, String> {
    validate_request(request)?;
    let source = checked_absolute(source)?;
    outside_launcher_data(state, &source)?;
    let found = inspect(request.kind, &source)?;
    match found.unsupported {
        Some("installer") => return Err(IMPORT_INSTALLER.into()),
        Some("argsFile") => return Err(IMPORT_ARGS_FILE.into()),
        Some("needsFolder") => return Err(IMPORT_NEEDS_FOLDER.into()),
        Some(_) => return Err(IMPORT_NO_JAR.into()),
        None => {}
    }
    if !found.jars.contains(&request.jar) {
        return Err("所选服务端 JAR 不在导入的内容中".into());
    }
    if request.kind == ImportKind::Folder {
        // Fail before copying anything the launcher could not manage.
        imported_settings(&properties(&source).map_err(properties_problem)?)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let target = server_directory(state, &id)?;
    let staging = StagingDirectory::create(safe_join(&servers_root(state)?, &format!(".import-{id}"))?)?;
    let content = staging.path().join("server");
    match request.kind {
        ImportKind::Folder => {
            let files = collect_files_controlled(&source, control).map_err(copy_problem)?;
            // A running server changes its world while it is copied.
            copy_snapshot_controlled(&source, &content, &files, control).map_err(copy_problem)?;
        }
        ImportKind::Jar => {
            fs::create_dir(&content).map_err(|_| "无法创建服务端目录")?;
            let (size, digest) = (fs::metadata(&source).map_err(|_| "无法读取所选服务端 JAR")?.len(), sha256(&source)?);
            let copy = safe_join(&content, &request.jar)?;
            fs::copy(&source, &copy).map_err(|error| format!("复制服务端 JAR 失败：{error}"))?;
            if fs::metadata(&copy).map_err(|error| error.to_string())?.len() != size || sha256(&copy)? != digest {
                return Err(IMPORT_CHANGED.into());
            }
        }
    }
    // What runs is the copy, so what is recorded comes from the copy.
    let facts = jar_facts(&safe_join(&content, &request.jar)?)?;
    if facts.installer {
        return Err(IMPORT_INSTALLER.into());
    }
    let settings = imported_settings(&properties(&content).map_err(properties_problem)?)?;
    if !safe_join(&content, "server.properties")?.is_file() {
        atomic_write(&content, "server.properties", update_properties("", &settings).as_bytes())?;
    }
    atomic_write(
        &content,
        "eula.txt",
        b"# Accept the Minecraft EULA explicitly in the launcher before starting.\neula=false\n",
    )?;
    let definition = ServerDefinition {
        id,
        name: request.name.trim().into(),
        version_id: request.version_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        settings,
        eula_accepted: false,
        eula_accepted_at: None,
        jar_sha1: None,
        java_major: None,
        install_error: None,
        source: ServerSource::Imported,
        jar: Some(request.jar.clone()),
        software: facts.software.map(Into::into),
    };
    save_definition(&content, &definition)?;
    if let Some(state) = control {
        sync_checkpoint(state)?;
    }
    rename_owned_directory(&content, &target).map_err(|error| format!("无法保存导入的服务端：{error}"))?;
    Ok(definition)
}

#[tauri::command]
pub async fn inspect_server_import(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    kind: ImportKind,
    path: String,
) -> AppResult<ServerImportInspection> {
    // Looking keeps the choice for the import itself.
    let source = grants.peek(kind.purpose(), &path, &window)?;
    let shared = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        outside_launcher_data(&shared, &source)?;
        inspect(kind, &source)
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()))
    .map_err(expected)
}

#[tauri::command]
pub async fn import_managed_server(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    request: ImportServerRequest,
) -> AppResult<ManagedServerInfo> {
    let _guard = registry.operation.try_lock().map_err(|_| expected("已有服务端管理操作正在进行"))?;
    let _download = state.operation.try_lock().map_err(|_| expected("已有下载或启动准备任务运行"))?;
    validate_request(&request).map_err(expected)?;
    let purpose = request.kind.purpose();
    let source = grants.consume(request.kind.purpose(), &request.path, &window)?;
    let retry = source.clone();
    let name = request.name.trim().to_owned();
    let result = match state.control.begin_with_display("server-import", &request.version_id, &format!("导入服务端 {name}"), &name) {
        Ok(task) => {
            let shared = state.inner().clone();
            let result = tokio::task::spawn_blocking(move || import_with(&shared, &request, &source, Some(&shared)))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            state.control.finish(&task, result.as_ref().err().map(String::as_str));
            result
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(definition) => server_info(&state, &registry, definition).map_err(expected),
        Err(error) => {
            // Nothing was imported: the same choice can be tried again, for
            // example after fixing server.properties or stopping the server.
            grants.restore(purpose, retry, &window);
            Err(expected(error))
        }
    }
}

#[cfg(test)]
#[path = "server_import-tests.rs"]
mod tests;
