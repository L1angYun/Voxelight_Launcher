use crate::{
    auth::{
        AuthService, AuthenticatedAccount, AuthlibLogin, DeviceLogin, DevicePoll, PlayerProfile,
    },
    client_id::{builtin_client_id, resolve_client_id},
    errors::{expected, AppResult},
    models::{Account, Config},
    storage::LauncherState,
};
use std::{path::Path, sync::Arc};
use tauri::State;
fn remember(state: &LauncherState, value: &AuthenticatedAccount) -> Result<(), String> {
    state.update(|data| {
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
    let result = auth.poll_microsoft(&session_id).await.map_err(expected)?;
    if let Some(account) = &result.account {
        remember(&state, account).map_err(expected)?;
    }
    Ok(result)
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
    let result = auth
        .login_authlib(&server, &username, &password, profile_id.as_deref())
        .await
        .map_err(expected)?;
    if let Some(account) = &result.account {
        remember(&state, account).map_err(expected)?;
    }
    Ok(result)
}
#[tauri::command]
pub async fn select_authlib_profile(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    session_id: String,
    profile_id: String,
) -> AppResult<AuthenticatedAccount> {
    let result = auth
        .select_authlib_profile(&session_id, &profile_id)
        .await
        .map_err(expected)?;
    remember(&state, &result).map_err(expected)?;
    Ok(result)
}
#[tauri::command]
pub async fn refresh_account(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<AuthenticatedAccount> {
    let account = auth.refresh_account(&account_id).await.map_err(expected)?;
    remember(&state, &account).map_err(expected)?;
    Ok(account)
}
#[tauri::command]
pub async fn get_player_profile(
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<PlayerProfile> {
    auth.get_profile(&account_id).await.map_err(expected)
}
#[tauri::command]
pub async fn upload_account_skin(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
    path: String,
    model: String,
) -> AppResult<PlayerProfile> {
    let path = Path::new(&path);
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
    let result = auth
        .upload_skin(&account_id, &bytes, &model)
        .await
        .map_err(expected)?;
    let account = auth.account_info(&account_id).await.map_err(expected)?;
    remember(&state, &account).map_err(expected)?;
    Ok(result)
}
#[tauri::command]
pub async fn reset_account_skin(
    state: State<'_, Arc<LauncherState>>,
    auth: State<'_, Arc<AuthService>>,
    account_id: String,
) -> AppResult<PlayerProfile> {
    let result = auth.reset_skin(&account_id).await.map_err(expected)?;
    let account = auth.account_info(&account_id).await.map_err(expected)?;
    remember(&state, &account).map_err(expected)?;
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
        "curseforge" => "curseforge-api-key",
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
) -> Result<serde_json::Value, String> {
    let curseforge = crate::secrets::load_service_secret(&state.data_dir, "curseforge-api-key")?
        .is_some_and(|secret| !secret.is_empty());
    Ok(service_status(
        curseforge,
        &state.snapshot()?.config,
        builtin_client_id(),
    ))
}

fn service_status(curseforge: bool, config: &Config, builtin: Option<&str>) -> serde_json::Value {
    let custom = !config.microsoft_client_id.trim().is_empty();
    serde_json::json!({
        "curseforgeConfigured": curseforge,
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
        let builtin = service_status(false, &config, Some(BUILTIN));
        assert_eq!(builtin["microsoftBuiltin"], true);
        assert_eq!(builtin["microsoftOverride"], false);
        assert_eq!(builtin["microsoftConfigured"], true);
        assert_eq!(builtin["curseforgeConfigured"], false);
        assert!(builtin
            .as_object()
            .unwrap()
            .values()
            .all(serde_json::Value::is_boolean));
        assert!(!serde_json::to_string(&builtin).unwrap().contains(BUILTIN));
        let absent = service_status(true, &config, None);
        assert_eq!(absent["microsoftBuiltin"], false);
        assert_eq!(absent["microsoftConfigured"], false);
        let custom = Config {
            microsoft_client_id: format!(" {USER} "),
            ..Config::default()
        };
        assert_eq!(effective_client_id(&custom, Some(BUILTIN)), USER);
        let status = service_status(false, &custom, Some(BUILTIN));
        assert_eq!(status["microsoftOverride"], true);
        assert!(!serde_json::to_string(&status).unwrap().contains(USER));
    }
}
