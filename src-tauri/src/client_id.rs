const RAW_BUILTIN: Option<&str> = option_env!("VOXELIGHT_MS_CLIENT_ID");

pub fn builtin_client_id() -> Option<&'static str> {
    normalize_builtin(RAW_BUILTIN)
}

fn normalize_builtin(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientIdSource {
    User,
    Builtin,
}

pub fn resolve_client_id<'a>(
    user: &'a str,
    builtin: Option<&'a str>,
) -> Option<(&'a str, ClientIdSource)> {
    let user = user.trim();
    if !user.is_empty() {
        Some((user, ClientIdSource::User))
    } else {
        builtin.map(|value| (value, ClientIdSource::Builtin))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BUILTIN: &str = "11111111-1111-1111-1111-111111111111";
    const USER: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn missing_ids_resolve_to_none() {
        assert_eq!(resolve_client_id("", None), None);
        assert_eq!(resolve_client_id("  ", None), None);
    }

    #[test]
    fn builtin_is_used_when_user_override_is_empty() {
        assert_eq!(
            resolve_client_id("", Some(BUILTIN)),
            Some((BUILTIN, ClientIdSource::Builtin))
        );
    }

    #[test]
    fn trimmed_user_override_wins_over_builtin() {
        assert_eq!(
            resolve_client_id(&format!(" {USER} "), Some(BUILTIN)),
            Some((USER, ClientIdSource::User))
        );
    }

    #[test]
    fn builtin_normalization_rejects_missing_empty_and_malformed_values() {
        assert_eq!(normalize_builtin(None), None);
        assert_eq!(normalize_builtin(Some("")), None);
        assert_eq!(normalize_builtin(Some("not-a-uuid")), None);
        assert_eq!(
            normalize_builtin(Some(&format!(" {BUILTIN} "))),
            Some(BUILTIN)
        );
    }

    #[test]
    fn builtin_presence_matches_expectation() {
        match std::env::var("VOXELIGHT_EXPECT_BUILTIN").as_deref() {
            Ok("1") => assert!(
                builtin_client_id().is_some(),
                "expected a built-in Microsoft client ID"
            ),
            Ok("0") => assert!(
                builtin_client_id().is_none(),
                "expected a public build without a Microsoft client ID"
            ),
            _ => {}
        }
    }
}
