use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedAccount {
    pub id: String,
    pub username: String,
    pub uuid: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub expires_at: Option<i64>,
    pub skin_url: Option<String>,
    pub skin_model: Option<String>,
    pub authlib_server: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    pub status: String,
    pub retry_after_seconds: u64,
    pub account: Option<AuthenticatedAccount>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct AuthlibProfile {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthlibLogin {
    pub status: String,
    pub session_id: Option<String>,
    pub profiles: Vec<AuthlibProfile>,
    pub account: Option<AuthenticatedAccount>,
}

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skins: Vec<ProfileSkin>,
    #[serde(default)]
    pub capes: Vec<ProfileCape>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ProfileSkin {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub variant: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ProfileCape {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub alias: Option<String>,
}

/// Internal only. Deliberately has neither Serialize nor Debug, so it cannot accidentally become an IPC DTO or log line.
pub struct GameCredentials {
    pub access_token: String,
    pub username: String,
    pub uuid: String,
    pub account_type: String,
    pub xuid: Option<String>,
    pub client_id: Option<String>,
    pub authlib_server: Option<String>,
    pub expires_at: i64,
}
