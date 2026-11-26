//! Release metadata: SemVer stable & pre-release versions, strict JSON and the
//! HSR-shaped release object (`tag_name`, `draft`, `prerelease`, `assets[{name,size,digest}]`).
use super::{installer_name_for, Channel, Source, MAX_INSTALLER_BYTES, MAX_METADATA_BYTES, MAX_NOTES_CHARS};
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::fmt;

pub(crate) type Version = (u64, u64, u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum PreReleaseStage {
    Alpha,
    Beta,
    Rc,
}

impl PreReleaseStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Alpha => "alpha",
            Self::Beta => "beta",
            Self::Rc => "rc",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        match value {
            "alpha" => Some(Self::Alpha),
            "beta" => Some(Self::Beta),
            "rc" => Some(Self::Rc),
            _ => None,
        }
    }
}

/// SemVer 2.0.0 release version: either a stable `MAJOR.MINOR.PATCH` or a
/// pre-release `MAJOR.MINOR.PATCH-(alpha|beta|rc).N` (`N >= 1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SemVer {
    pub(crate) major: u64,
    pub(crate) minor: u64,
    pub(crate) patch: u64,
    pub(crate) pre: Option<(PreReleaseStage, u64)>,
}

impl SemVer {
    pub(crate) const fn stable((major, minor, patch): Version) -> Self {
        Self { major, minor, patch, pre: None }
    }
    pub(crate) const fn base(self) -> Version {
        (self.major, self.minor, self.patch)
    }
    pub(crate) const fn is_prerelease(self) -> bool {
        self.pre.is_some()
    }
    pub(crate) fn display(self) -> String {
        match self.pre {
            None => format!("{}.{}.{}", self.major, self.minor, self.patch),
            Some((stage, num)) => format!("{}.{}.{}-{}.{num}", self.major, self.minor, self.patch, stage.as_str()),
        }
    }
}

impl From<Version> for SemVer {
    fn from(value: Version) -> Self {
        Self::stable(value)
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        self.base().cmp(&other.base()).then_with(|| match (self.pre, other.pre) {
            (None, None) => Ordering::Equal,
            // Per SemVer 2.0.0: stable release > any pre-release of the same core version.
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(&b),
        })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `v?MAJOR.MINOR.PATCH`, no leading zeros, at most 64 characters.
pub(crate) fn parse_version(text: &str) -> Option<Version> {
    if text.is_empty() || text.len() > 64 {
        return None;
    }
    let digits = text.strip_prefix('v').unwrap_or(text);
    parse_core_version(digits)
}

fn parse_core_version(digits: &str) -> Option<Version> {
    let mut parts = digits.split('.');
    let mut next = || -> Option<u64> {
        let part = parts.next()?;
        let valid = !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'));
        valid.then(|| part.parse().ok()).flatten()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

#[cfg(test)]
pub(crate) fn display_version((major, minor, patch): Version) -> String {
    format!("{major}.{minor}.{patch}")
}

/// `v?MAJOR.MINOR.PATCH` or `v?MAJOR.MINOR.PATCH-(alpha|beta|rc).N` (`N >= 1`),
/// no leading zeros, at most 64 characters.
pub(crate) fn parse_semver(text: &str) -> Option<SemVer> {
    if text.is_empty() || text.len() > 64 {
        return None;
    }
    let stripped = text.strip_prefix('v').unwrap_or(text);
    if let Some(stable) = parse_core_version(stripped) {
        return Some(SemVer::stable(stable));
    }
    let (base, pre) = stripped.split_once('-')?;
    let (major, minor, patch) = parse_core_version(base)?;
    let (stage, num) = pre.split_once('.')?;
    let stage = PreReleaseStage::parse(stage)?;
    let valid_num = !num.is_empty()
        && num.bytes().all(|byte| byte.is_ascii_digit())
        && !num.starts_with('0');
    let number = valid_num.then(|| num.parse::<u64>().ok()).flatten().filter(|n| *n >= 1)?;
    Some(SemVer { major, minor, patch, pre: Some((stage, number)) })
}

/// Parses the running launcher's own SemVer string (without leading `v`):
/// returns `(base_version, is_prerelease)`.
#[cfg(test)]
pub(crate) fn parse_running_version(text: &str) -> Option<(Version, bool)> {
    if text.starts_with('v') {
        return None;
    }
    let parsed = parse_semver(text)?;
    Some((parsed.base(), parsed.is_prerelease()))
}

const MAX_DEPTH: usize = 8;

/// JSON that rejects duplicate keys (serde_json keeps the last one) and
/// nesting deeper than eight levels.
pub(crate) fn strict_json(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("更新信息超过大小限制".into());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = Strict(0).deserialize(&mut deserializer).map_err(|_| "更新信息不是有效的 JSON".to_owned())?;
    deserializer.end().map_err(|_| "更新信息不是有效的 JSON".to_owned())?;
    Ok(value)
}

struct Strict(usize);

impl<'de> DeserializeSeed<'de> for Strict {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Strict {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("strict JSON")
    }
    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(value).map(Value::Number).ok_or_else(|| E::custom("number"))
    }
    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        if self.0 >= MAX_DEPTH {
            return Err(serde::de::Error::custom("depth"));
        }
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(Strict(self.0 + 1))? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        if self.0 >= MAX_DEPTH {
            return Err(serde::de::Error::custom("depth"));
        }
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(serde::de::Error::custom("duplicate key"));
            }
            let value = map.next_value_seed(Strict(self.0 + 1))?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Package {
    pub(crate) version: SemVer,
    pub(crate) tag: String,
    pub(crate) file_name: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    /// The source whose release page and files this package came from.
    pub(crate) source: Source,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Release {
    pub(crate) version: SemVer,
    pub(crate) tag: String,
    pub(crate) source: Source,
    pub(crate) notes: Option<String>,
    pub(crate) package: Option<Package>,
}

impl Release {
    pub(crate) fn release_url(&self) -> String {
        format!("{}/releases/tag/{}", self.source.root(), self.tag)
    }
}

fn invalid(message: &str) -> String {
    message.to_owned()
}

/// A stable release object. `expected_tag` binds the tag observed on the
/// redirect chain (or chosen from the mirror's list).
#[cfg(test)]
pub(crate) fn parse_release(value: &Value, source: Source, expected_tag: Option<&str>) -> Result<Release, String> {
    parse_release_for_channel(value, source, expected_tag, Channel::Stable)
}

/// A release object validated against the selected update channel.
/// Stable accepts only `prerelease: false` + 3-part SemVer tags;
/// Beta accepts both stable releases and `prerelease: true` + `-(alpha|beta|rc).N` tags.
pub(crate) fn parse_release_for_channel(
    value: &Value,
    source: Source,
    expected_tag: Option<&str>,
    channel: Channel,
) -> Result<Release, String> {
    let root = value.as_object().ok_or_else(|| invalid("更新信息不是发布对象"))?;
    if root.get("draft") != Some(&Value::Bool(false)) {
        return Err(invalid("更新信息不是正式发布版本"));
    }
    let is_prerelease = root
        .get("prerelease")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("更新信息不是正式发布版本"))?;
    if !channel.includes_prerelease() && is_prerelease {
        return Err(invalid("更新信息不是正式发布版本"));
    }
    let tag = root.get("tag_name").and_then(Value::as_str).ok_or_else(|| invalid("更新信息缺少版本标签"))?;
    let version = if channel.includes_prerelease() {
        parse_semver(tag).ok_or_else(|| invalid("发布标签不是有效的版本号"))?
    } else {
        parse_version(tag).map(SemVer::stable).ok_or_else(|| invalid("发布标签不是稳定版本号"))?
    };
    if is_prerelease != version.is_prerelease() {
        return Err(invalid("发布标签与预发布标记不一致"));
    }
    if expected_tag.is_some_and(|expected| expected != tag) {
        return Err(invalid("发布标签与跳转链不一致"));
    }
    let notes = root.get("body").and_then(Value::as_str).map(truncate_notes);
    let package = read_package(root, version, tag, source)?;
    Ok(Release { version, tag: tag.to_owned(), source, notes, package })
}

pub(crate) fn truncate_notes(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t')).take(MAX_NOTES_CHARS).collect()
}

fn read_package(root: &Map<String, Value>, version: SemVer, tag: &str, source: Source) -> Result<Option<Package>, String> {
    let Some(assets) = root.get("assets") else {
        return Ok(None);
    };
    let assets = assets.as_array().ok_or_else(|| invalid("发布附件列表无效"))?;
    let file_name = installer_name_for(version);
    let mut found = None;
    for asset in assets {
        let Some(asset) = asset.as_object() else { continue };
        if asset.get("name").and_then(Value::as_str) != Some(file_name.as_str()) {
            continue;
        }
        if found.is_some() {
            return Err(invalid("发布包含重复的安装包"));
        }
        let size = asset
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| (1..=MAX_INSTALLER_BYTES).contains(size))
            .ok_or_else(|| invalid("安装包大小无效"))?;
        let digest = asset.get("digest").and_then(Value::as_str).ok_or_else(|| invalid("安装包缺少 SHA-256"))?;
        let sha256 = digest
            .strip_prefix("sha256:")
            .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| invalid("安装包缺少有效的 SHA-256"))?
            .to_ascii_lowercase();
        found = Some(Package { version, tag: tag.to_owned(), file_name: file_name.clone(), size, sha256, source });
    }
    Ok(found)
}

/// Picks the highest eligible release from GitHub's `/releases` list for `channel`.
pub(crate) fn pick_github_release(value: &Value, channel: Channel) -> Result<Release, String> {
    let list = value.as_array().filter(|list| list.len() <= 100).ok_or_else(|| invalid("GitHub 发布列表无效"))?;
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<Release> = None;
    for item in list {
        let Some(obj) = item.as_object() else { continue };
        if obj.get("draft") != Some(&Value::Bool(false)) {
            continue;
        }
        let Some(is_prerelease) = obj.get("prerelease").and_then(Value::as_bool) else { continue };
        if !channel.includes_prerelease() && is_prerelease {
            continue;
        }
        let Some(tag) = obj.get("tag_name").and_then(Value::as_str) else { continue };
        let Some(version) = parse_semver(tag) else { continue };
        if is_prerelease != version.is_prerelease() {
            continue;
        }
        if !seen.insert(version) {
            return Err(invalid("发布列表有重复的发布版本"));
        }
        let parsed = parse_release_for_channel(item, Source::GitHub, Some(tag), channel)?;
        if best.as_ref().is_none_or(|current| parsed.version > current.version) {
            best = Some(parsed);
        }
    }
    best.ok_or_else(|| invalid("没有找到可用的发布版本"))
}

/// The mirror's release list: the highest stable release that carries exactly
/// one update.json. Ambiguous versions or manifests are errors.
#[cfg(test)]
pub(crate) fn pick_gitee_release(value: &Value) -> Result<(String, Option<String>), String> {
    pick_gitee_release_for_channel(value, Channel::Stable)
}

/// The mirror's release list filtered by `channel` (`Stable` or `Beta`).
pub(crate) fn pick_gitee_release_for_channel(
    value: &Value,
    channel: Channel,
) -> Result<(String, Option<String>), String> {
    let list = value.as_array().filter(|list| list.len() <= 100).ok_or_else(|| invalid("镜像发布列表无效"))?;
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<(SemVer, String, Option<String>)> = None;
    for release in list {
        let Some(release) = release.as_object() else { continue };
        let Some(is_prerelease) = release.get("prerelease").and_then(Value::as_bool) else { continue };
        if !channel.includes_prerelease() && is_prerelease {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(Value::as_str) else { continue };
        let Some(version) = (if channel.includes_prerelease() {
            parse_semver(tag)
        } else {
            parse_version(tag).map(SemVer::stable)
        }) else {
            continue;
        };
        if is_prerelease != version.is_prerelease() {
            continue;
        }
        let Some(assets) = release.get("assets").and_then(Value::as_array) else { continue };
        if !seen.insert(version) {
            return Err(invalid("镜像有重复的发布版本"));
        }
        let manifests = assets
            .iter()
            .filter(|asset| asset.get("name").and_then(Value::as_str) == Some("update.json"))
            .count();
        if manifests > 1 {
            return Err(invalid("镜像发布包含重复的更新信息"));
        }
        if manifests == 1 && best.as_ref().is_none_or(|(current, ..)| version > *current) {
            let notes = release.get("body").and_then(Value::as_str).map(truncate_notes);
            best = Some((version, tag.to_owned(), notes));
        }
    }
    best.map(|(_, tag, notes)| (tag, notes)).ok_or_else(|| {
        invalid(if channel.includes_prerelease() {
            "镜像没有完整的发布版本"
        } else {
            "镜像没有完整的正式发布"
        })
    })
}
