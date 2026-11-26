use std::path::Path;

const RAW_BUILTIN: Option<&str> = option_env!("VOXELIGHT_CF_API_KEY");
const PREFIX: &str = "$2a$10$";
pub(crate) const CURSEFORGE_SECRET_KEY: &str = "curseforge-api-key";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Explicit,
    Saved,
    Builtin,
}

pub(crate) fn builtin_cf_key() -> Option<&'static str> {
    normalize_builtin(RAW_BUILTIN)
}

fn normalize_builtin(raw: Option<&str>) -> Option<&str> {
    let value = raw?.trim();
    let body = value.strip_prefix(PREFIX)?.as_bytes();
    (body.len() == 53
        && body
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'/')))
    .then_some(value)
}

fn resolve_cf_key<'a>(
    explicit: Option<&'a str>,
    saved: Option<&'a str>,
    builtin: Option<&'a str>,
) -> Option<(&'a str, Source)> {
    [
        (explicit, Source::Explicit),
        (saved, Source::Saved),
        (builtin, Source::Builtin),
    ]
    .into_iter()
    .find_map(|(value, source)| {
        let value = value?.trim();
        (!value.is_empty()).then_some((value, source))
    })
}

pub(crate) fn effective_cf_key(
    data_dir: &Path,
    explicit: Option<&str>,
) -> Result<Option<String>, String> {
    effective_cf_key_with(data_dir, explicit, builtin_cf_key())
}

/// The built-in key is a parameter so tests can prove the fallback is wired.
fn effective_cf_key_with(
    data_dir: &Path,
    explicit: Option<&str>,
    builtin: Option<&str>,
) -> Result<Option<String>, String> {
    select_key(explicit, builtin, || {
        crate::secrets::load_service_secret(data_dir, CURSEFORGE_SECRET_KEY)
    })
}

pub(crate) fn sensitive_cf_header(key: &str) -> Result<reqwest::header::HeaderValue, String> {
    let mut value = reqwest::header::HeaderValue::from_str(key)
        .map_err(|_| "CurseForge API Key 格式无效".to_owned())?;
    // Never serialize the credential through request Debug or header diagnostics.
    value.set_sensitive(true);
    Ok(value)
}

fn select_key(
    explicit: Option<&str>,
    builtin: Option<&str>,
    load_saved: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    // An explicit import key does not require access to the credential store.
    let saved = if explicit.is_some_and(|key| !key.trim().is_empty()) {
        None
    } else {
        load_saved()?
    };
    let Some((key, source)) = resolve_cf_key(explicit, saved.as_deref(), builtin) else {
        return Ok(None);
    };
    if key.len() > 2048 || key.chars().any(char::is_control) {
        return Err(match source {
            Source::Saved => "加密保存的 CurseForge API Key 格式无效，请重新设置",
            _ => "CurseForge API Key 格式无效",
        }
        .into());
    }
    Ok(Some(key.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_cf_key() -> String {
        [PREFIX, &"a".repeat(53)].concat()
    }

    #[test]
    fn cf_key_resolution_is_explicit_then_saved_then_builtin_then_absent() {
        let builtin = synthetic_cf_key();
        let check = |explicit, saved, embedded, expected, expected_source| {
            let resolved = resolve_cf_key(explicit, saved, embedded);
            assert!(resolved.is_some_and(|(key, source)| key == expected && source == expected_source));
        };
        check(Some(" dialog-only "), Some("user"), Some(&builtin), "dialog-only", Source::Explicit);
        check(Some(" "), Some(" user "), Some(&builtin), "user", Source::Saved);
        check(None, None, Some(&builtin), &builtin, Source::Builtin);
        assert!(resolve_cf_key(None, Some(" "), None).is_none());
    }

    #[test]
    fn cf_key_normalization_requires_the_exact_builtin_shape() {
        let good = synthetic_cf_key();
        let padded = format!("  {good}  ");
        assert!(normalize_builtin(Some(&padded)) == Some(good.as_str()));
        for bad in [
            String::new(),
            ["$2x$10$", &"a".repeat(53)].concat(),
            [PREFIX, &"a".repeat(52)].concat(),
            [PREFIX, &"a".repeat(54)].concat(),
            [PREFIX, &"a".repeat(52), "!"].concat(),
        ] {
            assert!(normalize_builtin(Some(&bad)).is_none());
        }
        assert!(normalize_builtin(None).is_none());
    }

    #[test]
    fn cf_key_selection_does_not_read_saved_key_when_explicit_is_present() {
        let result = select_key(Some("  explicit-fixture "), None, || panic!("explicit key should skip access to saved state"));
        assert!(result.is_ok_and(|v| v.as_deref() == Some("explicit-fixture")));
        let result = select_key(None, Some("builtin-fixture"), || Ok(Some("saved\ninvalid".into())));
        assert!(result.is_err_and(|error| !error.contains("saved\ninvalid")));
    }

    #[test]
    fn c4_builtin_key_is_the_last_fallback_and_never_skips_a_saved_key() {
        let builtin = synthetic_cf_key();
        let picked = select_key(None, Some(&builtin), || Ok(None)).unwrap();
        assert_eq!(picked.as_deref(), Some(builtin.as_str()));
        let picked = select_key(None, Some(&builtin), || Ok(Some(" user-fixture ".into()))).unwrap();
        assert_eq!(picked.as_deref(), Some("user-fixture"));
        let picked = select_key(Some("   "), Some(&builtin), || Ok(Some("user-fixture".into()))).unwrap();
        assert_eq!(picked.as_deref(), Some("user-fixture"), "a blank explicit key must not skip the saved key");
        assert_eq!(select_key(None, None, || Ok(None)).unwrap(), None);
    }

    #[test]
    fn c4_effective_key_passes_the_builtin_through() {
        let fixture = crate::instances::StagingDirectory::create(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/cf-key-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let builtin = synthetic_cf_key();
        let picked = effective_cf_key_with(fixture.path(), None, Some(&builtin)).unwrap();
        assert_eq!(picked.as_deref(), Some(builtin.as_str()));
        assert_eq!(effective_cf_key_with(fixture.path(), None, None).unwrap(), None);
    }

    #[test]
    fn cf_header_debug_never_prints_the_key() {
        let key = synthetic_cf_key();
        let header = sensitive_cf_header(&key).expect("synthetic key is a valid header");
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains(&key));
        assert_eq!(sensitive_cf_header("fixture\ninvalid").unwrap_err(), "CurseForge API Key 格式无效");
    }

    #[test]
    fn builtin_cf_key_presence_matches_expectation() {
        match std::env::var("VOXELIGHT_EXPECT_CF_BUILTIN").as_deref() {
            Ok("1") => assert!(builtin_cf_key().is_some(), "expected a valid built-in CurseForge key"),
            Ok("0") => assert!(builtin_cf_key().is_none(), "expected a public build without a CurseForge key"),
            _ => {}
        }
    }
}
