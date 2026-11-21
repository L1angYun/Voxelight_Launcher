use crate::{content::png_preview_data, modpacks::inspect_zip_reader, storage::json_body};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{collections::HashMap, fs::{self, File}, io::Read, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::SystemTime};
use zip::ZipArchive;

const METADATA_LIMIT: usize = 256 * 1024;
const ICON_LIMIT: usize = 512 * 1024;
const JAR_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModMetadata {
    loader: &'static str,
    mod_id: String,
    name: String,
    version: String,
    description: String,
    authors: Vec<String>,
    has_icon: bool,
    dependencies: Vec<ModDependency>,
    additional_mods: usize,
    #[serde(skip)]
    icon: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModDependency {
    id: String,
    kind: &'static str,
    range: String,
}

fn bounded(value: &str, limit: usize) -> String {
    value.chars().filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t')).take(limit).collect()
}

impl ModMetadata {
    fn new(loader: &'static str, id: &str, name: &str, version: &str, desc: &str) -> Option<Self> {
        if id.is_empty() { return None; }
        Some(Self { loader, mod_id: bounded(id, 128), name: bounded(if name.is_empty() { id } else { name }, 128),
            version: bounded(version, 128), description: bounded(desc, 512), authors: vec![], has_icon: false,
            dependencies: vec![], additional_mods: 0, icon: None })
    }
    fn author(&mut self, author: &str) {
        if self.authors.len() < 16 && !author.trim().is_empty() { self.authors.push(bounded(author.trim(), 128)); }
    }
    fn dependency(&mut self, id: &str, kind: &'static str, range: &str) {
        if self.dependencies.len() >= 64 || id.is_empty() || matches!(id, "minecraft" | "java" | "fabricloader" | "quilt_loader" | "forge" | "neoforge") { return; }
        self.dependencies.push(ModDependency { id: bounded(id, 128), kind, range: bounded(range, 128) });
    }
    fn set_icon(&mut self, path: Option<&str>) {
        self.icon = path.filter(|p| p.to_ascii_lowercase().ends_with(".png") && crate::modpacks::archive_relative(p).is_ok()).map(str::to_owned);
        self.has_icon = self.icon.is_some();
    }
}

fn read_entry(zip: &mut ZipArchive<File>, name: &str, limit: usize) -> Option<Vec<u8>> {
    let entry = zip.by_name(name).ok()?;
    if entry.is_dir() || entry.size() > limit as u64 { return None; }
    let mut bytes = Vec::new();
    entry.take(limit as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

fn open_jar(path: &Path) -> Option<ZipArchive<File>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || crate::resources::linked(&meta) || meta.len() > JAR_LIMIT { return None; }
    let mut zip = ZipArchive::new(File::open(path).ok()?).ok()?;
    inspect_zip_reader(&mut zip, JAR_LIMIT, JAR_LIMIT, None).ok()?;
    Some(zip)
}

fn text(value: &Value) -> &str { value.as_str().unwrap_or_default() }
fn range(value: &Value) -> String {
    if let Some(parts) = value.as_array() { parts.iter().filter_map(Value::as_str).take(8).collect::<Vec<_>>().join(" | ") }
    else { text(value).to_owned() }
}
fn icon(value: &Value) -> Option<&str> {
    value.as_str().or_else(|| value.as_object()?.iter()
        .filter_map(|(k, v)| Some((k.parse::<u32>().ok()?, v.as_str()?))).max_by_key(|(size, _)| *size).map(|(_, path)| path))
}

fn parse_json(loader: &'static str, value: &Value) -> Option<ModMetadata> {
    let mut out;
    match loader {
        "fabric" => {
            out = ModMetadata::new(loader, text(&value["id"]), text(&value["name"]), text(&value["version"]), text(&value["description"]))?;
            if let Some(authors) = value["authors"].as_array() {
                for author in authors { out.author(author.as_str().unwrap_or_else(|| text(&author["name"]))); }
            }
            out.set_icon(icon(&value["icon"]));
            for (key, kind) in [("depends", "required"), ("recommends", "optional"), ("breaks", "incompatible")] {
                if let Some(deps) = value[key].as_object() {
                    for (id, constraint) in deps { out.dependency(id, kind, &range(constraint)); }
                }
            }
        }
        "quilt" => {
            let q = &value["quilt_loader"];
            let meta = &q["metadata"];
            out = ModMetadata::new(loader, text(&q["id"]), text(&meta["name"]), text(&q["version"]), text(&meta["description"]))?;
            if let Some(contributors) = meta["contributors"].as_object() { for name in contributors.keys() { out.author(name); } }
            out.set_icon(icon(&meta["icon"]));
            for (key, kind) in [("depends", "required"), ("breaks", "incompatible")] {
                if let Some(deps) = q[key].as_array() {
                    for dep in deps {
                        out.dependency(dep.as_str().unwrap_or_else(|| text(&dep["id"])),
                            if kind == "required" && dep["optional"].as_bool() == Some(true) { "optional" } else { kind }, &range(&dep["versions"]));
                    }
                }
            }
        }
        "legacyForge" => {
            let list = value.as_array().or_else(|| value["modList"].as_array())?;
            let first = list.first()?;
            out = ModMetadata::new(loader, text(&first["modid"]), text(&first["name"]), text(&first["version"]), text(&first["description"]))?;
            out.additional_mods = list.len().saturating_sub(1);
            out.set_icon(first["logoFile"].as_str());
            for key in ["authorList", "authors"] {
                if let Some(authors) = first[key].as_array() { for author in authors { out.author(text(author)); } }
                else if let Some(authors) = first[key].as_str() { for author in authors.split(',') { out.author(author); } }
            }
            for (key, kind) in [("requiredMods", "required"), ("dependencies", "optional")] {
                if let Some(deps) = first[key].as_array() { for dep in deps {
                    let (id, range) = text(dep).split_once('@').unwrap_or((text(dep), "")); out.dependency(id, kind, range);
                } }
            }
        }
        _ => return None,
    }
    Some(out)
}

/// TOML basic-string escapes, including \uXXXX and \UXXXXXXXX. In a multi-line
/// string a backslash at the end of a line also drops the newline and the
/// leading whitespace of the following lines.
fn toml_unescape(input: &str, multiline: bool) -> Option<String> {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' { out.push(ch); continue; }
        match chars.next()? {
            'b' => out.push('\u{8}'),
            't' => out.push('\t'),
            'n' => out.push('\n'),
            'f' => out.push('\u{c}'),
            'r' => out.push('\r'),
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            marker @ ('u' | 'U') => {
                let digits: String = (0..if marker == 'u' { 4 } else { 8 })
                    .map(|_| chars.next()).collect::<Option<_>>()?;
                out.push(char::from_u32(u32::from_str_radix(&digits, 16).ok()?)?);
            }
            next if multiline && next.is_whitespace() => {
                // Line-ending backslash: skip spaces, the newline and the indentation after it.
                let mut saw_newline = next == '\n';
                while let Some(&peek) = chars.peek() {
                    if !peek.is_whitespace() { break; }
                    saw_newline |= peek == '\n';
                    chars.next();
                }
                if !saw_newline { return None; }
            }
            _ => return None,
        }
    }
    Some(out)
}

// Read only the metadata fields we recognize. Leave unknown TOML values unused.
fn toml_string(input: &str) -> Option<(String, &str)> {
    let quote = *input.as_bytes().first()?;
    if !matches!(quote, b'\'' | b'"') { return None; }
    let mut escaped = false;
    for (i, byte) in input.bytes().enumerate().skip(1) {
        if !escaped && byte == quote {
            let value = if quote == b'"' { toml_unescape(&input[1..i], false)? }
                else { input[1..i].to_owned() };
            return Some((value, input[i + 1..].trim_start()));
        }
        escaped = quote == b'"' && byte == b'\\' && !escaped;
    }
    None
}

fn toml_scalar(input: &str) -> Option<Option<Value>> {
    let v = input.trim_start();
    let is_end = |tail: &str| tail.is_empty() || tail.starts_with('#');
    if v.starts_with(['"', '\'']) {
        let (value, tail) = toml_string(v)?;
        return is_end(tail).then(|| Some(value.into()));
    }
    if let Some(mut remaining) = v.strip_prefix('[') {
        let mut values = vec![];
        loop {
            let source = remaining.trim_start();
            if let Some(tail) = source.strip_prefix(']') {
                return is_end(tail.trim_start()).then_some(Some(Value::Array(values)));
            }
            // An array left open on its line is malformed, not merely unsupported.
            if source.is_empty() || source.starts_with('#') { return None; }
            if !source.starts_with(['"', '\'']) { return Some(None); }
            let (value, tail) = toml_string(source)?;
            values.push(value.into());
            if let Some(after) = tail.strip_prefix(',') { remaining = after; }
            else if tail.starts_with(']') { remaining = tail; }
            else { return None; }
        }
    }
    let token = v.split('#').next()?.trim();
    if token == "true" || token == "false" { Some(Some((token == "true").into())) }
    else if let Ok(n) = token.parse::<i64>() { Some(Some(n.into())) }
    else { Some(None) }
}

fn parse_toml(loader: &'static str, input: &str, jar_version: Option<&str>) -> Option<ModMetadata> {
    let mut global = Map::new();
    let mut mods: Vec<Map<String, Value>> = vec![];
    let mut deps: Vec<(String, Map<String, Value>)> = vec![];
    enum Section { Global, Mod(usize), Dependency(usize), Ignore }
    let mut section = Section::Global;
    let mut lines = input.lines();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if line.starts_with('[') {
            let heading = line.split('#').next()?.trim();
            section = if heading == "[[mods]]" {
                mods.push(Map::new()); Section::Mod(mods.len() - 1)
            } else if let Some(id) = heading.strip_prefix("[[dependencies.").and_then(|v| v.strip_suffix("]]")) {
                deps.push((id.to_owned(), Map::new())); Section::Dependency(deps.len() - 1)
            } else { Section::Ignore };
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else { continue; };
        let raw = raw.trim_start();
        let value = if let Some(marker) = ["\"\"\"", "'''"].into_iter().find(|m| raw.starts_with(m)) {
            let mut current = &raw[3..];
            let mut result = String::new();
            // Only the newline right after the opening delimiter is trimmed.
            let mut first = true;
            loop {
                if let Some((value, tail)) = current.split_once(marker) {
                    let tail = tail.trim();
                    if !tail.is_empty() && !tail.starts_with('#') { return None; }
                    result.push_str(value);
                    break;
                }
                if !(first && current.is_empty()) { result.push_str(current); result.push('\n'); }
                first = false;
                current = lines.next()?;
            }
            Some(if marker == "\"\"\"" { toml_unescape(&result, true)? } else { result }.into())
        } else { toml_scalar(raw)? };
        if let Some(value) = value {
            let map = match section {
                Section::Global => &mut global, Section::Mod(i) => &mut mods[i],
                Section::Dependency(i) => &mut deps[i].1, Section::Ignore => continue,
            };
            if map.insert(key.trim().to_owned(), value).is_some() { return None; }
        }
    }
    let first = mods.first()?;
    let get = |key| first.get(key).map(text).unwrap_or("");
    let version = get("version");
    let mut out = ModMetadata::new(loader, get("modId"), get("displayName"),
        if version == "${file.jarVersion}" { jar_version.unwrap_or(version) } else { version }, get("description"))?;
    out.additional_mods = mods.len() - 1;
    for author in get("authors").split(',') { out.author(author); }
    if let Some(authors) = first.get("authors").and_then(Value::as_array) { for author in authors { out.author(text(author)); } }
    out.set_icon(first.get("logoFile").or_else(|| global.get("logoFile")).and_then(Value::as_str));
    for (owner, dep) in deps {
        if owner.trim_matches(['\'', '"']) != get("modId") { continue; }
        let field = |key| dep.get(key).map(text).unwrap_or("");
        let kind = match field("type") { "incompatible" | "discouraged" => "incompatible", "optional" => "optional",
            _ if dep.get("mandatory").and_then(Value::as_bool) == Some(false) => "optional", _ => "required" };
        out.dependency(field("modId"), kind, field("versionRange"));
    }
    Some(out)
}

/// One attribute from the main section of a JAR manifest: names are
/// case-insensitive, continuation lines (leading space) are unfolded, and
/// per-entry sections after the first blank line are ignored.
fn main_manifest_attribute(manifest: &str, name: &str) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in manifest.lines() {
        if line.is_empty() { break; }
        match (line.strip_prefix(' '), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(line.to_owned()),
        }
    }
    lines.iter().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c6_toml_basic_strings_follow_toml_escapes() {
        let toml = concat!(
            "[[mods]]\n",
            "modId = \"fixture\"\n",
            "displayName = \"\\U0001F680 Tools\"\n",
            "description = \"\"\"\n",
            "\n",
            "Line one\\nLine two \\\n",
            "    joined\"\"\"\n",
        );
        let meta = parse_toml("forge", toml, None).expect("valid TOML");
        assert_eq!(meta.name, "\u{1F680} Tools");
        assert_eq!(meta.description, "\nLine one\nLine two joined");
        let literal = "[[mods]]\nmodId = 'fixture'\ndescription = '''\nkeep \\n literal'''\n";
        assert_eq!(parse_toml("forge", literal, None).unwrap().description, "keep \\n literal");
    }

    #[test]
    fn c6_an_unterminated_array_is_malformed() {
        assert!(parse_toml("forge", "[[mods]]\nmodId = \"fixture\"\nauthors = [\"Ana\",\n", None).is_none());
        assert!(parse_toml("forge", "[[mods]]\nmodId = \"fixture\"\nauthors = [\"Ana\", 3]\n", None).is_some());
    }

    #[test]
    fn c6_jar_version_comes_from_the_main_manifest_section() {
        let manifest = "Manifest-Version: 1.0\nimplementation-version: 2.0.\n 1-long\n\nName: inner/\nImplementation-Version: 9\n";
        assert_eq!(main_manifest_attribute(manifest, "Implementation-Version").as_deref(), Some("2.0.1-long"));
        assert_eq!(main_manifest_attribute("Manifest-Version: 1.0\n\nName: x\nImplementation-Version: 9\n", "Implementation-Version"), None);
    }
}

fn read_metadata(zip: &mut ZipArchive<File>) -> Option<ModMetadata> {
    for (file, loader) in [("fabric.mod.json", "fabric"), ("quilt.mod.json", "quilt"),
        ("META-INF/neoforge.mods.toml", "neoforge"), ("META-INF/mods.toml", "forge"), ("mcmod.info", "legacyForge")] {
        if zip.by_name(file).is_err() { continue; }
        let bytes = read_entry(zip, file, METADATA_LIMIT)?;
        let body = String::from_utf8_lossy(json_body(&bytes));
        if file.ends_with(".toml") {
            let manifest = read_entry(zip, "META-INF/MANIFEST.MF", 64 * 1024).unwrap_or_default();
            let manifest = String::from_utf8_lossy(&manifest);
            let version = main_manifest_attribute(&manifest, "Implementation-Version");
            return parse_toml(loader, &body, version.as_deref());
        }
        return parse_json(loader, &serde_json::from_str(&body).ok()?);
    }
    None
}

pub(crate) fn cached_metadata(path: &Path, stat: &fs::Metadata) -> Option<ModMetadata> {
    type Key = (PathBuf, u64, SystemTime);
    type Cache = Mutex<HashMap<Key, Option<Arc<ModMetadata>>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(modified) = stat.modified() else { return read_metadata(&mut open_jar(path)?); };
    let key = (path.to_owned(), stat.len(), modified);
    if let Some(hit) = cache.lock().ok()?.get(&key).cloned() { return hit.as_deref().cloned(); }
    // A failed open (for example a JAR a running game holds) is not cached:
    // releasing the lock changes neither size nor mtime, so Refresh must retry.
    let mut zip = open_jar(path)?;
    let value = read_metadata(&mut zip);
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= 4096 { guard.clear(); }
        guard.insert(key, value.clone().map(Arc::new));
    }
    value
}

/// The mod ID a JAR declares, read directly (never cached), for duplicate checks.
pub(crate) fn declared_mod_id(path: &Path) -> Option<String> {
    let mut zip = open_jar(path)?;
    read_metadata(&mut zip).map(|metadata| metadata.mod_id)
}

/// An enabled JAR in `directory`, other than `skip`, that declares `mod_id`.
pub(crate) fn enabled_jar_with_mod_id(directory: &Path, mod_id: &str, skip: &Path) -> Option<String> {
    enabled_jars_with_mod_id(directory, mod_id, skip).into_iter().next()
}

/// Every enabled jar in `directory` (other than `skip`) declaring `mod_id`,
/// by name. Disabled copies, links and jars without a readable ID are not listed.
pub(crate) fn enabled_jars_with_mod_id(directory: &Path, mod_id: &str, skip: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(directory) else { return Vec::new() };
    let skip_size = fs::metadata(skip).ok().map(|stat| stat.len());
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path == skip || !name.to_ascii_lowercase().ends_with(".jar") { continue; }
        let Ok(stat) = fs::symlink_metadata(&path) else { continue; };
        if !stat.is_file() || crate::resources::linked(&stat) { continue; }
        // The kept file under another spelling (case on Windows and macOS, or
        // another Unicode form) is still the kept file.
        if skip_size == Some(stat.len()) && same_file(&path, skip) { continue; }
        if cached_metadata(&path, &stat).is_some_and(|metadata| metadata.mod_id == mod_id) {
            names.push(name);
        }
    }
    names.sort();
    names
}

/// Whether two paths name the same file, as the file system decides (it alone
/// knows whether a folder ignores case). False when either cannot be read.
fn same_file(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((fs::metadata(left), fs::metadata(right)), (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino())
    }
    // Windows: the final path of an open handle is the name on disk.
    #[cfg(not(unix))]
    {
        matches!((fs::canonicalize(left), fs::canonicalize(right)), (Ok(a), Ok(b)) if a == b)
    }
}

pub(crate) fn read_icon(path: &Path) -> Option<String> {
    let mut zip = open_jar(path)?;
    let name = read_metadata(&mut zip)?.icon?;
    let bytes = read_entry(&mut zip, &name, ICON_LIMIT)?;
    png_preview_data(&bytes, 1024).ok()
}
