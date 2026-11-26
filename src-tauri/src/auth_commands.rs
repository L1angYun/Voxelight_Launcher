use base64::Engine as _;
use crate::path_grants::{PathGrants, PathUse};
use crate::{
    auth::{
        AuthService, AuthenticatedAccount, AuthlibLogin, DeviceLogin, DevicePoll, PlayerProfile,
    },
    client_id::{builtin_client_id, resolve_client_id},
    errors::{expected, AppResult},
    models::{Account, Config},
    storage::LauncherState,
};
use std::sync::Arc;
use tauri::State;
pub(crate) fn remember(state: &LauncherState, value: &AuthenticatedAccount) -> Result<(), String> {
    state.update(|data| {
        data.pending_credential_removals.remove(&value.id);
        let previous = data.accounts.iter().position(|account| {
            account.id == value.id
                || account.uuid == value.uuid
                    && account.account_type == value.account_type
                    && account.authlib_server == value.authlib_server
        });
        let selected = previous
            .and_then(|i| data.accounts.get(i))
            .is_some_and(|a| a.is_selected)
            || data.accounts.is_empty();
        let account = Account {
            id: value.id.clone(),
            username: value.username.clone(),
            uuid: value.uuid.clone(),
            account_type: value.account_type.clone(),
            is_selected: selected,
            expires_at: value.expires_at,
            skin_url: value.skin_url.clone(),
            skin_model: value.skin_model.clone(),
            authlib_server: value.authlib_server.clone(),
        };
        if let Some(i) = previous {
            data.accounts[i] = account;
        } else {
            for account in &mut data.accounts {
                account.is_selected = false;
            }
            let mut account = account;
            account.is_selected = true;
            data.accounts.push(account);
        }
        Ok(())
    })
}

fn remember_existing(state: &LauncherState, value: &AuthenticatedAccount) -> Result<(), String> {
    state.update(|data| {
        let account = data
            .accounts
            .iter_mut()
            .find(|account| {
                account.id == value.id
                    && account.uuid == value.uuid
                    && account.account_type == value.account_type
                    && account.authlib_server == value.authlib_server
            })
            .ok_or(crate::errors::ACCOUNT_SESSION_CHANGED)?;
        account.username = value.username.clone();
        account.expires_at = value.expires_at;
        account.skin_model.clone_from(&value.skin_model);
        account.skin_url.clone_from(&value.skin_url);
        Ok(())
    })
}
#[tauri::command]
pub async fn begin_microsoft_login(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
) -> AppResult<DeviceLogin> {
    begin_microsoft_login_inner(state.inner(), auth.inner(), builtin_client_id()).await
}

pub(crate) async fn begin_microsoft_login_inner(
    state: &LauncherState,
    auth: &AuthService,
    builtin: Option<&str>,
) -> AppResult<DeviceLogin> {
    let config = state.snapshot().map_err(expected)?.config;
    let client_id = effective_client_id(&config, builtin);
    auth.begin_microsoft(&client_id).await.map_err(expected)
}

pub(crate) fn effective_client_id(config: &Config, builtin: Option<&str>) -> String {
    resolve_client_id(&config.microsoft_client_id, builtin)
        .map(|(value, _)| value.to_owned())
        .unwrap_or_default()
}
#[tauri::command]
pub async fn poll_microsoft_login(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    session_id: String,
) -> AppResult<DevicePoll> {
    poll_microsoft_login_inner(&state, &auth, &session_id)
        .await
        .map_err(expected)
}

pub(crate) async fn poll_microsoft_login_inner(
    state: &LauncherState,
    auth: &AuthService,
    session_id: &str,
) -> Result<DevicePoll, String> {
    auth.poll_microsoft_with_commit(session_id, |account| remember(state, account))
        .await
}
#[tauri::command]
pub fn cancel_auth_login(auth: State<'_, Arc<AuthService>>, session_id: String) -> AppResult<()> {
    auth.cancel_login(&session_id).map_err(expected)
}
#[tauri::command]
pub async fn login_authlib(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    server: String,
    username: String,
    password: String,
    profile_id: Option<String>,
) -> AppResult<AuthlibLogin> {
    auth.login_authlib_with_commit(
        &server,
        &username,
        &password,
        profile_id.as_deref(),
        |account| remember(&state, account),
    )
    .await
    .map_err(expected)
}
#[tauri::command]
pub async fn select_authlib_profile(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    session_id: String,
    profile_id: String,
) -> AppResult<AuthenticatedAccount> {
    auth.select_authlib_profile_with_commit(&session_id, &profile_id, |account| {
        remember(&state, account)
    })
    .await
    .map_err(expected)
}
#[tauri::command]
pub async fn refresh_account(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<AuthenticatedAccount> {
    refresh_account_inner(&state, &auth, &account_id)
        .await
        .map_err(expected)
}

pub(crate) async fn refresh_account_inner(
    state: &LauncherState,
    auth: &AuthService,
    account_id: &str,
) -> Result<AuthenticatedAccount, String> {
    let generation = auth.account_generation(account_id)?;
    let account = auth
        .refresh_account_with_generation(account_id, Some(&generation))
        .await?;
    auth.update_current_account(account_id, &generation, || {
        remember_existing(state, &account)
    })?;
    Ok(account)
}
#[tauri::command]
pub async fn get_player_profile(
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<PlayerProfile> {
    auth.get_profile(&account_id).await.map_err(expected)
}
fn encode_skin_preview_file(path: &std::path::Path) -> AppResult<String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    let metadata = std::fs::metadata(path).map_err(|e| expected(e.to_string()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 16 * 1024 * 1024 {
        return Err(crate::errors::AppError::new("preview.fileInvalid"));
    }
    let bytes = std::fs::read(path).map_err(|e| expected(e.to_string()))?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(crate::errors::AppError::new("preview.fileInvalid"));
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn read_skin_preview(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    path: String,
) -> AppResult<String> {
    let resolved = grants.peek(PathUse::Skin, &path, &window)?;
    tokio::task::spawn_blocking(move || encode_skin_preview_file(&resolved))
        .await
        .map_err(|e| expected(e.to_string()))?
}

#[tauri::command]
pub async fn upload_account_skin(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
    path: String,
    model: String,
) -> AppResult<PlayerProfile> {
    let path = grants.consume(PathUse::Skin, &path, &window)?;
    let path = path.as_path();
    if !path.is_absolute()
        || path
            .extension()
            .is_none_or(|e| !e.eq_ignore_ascii_case("png"))
    {
        return Err(expected("请选择本地绝对路径的 PNG 皮肤文件"));
    }
    let metadata = std::fs::metadata(path).map_err(|e| expected(e.to_string()))?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(expected("皮肤文件须为不超过 1 MB 的 PNG"));
    }
    let bytes = std::fs::read(path).map_err(|e| expected(e.to_string()))?;
    let generation = auth.account_generation(&account_id).map_err(expected)?;
    let result = auth
        .upload_skin(&account_id, &bytes, &model)
        .await
        .map_err(expected)?;
    let account = auth.account_info(&account_id).await.map_err(expected)?;
    auth.update_current_account(&account_id, &generation, || {
        remember_existing(&state, &account)
    })
    .map_err(expected)?;
    Ok(result)
}
#[tauri::command]
pub async fn reset_account_skin(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<PlayerProfile> {
    let generation = auth.account_generation(&account_id).map_err(expected)?;
    let result = auth.reset_skin(&account_id).await.map_err(expected)?;
    let account = auth.account_info(&account_id).await.map_err(expected)?;
    auth.update_current_account(&account_id, &generation, || {
        remember_existing(&state, &account)
    })
    .map_err(expected)?;
    Ok(result)
}
#[tauri::command]
pub async fn select_account_cape(
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
    cape_id: Option<String>,
) -> AppResult<PlayerProfile> {
    auth.select_cape(&account_id, cape_id.as_deref())
        .await
        .map_err(expected)
}
#[tauri::command]
pub fn set_service_secret(
    state: State<'_, Arc<LauncherState>>,
    service: String,
    secret: String,
) -> Result<bool, String> {
    let key = match service.as_str() {
        "curseforge" => crate::curseforge_key::CURSEFORGE_SECRET_KEY,
        _ => return Err("不支持的服务配置".into()),
    };
    if secret.len() > 4096 || secret.contains(['\0', '\r', '\n']) {
        return Err("密钥内容无效".into());
    }
    crate::secrets::save_service_secret(&state.data_dir, key, secret.trim())?;
    Ok(!secret.trim().is_empty())
}
#[tauri::command]
pub fn get_service_status(
    state: State<'_, Arc<LauncherState>>,
) -> AppResult<serde_json::Value> {
    service_status_for(&state)
}

pub(crate) fn service_status_for(state: &LauncherState) -> AppResult<serde_json::Value> {
    let curseforge =
        crate::secrets::load_service_secret(&state.data_dir, crate::curseforge_key::CURSEFORGE_SECRET_KEY)?
            .is_some_and(|secret| !secret.is_empty());
    let config = state.snapshot()?.config;
    let mut status = service_status(curseforge, crate::curseforge_key::builtin_cf_key(), &config, builtin_client_id());
    match crate::network::proxy_credentials_configured(&state.data_dir, &config) {
        Ok(configured) => status["proxyCredentialsConfigured"] = serde_json::json!(configured),
        Err(_) => status["proxyCredentialsUnreadable"] = serde_json::json!(true),
    }
    Ok(status)
}

fn service_status(
    curseforge: bool,
    curseforge_builtin: Option<&str>,
    config: &Config,
    builtin: Option<&str>,
) -> serde_json::Value {
    let custom = !config.microsoft_client_id.trim().is_empty();
    serde_json::json!({
        "curseforgeConfigured": curseforge,
        "curseforgeBuiltin": curseforge_builtin.is_some(),
        "microsoftBuiltin": builtin.is_some(),
        "microsoftOverride": custom,
        "microsoftConfigured": builtin.is_some() || custom,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Config;
    const BUILTIN: &str = "11111111-1111-1111-1111-111111111111";
    const USER: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn service_status_exposes_boolean_builtin_and_override_state_only() {
        let config = Config::default();
        // Built at runtime so no key-shaped literal reaches the public source.
        let cf_builtin = ["$", "2a", "$", "10", "$", &"a".repeat(53)].concat();
        let builtin = service_status(false, Some(&cf_builtin), &config, Some(BUILTIN));
        assert_eq!(builtin["microsoftBuiltin"], true);
        assert_eq!(builtin["microsoftOverride"], false);
        assert_eq!(builtin["microsoftConfigured"], true);
        assert_eq!(builtin["curseforgeConfigured"], false);
        assert_eq!(builtin["curseforgeBuiltin"], true);
        assert!(!serde_json::to_string(&builtin).unwrap().contains(&cf_builtin));
        assert!(builtin
            .as_object()
            .unwrap()
            .values()
            .all(serde_json::Value::is_boolean));
        assert!(!serde_json::to_string(&builtin).unwrap().contains(BUILTIN));
        let absent = service_status(true, None, &config, None);
        assert_eq!(absent["microsoftBuiltin"], false);
        assert_eq!(absent["curseforgeBuiltin"], false);
        assert_eq!(absent["microsoftConfigured"], false);
        let custom = Config {
            microsoft_client_id: format!(" {USER} "),
            ..Config::default()
        };
        assert_eq!(effective_client_id(&custom, Some(BUILTIN)), USER);
        let status = service_status(false, None, &custom, Some(BUILTIN));
        assert_eq!(status["microsoftOverride"], true);
        assert!(!serde_json::to_string(&status).unwrap().contains(USER));
    }

    #[test]
    fn u3_skin_preview_validates_png_signature_and_encodes_data_url() {
        let root = crate::instances::StagingDirectory::create(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let valid = root.path().join("valid.png");
        let invalid = root.path().join("fake.png");
        let empty = root.path().join("empty.png");
        std::fs::write(&valid, b"\x89PNG\r\n\x1a\npayload").unwrap();
        std::fs::write(&invalid, b"not a png").unwrap();
        std::fs::write(&empty, b"").unwrap();
        let url = encode_skin_preview_file(&valid).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert_eq!(encode_skin_preview_file(&invalid).unwrap_err().code, "preview.fileInvalid");
        assert_eq!(encode_skin_preview_file(&empty).unwrap_err().code, "preview.fileInvalid");
    }
}
