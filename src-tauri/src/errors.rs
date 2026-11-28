use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub params: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new("internal.unexpected").with_detail(detail)
    }
}

pub type AppResult<T> = Result<T, AppError>;
pub(crate) const STORAGE_STATE_CHANGED: &str = "数据文件已被其他程序修改，为保留最新数据未保存。";
pub(crate) const RESOURCE_RECOVERY_RUNNING: &str = "resource.recoveryRunning";
pub(crate) const RESOURCE_RECOVERY_CONFLICT: &str = "resource.recoveryConflict";
pub(crate) const RESOURCE_RECOVERY_INCOMPLETE: &str = "resource.recoveryIncomplete";
pub(crate) const RESOURCE_RECOVERY_NOT_NEEDED: &str = "resource.recoveryNotNeeded";
pub(crate) const RESOURCE_RECOVERY_REQUIRED: &str = "存在未完成的资源事务，请先在更新历史中恢复。";
/// Followed by the human-readable name of the enabled incompatible project.
pub(crate) const RESOURCE_DEPENDENCY_INCOMPATIBLE_PREFIX: &str = "已启用不兼容的项目：";
/// Followed by the reason (too many projects or too deep).
pub(crate) const RESOURCE_DEPENDENCY_LIMIT_PREFIX: &str = "必需前置依赖图超出安全上限：";
/// Followed by the project name involved in the required-dependency cycle.
pub(crate) const RESOURCE_DEPENDENCY_CYCLE_PREFIX: &str = "必需前置存在循环依赖：";
/// Followed by `<project name>\t<reason>` when a required dependency has no
/// usable compatible file or fails validation.
pub(crate) const RESOURCE_DEPENDENCY_UNAVAILABLE_PREFIX: &str = "必需前置不可用：";
/// Followed by the conflict description (two required versions or colliding filenames).
pub(crate) const RESOURCE_DEPENDENCY_CONFLICT_PREFIX: &str = "必需前置冲突：";
pub(crate) const RESTORE_PENDING: &str = "此实例有未完成的备份恢复或整合包更新，请先在实例备份中恢复，再启动或修改实例。";
pub(crate) const INSTALL_GAME_RUNNING: &str = "同一游戏目录中有游戏正在运行。请先退出游戏，再安装版本或加载器。";
/// Factory-reset refusals. These deliberately do not reuse the launcher-update
/// texts: the user is restoring the launcher, not installing an update.
pub(crate) const RESET_GAME_RUNNING: &str = "有游戏正在运行，请先退出游戏后再还原初始状态。";
pub(crate) const RESET_SERVER_RUNNING: &str = "有托管服务端正在运行，请先停止服务端后再还原初始状态。";
pub(crate) const RESET_DOWNLOADS_ACTIVE: &str =
    "有下载任务正在运行、排队或已暂停，请先完成或取消这些任务后再还原初始状态。";
/// A saved key, proxy credential or other non-account secret could not be
/// erased, so the reset stopped before it changed any state. The detail after
/// the colon names the failing operation.
pub(crate) const RESET_SECRETS_LOCKED: &str = "无法删除已保存的密钥，启动器未被还原";
/// The reset committed its new state, but an account token could not be erased
/// yet. Its id stays queued, so the next start finishes the deletion.
pub(crate) const RESET_CREDENTIALS_PENDING: &str = "还原初始状态时未能删除全部加密凭据";

pub(crate) const LOADER_REINSTALL_PREFIX: &str = "加载器版本元数据损坏，需重新安装：";
pub(crate) const LOADER_ARTIFACT_MISSING_PREFIX: &str = "缺少安装器后处理生成的文件：";
pub(crate) const GAME_FOLDER_NOT_FOUND: &str = "gameFolder.notFound";
pub(crate) const GAME_FOLDER_UNSUPPORTED: &str = "gameFolder.unsupported";
pub(crate) const GAME_FOLDER_UNAVAILABLE_PREFIX: &str = "gameFolder.unavailable:";
/// Reason codes of `gameFolder.unavailable`; the interface translates them.
pub(crate) const GAME_FOLDER_INVALID_PATH: &str = "invalidPath";
pub(crate) const GAME_FOLDER_OPEN_FAILED: &str = "openFailed";
pub(crate) const GAME_FOLDER_NESTED: &str = "gameFolder.nested";
pub(crate) const GAME_FOLDER_DATA_DIRECTORY: &str = "gameFolder.dataDirectory";
pub(crate) const INSTANCE_SHARED_ROOT: &str = "instance.sharedRootRequired";
pub(crate) const INSTANCE_DELETE_CONFIRM_REQUIRED: &str = "instance.deleteConfirmRequired";
/// Followed by the names of the instances that inherit from the folder, one
/// per line. Deleting the folder would stop every one of them from launching.
pub(crate) const INSTANCE_DELETE_DEPENDANTS_PREFIX: &str = "instance.deleteDependants:";
pub(crate) const INSTANCE_OFFICIAL_NAME: &str = "instance.officialVersionName";
/// A loader switch would rewrite a version profile that is not the instance's
/// own: an official version, a complete standalone profile, or a folder other
/// instances inherit from.
pub(crate) const INSTANCE_LOADER_SWITCH_SHARED: &str = "instance.loaderSwitchShared";
/// A loader switch would rewrite the version folder a loader installer created
/// (for example `fabric-loader-0.16.9-1.21.1`), which the next install of that
/// loader overwrites again. A copy of the instance can be switched.
pub(crate) const INSTANCE_LOADER_SWITCH_INSTALLER_FOLDER: &str = "instance.loaderSwitchInstallerFolder";
/// The selected backup was made of another kind of instance (for example the
/// managed instance before its conversion), so it cannot be restored in place.
pub(crate) const BACKUP_KIND_MISMATCH: &str = "backup.kindMismatch";
/// Followed by the operating-system failure when the folder could not be moved
/// to the Recycle Bin. The files were not deleted.
pub(crate) const INSTANCE_RECYCLE_FAILED_PREFIX: &str = "instance.recycleFailed:";
/// Followed by the reason this path's volume cannot use the Recycle Bin. The
/// interface offers the separately confirmed permanent delete instead.
pub(crate) const INSTANCE_RECYCLE_UNAVAILABLE_PREFIX: &str = "instance.recycleUnavailable:";
/// Followed by the stable reason code of an unlaunchable version folder.
pub(crate) const INSTANCE_LAUNCH_BLOCKED_PREFIX: &str = "instance.launchBlocked:";
pub(crate) const INSTANCE_FOLDER_UNSAFE: &str = "instance.folderUnsafe";
pub(crate) const INSTANCE_FOLDER_NAME_INVALID: &str = "instance.folderNameInvalid";
pub(crate) const INSTANCE_FOLDER_NAME_TAKEN: &str = "instance.folderNameTaken";
pub(crate) const INSTANCE_CREATE_UNSUPPORTED_LOADER: &str = "instance.createUnsupportedLoader";
pub(crate) const INSTANCE_CONVERT_UNSUPPORTED: &str = "instance.convertUnsupported";
pub(crate) const INSTANCE_CONVERT_NOT_NEEDED: &str = "instance.convertNotNeeded";
pub(crate) const INSTANCE_CONVERSION_NOT_PENDING: &str = "instance.conversionNotPending";
pub(crate) const INSTANCE_ISOLATION_UNSUPPORTED: &str = "instance.isolationUnsupported";
pub(crate) const INSTANCE_ISOLATION_COPY_ONLY: &str = "instance.isolationCopyOnly";
pub(crate) const PROFILE_CONFLICT_PREFIX: &str = "版本配置的来源无法确认，原文件已保留：";
pub(crate) const PROFILE_OFFLINE_UNVERIFIED_PREFIX: &str =
    "离线状态下无法校验现有版本配置，请联网一次后再启动：";
pub(crate) const ACCOUNT_SESSION_CHANGED: &str = "账号会话已更换或移除，请重新选择账号";
pub(crate) const CREDENTIAL_CLEANUP_PENDING: &str = "账号已从资料中移除，但加密凭据清理待重试";
pub(crate) const CREDENTIAL_RECOVERY_FAILED: &str = "无法恢复账号原有的加密凭据，请重新登录";

impl From<String> for AppError {
    fn from(detail: String) -> Self {
        expected(detail)
    }
}

impl From<&str> for AppError {
    fn from(detail: &str) -> Self {
        expected(detail)
    }
}

pub fn expected(detail: impl Into<String>) -> AppError {
    let detail = detail.into();
    if crate::network::Error::is_code(&detail) {
        return AppError::new(detail);
    }
    if matches!(
        detail.as_str(),
        GAME_FOLDER_NOT_FOUND
            | GAME_FOLDER_UNSUPPORTED
            | GAME_FOLDER_NESTED
            | GAME_FOLDER_DATA_DIRECTORY
            | INSTANCE_SHARED_ROOT
            | INSTANCE_DELETE_CONFIRM_REQUIRED
            | INSTANCE_OFFICIAL_NAME
            | INSTANCE_LOADER_SWITCH_SHARED
            | INSTANCE_LOADER_SWITCH_INSTALLER_FOLDER
            | INSTANCE_FOLDER_UNSAFE
            | INSTANCE_FOLDER_NAME_INVALID
            | INSTANCE_FOLDER_NAME_TAKEN
            | INSTANCE_CREATE_UNSUPPORTED_LOADER
            | INSTANCE_CONVERT_UNSUPPORTED
            | INSTANCE_CONVERT_NOT_NEEDED
            | INSTANCE_CONVERSION_NOT_PENDING
            | INSTANCE_ISOLATION_UNSUPPORTED
            | INSTANCE_ISOLATION_COPY_ONLY
    ) {
        return AppError::new(detail);
    }
    if let Some(names) = detail.strip_prefix(INSTANCE_DELETE_DEPENDANTS_PREFIX) {
        let names: Vec<&str> = names.lines().filter(|name| !name.trim().is_empty()).collect();
        return AppError::new("instance.deleteDependants")
            .with_param("instances", names.join("、"))
            .with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(INSTANCE_LAUNCH_BLOCKED_PREFIX) {
        return AppError::new("instance.launchBlocked")
            .with_param("reason", reason.trim())
            .with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(INSTANCE_RECYCLE_UNAVAILABLE_PREFIX) {
        return AppError::new("instance.recycleUnavailable")
            .with_param("reason", reason.trim())
            .with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(INSTANCE_RECYCLE_FAILED_PREFIX) {
        // `<reason code>[:<system error code>]`; the interface translates the
        // reason and shows the system code as it is.
        let (reason, code) = reason
            .trim()
            .split_once(':')
            .map_or((reason.trim(), None), |(reason, code)| (reason, Some(code)));
        let mut error = AppError::new("instance.recycleFailed").with_param("reason", reason);
        if let Some(code) = code {
            error = error.with_param("code", code);
        }
        return error.with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(GAME_FOLDER_UNAVAILABLE_PREFIX) {
        return AppError::new("gameFolder.unavailable")
            .with_param("reason", reason.trim())
            .with_detail(detail);
    }
    if let Some(id) = detail.strip_prefix(LOADER_REINSTALL_PREFIX) {
        return AppError::new("version.loaderReinstall")
            .with_param("id", id)
            .with_detail(detail);
    }
    if let Some(id) = detail.strip_prefix(PROFILE_CONFLICT_PREFIX) {
        return AppError::new("version.profileConflict")
            .with_param("id", id.lines().next().unwrap_or_default())
            .with_detail(detail);
    }
    if let Some(id) = detail.strip_prefix(PROFILE_OFFLINE_UNVERIFIED_PREFIX) {
        return AppError::new("version.offlineUnverified")
            .with_param("id", id.lines().next().unwrap_or_default())
            .with_detail(detail);
    }
    if detail.starts_with(LOADER_ARTIFACT_MISSING_PREFIX) {
        return AppError::new("version.loaderArtifactMissing").with_detail(detail);
    }
    if let Some(key) = detail.strip_prefix(crate::server_manager::import::IMPORT_PROPERTIES) {
        return AppError::new("server.importProperties")
            .with_param("key", key)
            .with_detail(detail);
    }
    if let Some(files) = detail.strip_prefix(crate::modpacks::MANUAL_DOWNLOAD) {
        return AppError::new("modpack.manualDownload")
            .with_param("files", files)
            .with_detail(detail);
    }
    if let Some(rest) = detail.strip_prefix(crate::curseforge::MANUAL_DOWNLOAD) {
        let file_id = rest.split_once('\n').map_or(rest, |(id, _)| id);
        return AppError::new("resource.manualDownload")
            .with_param("fileId", file_id)
            .with_detail(detail);
    }
    if let Some(project) = detail.strip_prefix(RESOURCE_DEPENDENCY_INCOMPATIBLE_PREFIX) {
        return AppError::new("resource.dependencyIncompatible")
            .with_param("project", project)
            .with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(RESOURCE_DEPENDENCY_LIMIT_PREFIX) {
        return AppError::new("resource.dependencyLimit")
            .with_param("reason", reason)
            .with_detail(detail);
    }
    if let Some(project) = detail.strip_prefix(RESOURCE_DEPENDENCY_CYCLE_PREFIX) {
        return AppError::new("resource.dependencyCycle")
            .with_param("project", project)
            .with_detail(detail);
    }
    if let Some(rest) = detail.strip_prefix(RESOURCE_DEPENDENCY_UNAVAILABLE_PREFIX) {
        let name = rest.split_once('\t').map_or(rest, |(name, _)| name);
        return AppError::new("resource.dependencyUnavailable")
            .with_param("name", name)
            .with_detail(detail);
    }
    if detail.starts_with(RESOURCE_DEPENDENCY_CONFLICT_PREFIX) {
        return AppError::new("resource.dependencyConflict").with_detail(detail);
    }
    if let Some(rest) = detail.strip_prefix(crate::curseforge::DEPENDENCY_INSTALL_FIRST) {
        let encoded = rest.rsplit_once('\t').map_or(rest, |(_, encoded)| encoded);
        let value: Value = serde_json::from_str(encoded).unwrap_or(Value::Null);
        let mut error = AppError::new("resource.dependencyInstallFirst")
            .with_param("name", value["name"].as_str().unwrap_or_default());
        if let Some(folder) = value["folder"].as_str().filter(|folder| !folder.is_empty()) {
            error = error.with_param("folder", folder);
        }
        return error.with_detail(detail);
    }
    if let Some(rest) = detail.strip_prefix(crate::curseforge::DEPENDENCY_MANUAL_DOWNLOAD) {
        let encoded = rest.rsplit_once('\t').map_or(rest, |(_, encoded)| encoded);
        let value: Value = serde_json::from_str(encoded).unwrap_or(Value::Null);
        return AppError::new("resource.dependencyManualDownload")
            .with_param("name", value["name"].as_str().unwrap_or_default())
            .with_param("url", value["url"].as_str().unwrap_or_default())
            .with_param("file", value["file"].as_str().unwrap_or_default())
            .with_param("folder", value["folder"].as_str().unwrap_or("mods"))
            .with_detail(detail);
    }
    if let Some(port) = crate::assistant::mcp::unavailable_port(&detail) {
        return AppError::new("assistant.mcpPortUnavailable")
            .with_param("port", port)
            .with_detail(detail);
    }
    if let Some(reason) = detail.strip_prefix(crate::instances::LOADER_BACKUP_FAILED_PREFIX) {
        return loader_backup_failure(reason).with_detail(detail);
    }
    for invalid in [
        crate::loaders::OPTIFINE_READ_FAILED,
        crate::loaders::OPTIFINE_SIZE_INVALID,
        crate::loaders::OPTIFINE_NAME_INVALID,
        crate::loaders::OPTIFINE_OPEN_FAILED,
        crate::loaders::OPTIFINE_NOT_JAR,
        crate::loaders::OPTIFINE_INVALID,
        crate::loaders::OPTIFINE_FILENAME_INVALID,
        crate::loaders::OPTIFINE_CHANGED,
    ] {
        if detail.starts_with(invalid) {
            return AppError::new("loader.optifineInvalid").with_detail(detail);
        }
    }
    if detail.starts_with("所选 JAR 不是有效的 OptiFine 安装器") {
        return AppError::new("loader.optifineInvalid").with_detail(detail);
    }
    if let Some(rest) = detail.strip_prefix(crate::loaders::OPTIFINE_VERSION_MISMATCH_PREFIX) {
        let mut error = AppError::new("loader.optifineVersionMismatch");
        let split = rest
            .split_once(crate::loaders::OPTIFINE_VERSION_MISMATCH_INFIX)
            .or_else(|| rest.split_once("，与当前所选版本 "));
        if let Some((installer, expected)) = split {
            error = error
                .with_param("installer", installer)
                .with_param(
                    "expected",
                    expected
                        .strip_suffix(crate::loaders::OPTIFINE_VERSION_MISMATCH_SUFFIX)
                        .unwrap_or(expected),
                );
        }
        return error.with_detail(detail);
    }
    let code = if detail.starts_with("预设 JSON 无效") {
        "config.presetInvalid"
    } else if detail.starts_with(crate::modpacks::PLATFORM_REFUSED) {
        "modpack.platformUnavailable"
    } else if detail.starts_with(crate::assistant::ASSISTANT_PROVIDER_ERROR) {
        "assistant.providerError"
    } else if detail.starts_with(RESET_CREDENTIALS_PENDING) {
        "reset.credentialsPending"
    } else if detail.starts_with(RESET_SECRETS_LOCKED) {
        "reset.secretsLocked"
    } else if detail.starts_with(crate::assistant::mcp::MCP_FAILED) {
        "assistant.mcpFailed"
    } else {
        match detail.as_str() {
            crate::assistant::ASSISTANT_API_KEY_REQUIRED => "assistant.apiKeyRequired",
            crate::assistant::ASSISTANT_MODEL_REQUIRED => "assistant.modelRequired",
            crate::assistant::ASSISTANT_INVALID_BASE_URL => "assistant.invalidBaseUrl",
            crate::assistant::ASSISTANT_EMPTY_MESSAGE => "assistant.emptyMessage",
            crate::assistant::mcp::MCP_NOT_RUNNING => "assistant.mcpNotRunning",
            "助手提供商配置已变更，请重新发送消息"
            | "助手工具调用上下文已达上限，请重新发送消息" => "assistant.providerError",
            STORAGE_STATE_CHANGED => "storage.stateChanged",
            "instance.exportPreviewChanged" => "instance.exportPreviewChanged",
            crate::modpacks::pack_update::UNMANAGED => "modpack.unmanaged",
            crate::modpacks::pack_update::PLAN_CHANGED => "modpack.planChanged",
            crate::modpacks::pack_update::NOT_NEWER => "modpack.notNewer",
            crate::modpacks::pack_update::VERSION_MISMATCH | crate::modpacks::NOT_RELEASE => "modpack.versionMismatch",
            crate::modpacks::pack_update::DEPENDENCY_DRIFT => "modpack.dependencyDrift",
            crate::modpacks::pack_update::CONFLICT_CHOICE_INVALID => "modpack.conflictChoiceInvalid",
            crate::modpacks::pack_update::STAGE_MISMATCH | crate::modpacks::pack_update::LOCK_INVALID => "modpack.stageMismatch",
            crate::modpacks::pack_update::MANUAL_DOWNLOAD_REQUIRED => "modpack.manualDownloadRequired",
            crate::modpacks::pack_update::PACK_NOT_DOWNLOADABLE => "modpack.packNotDownloadable",
            crate::modpacks::MANIFEST_FILE_MISSING | crate::modpacks::MANIFEST_PROJECT_MISSING => "modpack.manifestMissing",
            crate::modpacks::NOT_MRPACK => "modpack.notMrpack",
            crate::modpacks::pack_update::SHARED_ROOT => "modpack.sharedRoot",
            crate::modpacks::PLATFORM_UNREACHABLE | crate::modpacks::PLATFORM_INTERRUPTED => "modpack.platformUnavailable",
            RESOURCE_RECOVERY_REQUIRED => "resource.recoveryRequired",
            RESTORE_PENDING => "instance.restorePending",
            INSTALL_GAME_RUNNING => "install.gameRunning",
            crate::server_manager::import::IMPORT_INSTALLER => "server.importInstaller",
            "所选参数文件不在导入的内容中" => "server.importArgsFileMismatch",
            crate::server_manager::import::IMPORT_ARGS_FILE => "server.importArgsFile",
            crate::server_manager::import::IMPORT_ARGS_INVALID => "server.importArgsInvalid",
            crate::server_manager::import::IMPORT_NO_JAR => "server.importNoJar",
            crate::server_manager::import::IMPORT_NOT_JAR => "server.importNotJar",
            crate::server_manager::import::IMPORT_OWN_DATA => "server.importOwnData",
            crate::server_manager::import::IMPORT_LINKS => "server.importLinks",
            crate::server_manager::import::IMPORT_TOO_LARGE => "server.importTooLarge",
            crate::server_manager::import::IMPORT_CHANGED => "server.importChanged",
            crate::server_manager::IMPORTED_JAR_MISSING => "server.importedJarMissing",
            crate::server_manager::IMPORTED_ARGS_MISSING => "server.importedArgsMissing",
            crate::server_manager::IMPORTED_RECORD_INVALID => "server.importedRecordInvalid",
            crate::server_manager::import::IMPORT_NEEDS_FOLDER => "server.importNeedsFolder",
            crate::server_manager::import::IMPORT_PROPERTIES_TEXT => "server.importPropertiesText",
            crate::server_manager::import::IMPORT_JAR_NAME => "server.importJarName",
            crate::auth::CLIENT_MISSING => "auth.clientIdRequired",
            crate::auth::CLIENT_REJECTED => "auth.clientRejected",
            crate::auth::APP_NOT_APPROVED => "auth.appNotApproved",
            ACCOUNT_SESSION_CHANGED => "auth.sessionChanged",
            CREDENTIAL_CLEANUP_PENDING => "auth.credentialCleanupPending",
            CREDENTIAL_RECOVERY_FAILED => "auth.credentialRecoveryFailed",
            crate::auth::MC_RATE_LIMITED => "auth.rateLimited",
            crate::auth::MC_EXCHANGE_FAILED => "auth.minecraftExchangeFailed",
            crate::auth::XBOX_FAILED => "auth.xboxFailed",
            "此实例已在运行，请勿重复启动"
            | "此实例的游戏仍在运行。请先正常退出游戏，再备份、克隆、导出或恢复实例。" => {
                "instance.running"
            }
            "实例不存在" | "实例不存在，请刷新实例列表" | "目标实例不存在，请重新选择实例" => {
                "instance.notFound"
            }
            "备份标识无效" | "所选备份不属于此实例" => "backup.notFound",
            "备份清单无效" => "backup.invalid",
            "世界备份需要保存为 .zip"
            | "备份文件不能写入正在备份的世界目录"
            | "个人备份导出路径必须以 .zip 结尾" => "backup.path",
            "资源路径不安全" | "资源路径越界" => "resource.pathUnsafe",
            "无法读取资源目录，请检查访问权限" => "resource.unavailable",
            "依赖图包含仅服务端资源，不能安装到客户端"
            | "依赖文件类型不匹配，未修改任何资源"
            | "依赖图出现不支持的依赖关系类型"
            | "必需前置没有可核验的项目标识"
            | "不兼容依赖没有可核验标识，无法安全继续"
            | "CurseForge 必需前置不支持固定文件版本"
            | "CurseForge 安装计划缺少文件"
            | "CurseForge 安装计划包含错误的文件类型"
            | "缺少根资源计划"
            | "已安装的必需前置不应再次下载" => "resource.dependencyInvalid",
            "两个依赖项目需要同名文件，无法安全安装" => "resource.dependencyConflict",
            crate::content::DATAPACK_INVALID => "datapack.invalid",
            crate::content::DATAPACK_EXISTS => "datapack.exists",
            crate::content::DATAPACK_NOT_FOUND => "datapack.notFound",
            crate::content::DATAPACK_MANIFEST_CONFLICT => "datapack.manifestConflict",
            "请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。" => {
                "auth.serviceKeyMissing"
            }
            "任务不存在" => "download.notFound",
            "任务已取消，已校验文件保留供下次复用" => "download.cancelled",
            "此游戏版本没有可安装的加载器版本" => "resource.loaderUnavailable",
            crate::loaders::OPTIFINE_ONLINE_UNAVAILABLE => "loader.optifineOnlineUnavailable",
            crate::instances::BASE_VERSION_UNKNOWN => "instance.baseVersionUnknown",
            "请回到对应资源、整合包或备份页面重新执行；已校验文件会复用" => {
                "download.retryUnsupported"
            }
            "该任务仍在执行或排队" => "download.active",
            crate::downloads::BUSY => "download.busy",
            crate::downloads::ALREADY_RETRIED => "download.alreadyRetried",
            "只能结束由本启动器启动、且仍在运行的游戏进程" => "game.notRunning",
            "正在处理此游戏的结束请求" => "game.stopBusy",
            "无法确认或结束游戏进程" => "game.stopFailed",
            "无法获取 Minecraft 角色，请刷新登录后重试" | "无法获取第三方角色皮肤" => {
                "auth.profileUnavailable"
            }
            "请输入第三方认证服务的用户名和密码" => "auth.credentialsRequired",
            "此上传入口只适用于 Microsoft 正版账号；第三方皮肤请到对应认证服务管理"
            | "此操作只适用于 Microsoft 正版账号" => "auth.microsoftRequired",
            "皮肤文件须为不超过 1 MB 的 PNG"
            | "请选择本地绝对路径的 PNG 皮肤文件"
            | "请选择有效且不超过 1 MB 的 PNG 皮肤"
            | "正版皮肤上传要求 64×64 或 64×32 PNG（高清贴图仅供本地预览）"
            | "64×32 旧版皮肤仅支持 classic 模型" => "skin.fileInvalid",
            "皮肤模型必须是 classic 或 slim" => "skin.modelInvalid",
            "设备代码或临时授权已过期，请重新开始登录" | "设备代码已过期或无效，请重新开始登录" => {
                "auth.deviceExpired"
            }
            "登录会话已取消或不存在，请重新开始登录"
            | "角色选择已取消或过期，请重新登录"
            | "角色选择已过期，请重新登录" => "auth.sessionExpired",
            "第三方认证失败，用户名、密码或会话可能无效，请重新登录" => {
                "auth.credentialsRejected"
            }
            "认证服务必须使用不含用户名、密码或片段的 HTTPS 网址"
            | "请填写第三方认证 API 根地址，不要包含查询参数" => {
                "auth.serverInvalid"
            }
            "请先阅读 Minecraft EULA 并在界面勾选同意，才能启动服务端" => {
                "server.eulaRequired"
            }
            "服务器不存在" | "服务端不存在" => "server.notFound",
            "请输入主机名或 IP，可附端口，例如 example.org:25565"
            | "IPv6 地址需使用方括号"
            | "端口格式错误"
            | "端口无效"
            | "地址无效"
            | "主机名或端口无效" => "server.addressInvalid",
            "另一个由启动器管理的服务端已使用此端口，请先更换端口" => {
                "server.portInUse"
            }
            "已有服务端管理操作正在进行"
            | "已有服务端操作正在进行"
            | "已有下载或启动准备任务运行" => "server.busy",
            "游戏目录必须是绝对路径" => "config.gameDirectory",
            "不支持所选内存分配模式" => "config.memoryMode",
            "最小内存需要在 256–65536 MB 之间" => "config.minMemoryRange",
            "最小内存不能大于最大内存" => "config.minMemoryAboveMax",
            "请使用最小和最大内存设置，不要在自定义 JVM 参数里使用 -Xms 或 -Xmx" => {
                "config.heapArguments"
            }
            "已有安装或启动准备任务运行，请等待完成后修改配置" => {
                "config.busy"
            }
            RESET_GAME_RUNNING => "reset.gameRunning",
            RESET_SERVER_RUNNING => "reset.serverRunning",
            RESET_DOWNLOADS_ACTIVE => "reset.downloadsActive",
            "背景图片需要本地绝对路径"
            | "请选择不超过 12 MB 的背景图片"
            | "PNG 图片不完整"
            | "背景图片尺寸过大"
            | "背景只支持 PNG、JPEG 或 WebP 图片" => "config.backgroundInvalid",
            "请选择绝对路径的 JSON 配置文件"
            | "请选择本地配置文件"
            | "配置文件过大"
            | "请选择本启动器导出的配置预设" => "config.presetInvalid",
            "默认角色仅支持 steve 或 alex"
            | "路径包含非法字符"
            | "最大内存需要在 512–65536 MB 之间"
            | "下载并发需要在 1–16 之间"
            | "不支持的主题"
            | "Microsoft Client ID 应为应用注册获得的 UUID"
            | "限速或窗口尺寸超出范围"
            | "下载源无效"
            | "强调色需要为 #RRGGBB"
            | "特效级别仅支持精简或完全"
            | "强调色来源无效"
            | "暂不支持所选界面语言"
            | "助手服务提供商无效"
            | "助手权限级别无效"
            | "MCP 端口需要在 1024–65535 之间"
            | "模型名称无效"
            | "API Key 格式无效" => "config.invalid",
            _ => "internal.unexpected",
        }
    };
    AppError::new(code).with_detail(detail)
}

/// The remote source of a Discover search, project or version page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiscoverSource {
    Modrinth,
    CurseForge,
}

/// A Discover failure as a code the page can explain. Launcher-wide codes
/// (proxy, the missing CurseForge key) stay as they are; a refused request,
/// the paging limits and every source failure get a Discover code, so a search
/// never ends in the generic error.
pub(crate) fn discover_error(source: DiscoverSource, error: AppError) -> AppError {
    if error.code != "internal.unexpected" {
        return error;
    }
    let detail = error.detail.unwrap_or_default();
    let code = if detail.starts_with(crate::resources::DISCOVER_REQUEST_INVALID) {
        "discover.requestInvalid"
    } else {
        match detail.as_str() {
            crate::resources::SEARCH_PAGE_LIMIT => "discover.pageLimit",
            crate::resources::VERSION_PAGE_LIMIT => "discover.versionPageLimit",
            crate::resources::MODRINTH_NOT_FOUND | crate::curseforge::NOT_FOUND => {
                "discover.projectNotFound"
            }
            crate::resources::MODRINTH_UNREACHABLE | crate::resources::MODRINTH_READ_FAILED => {
                "discover.modrinthUnreachable"
            }
            crate::resources::MODRINTH_RATE_LIMITED => "discover.modrinthRateLimited",
            crate::curseforge::CF_UNREACHABLE | crate::curseforge::CF_READ_FAILED => {
                "discover.curseforgeUnreachable"
            }
            crate::curseforge::CF_RATE_LIMITED => "discover.curseforgeRateLimited",
            crate::curseforge::CF_REFUSED => "discover.curseforgeRefused",
            _ => match source {
                DiscoverSource::Modrinth => "discover.modrinthFailed",
                DiscoverSource::CurseForge => "discover.curseforgeFailed",
            },
        }
    };
    AppError::new(code).with_detail(detail)
}

pub(crate) fn discover_failure(source: DiscoverSource, detail: impl Into<String>) -> AppError {
    discover_error(source, expected(detail))
}

/// The reason a pre-switch backup was refused, so the user can decide whether
/// to switch without one. The free-space refusal carries both sizes in MB.
fn loader_backup_failure(reason: &str) -> AppError {
    use crate::instances::{
        backup_space_shortfall, BACKUP_CHANGED, LINKS_REFUSED, TREE_SPECIAL_FILE, TREE_TOO_DEEP,
        TREE_TOO_LARGE, TREE_TOO_MANY_ENTRIES, TREE_TOO_MANY_FILES,
    };
    if let Some((needed, available)) = backup_space_shortfall(reason) {
        return AppError::new("loader.switchBackupNoSpace")
            .with_param("needed", needed)
            .with_param("available", available);
    }
    AppError::new(match reason {
        LINKS_REFUSED | TREE_SPECIAL_FILE => "loader.switchBackupLinks",
        TREE_TOO_DEEP | TREE_TOO_MANY_ENTRIES | TREE_TOO_MANY_FILES => "loader.switchBackupTooManyFiles",
        TREE_TOO_LARGE => "loader.switchBackupTooLarge",
        BACKUP_CHANGED => "loader.switchBackupChanged",
        _ => "loader.switchBackupFailed",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fb_adopt_2_new_instance_and_folder_errors_have_stable_codes_and_params() {
        use super::*;
        let dependants = expected(format!(
            "{INSTANCE_DELETE_DEPENDANTS_PREFIX}1.21.1-Fabric\n1.21.1-Forge"
        ));
        assert_eq!(dependants.code, "instance.deleteDependants");
        assert_eq!(dependants.params["instances"], "1.21.1-Fabric、1.21.1-Forge");
        assert_eq!(expected(INSTANCE_OFFICIAL_NAME).code, "instance.officialVersionName");
        assert_eq!(
            expected(INSTANCE_LOADER_SWITCH_SHARED).code,
            "instance.loaderSwitchShared"
        );
        assert_eq!(
            expected(INSTANCE_LOADER_SWITCH_INSTALLER_FOLDER).code,
            "instance.loaderSwitchInstallerFolder"
        );
        let blocked = expected(format!("{INSTANCE_LAUNCH_BLOCKED_PREFIX}baseMissing"));
        assert_eq!(blocked.code, "instance.launchBlocked");
        assert_eq!(blocked.params["reason"], "baseMissing");
        let recycle = expected(format!("{INSTANCE_RECYCLE_FAILED_PREFIX}aborted"));
        assert_eq!(recycle.code, "instance.recycleFailed");
        assert_eq!(recycle.params["reason"], "aborted");
        assert!(!recycle.params.contains_key("code"));
        let shell = expected(format!("{INSTANCE_RECYCLE_FAILED_PREFIX}shellError:0x7C"));
        assert_eq!(shell.params["reason"], "shellError");
        assert_eq!(shell.params["code"], "0x7C");
        let unavailable = expected(format!(
            "{INSTANCE_RECYCLE_UNAVAILABLE_PREFIX}networkShare"
        ));
        assert_eq!(unavailable.code, "instance.recycleUnavailable");
        assert_eq!(unavailable.params["reason"], "networkShare");
        assert_eq!(expected(GAME_FOLDER_NESTED).code, "gameFolder.nested");
        assert_eq!(
            expected(GAME_FOLDER_DATA_DIRECTORY).code,
            "gameFolder.dataDirectory"
        );
    }

    #[test]
    fn c2_install_while_a_game_runs_has_a_stable_code() {
        assert_eq!(expected(INSTALL_GAME_RUNNING).code, "install.gameRunning");
    }

    #[test]
    fn resource_cancellation_has_a_stable_code() {
        assert_eq!(
            expected("任务已取消，已校验文件保留供下次复用").code,
            "download.cancelled"
        );
    }

    #[test]
    fn clearing_downloads_while_busy_has_a_stable_code() {
        assert_eq!(expected(crate::downloads::BUSY).code, "download.busy");
    }

    #[test]
    fn reset_refusals_do_not_reuse_the_launcher_update_texts() {
        for (detail, code) in [
            (RESET_GAME_RUNNING, "reset.gameRunning"),
            (RESET_SERVER_RUNNING, "reset.serverRunning"),
            (RESET_DOWNLOADS_ACTIVE, "reset.downloadsActive"),
        ] {
            assert_eq!(expected(detail).code, code, "{detail}");
        }
        let pending = format!("{RESET_CREDENTIALS_PENDING}：无法删除账号凭据");
        let error = expected(pending.clone());
        assert_eq!(error.code, "reset.credentialsPending");
        assert_eq!(error.detail.as_deref(), Some(pending.as_str()));
        let locked = format!("{RESET_SECRETS_LOCKED}：部分加密凭据文件无法删除");
        let error = expected(locked.clone());
        assert_eq!(error.code, "reset.secretsLocked");
        assert_eq!(error.detail.as_deref(), Some(locked.as_str()));
    }

    #[test]
    fn datapack_errors_map_to_stable_codes() {
        assert_eq!(expected(crate::content::DATAPACK_INVALID).code, "datapack.invalid");
        assert_eq!(expected(crate::content::DATAPACK_EXISTS).code, "datapack.exists");
        assert_eq!(expected(crate::content::DATAPACK_NOT_FOUND).code, "datapack.notFound");
        assert_eq!(expected(crate::content::DATAPACK_MANIFEST_CONFLICT).code, "datapack.manifestConflict");
    }

    #[test]
    fn microsoft_auth_constants_map_to_stable_error_codes() {
        use crate::auth::{
            APP_NOT_APPROVED, CLIENT_MISSING, CLIENT_REJECTED, MC_EXCHANGE_FAILED, MC_RATE_LIMITED,
            XBOX_FAILED,
        };
        for (detail, code) in [
            (CLIENT_MISSING, "auth.clientIdRequired"),
            (CLIENT_REJECTED, "auth.clientRejected"),
            (APP_NOT_APPROVED, "auth.appNotApproved"),
            (MC_RATE_LIMITED, "auth.rateLimited"),
            (MC_EXCHANGE_FAILED, "auth.minecraftExchangeFailed"),
            (XBOX_FAILED, "auth.xboxFailed"),
        ] {
            assert_eq!(expected(detail).code, code);
        }
    }

    #[test]
    fn app_error_serializes_stable_code_params_and_detail() {
        let error = AppError::new("instance.running").with_param("id", "fixture");
        assert_eq!(error.code, "instance.running");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["params"]["id"], "fixture");

        let internal = AppError::internal("旧内部错误");
        assert_eq!(internal.code, "internal.unexpected");
        assert_eq!(internal.detail.as_deref(), Some("旧内部错误"));
        assert_eq!(
            serde_json::to_value(internal).unwrap()["detail"],
            "旧内部错误"
        );

        let detailed = AppError::new("auth.required").with_detail("需要登录");
        assert_eq!(detailed.detail.as_deref(), Some("需要登录"));
    }

    #[test]
    fn expected_errors_have_stable_codes_and_legacy_detail() {
        let running = expected("此实例已在运行，请勿重复启动".to_string());
        assert_eq!(running.code, "instance.running");
        assert_eq!(
            running.detail.as_deref(),
            Some("此实例已在运行，请勿重复启动")
        );
        let missing = expected("实例不存在".to_string());
        assert_eq!(missing.code, "instance.notFound");
        let unknown = expected("磁盘读取失败".to_string());
        assert_eq!(unknown.code, "internal.unexpected");
        assert_eq!(expected("任务不存在".to_string()).code, "download.notFound");
        assert_eq!(
            expected("请回到对应资源、整合包或备份页面重新执行；已校验文件会复用".to_string()).code,
            "download.retryUnsupported"
        );
        assert_eq!(
            expected("该任务仍在执行或排队".to_string()).code,
            "download.active"
        );
        assert_eq!(
            expected("无法获取 Minecraft 角色，请刷新登录后重试".to_string()).code,
            "auth.profileUnavailable"
        );
        assert_eq!(
            expected("请输入第三方认证服务的用户名和密码".to_string()).code,
            "auth.credentialsRequired"
        );
        assert_eq!(
            expected("此操作只适用于 Microsoft 正版账号".to_string()).code,
            "auth.microsoftRequired"
        );
        assert_eq!(
            expected("皮肤文件须为不超过 1 MB 的 PNG".to_string()).code,
            "skin.fileInvalid"
        );
        assert_eq!(
            expected("请先阅读 Minecraft EULA 并在界面勾选同意，才能启动服务端".to_string()).code,
            "server.eulaRequired"
        );
        assert_eq!(expected("服务器不存在".to_string()).code, "server.notFound");
        assert_eq!(
            expected("请输入主机名或 IP，可附端口，例如 example.org:25565".to_string()).code,
            "server.addressInvalid"
        );
        assert_eq!(
            expected("另一个由启动器管理的服务端已使用此端口，请先更换端口".to_string()).code,
            "server.portInUse"
        );
        assert_eq!(
            expected("已有服务端操作正在进行".to_string()).code,
            "server.busy"
        );
        assert_eq!(
            expected("游戏目录必须是绝对路径".to_string()).code,
            "config.gameDirectory"
        );
        assert_eq!(
            expected("已有安装或启动准备任务运行，请等待完成后修改配置".to_string()).code,
            "config.busy"
        );
        assert_eq!(
            expected("请选择不超过 12 MB 的背景图片".to_string()).code,
            "config.backgroundInvalid"
        );
        assert_eq!(
            expected("预设 JSON 无效：fixture".to_string()).code,
            "config.presetInvalid"
        );
        assert_eq!(expected("下载源无效".to_string()).code, "config.invalid");
    }

    #[test]
    fn u27_a_curseforge_file_to_download_by_hand_has_its_own_code_and_file_id() {
        let detail = format!("{}8675309\n「Fixture」文件 8675309 禁止第三方分发或未提供可用下载地址。", crate::curseforge::MANUAL_DOWNLOAD);
        let error = expected(detail.clone());
        assert_eq!(error.code, "resource.manualDownload");
        assert_eq!(error.params["fileId"], "8675309");
        assert_eq!(error.detail.as_deref(), Some(detail.as_str()));
    }

    #[test]
    fn curseforge_dependency_errors_have_stable_codes_and_params() {
        let incompatible = format!("{RESOURCE_DEPENDENCY_INCOMPATIBLE_PREFIX}Incompatible Mod (incompatible.jar)");
        let error = expected(incompatible.clone());
        assert_eq!(error.code, "resource.dependencyIncompatible");
        assert_eq!(error.params["project"], "Incompatible Mod (incompatible.jar)");
        assert_eq!(error.detail.as_deref(), Some(incompatible.as_str()));

        let limit = format!("{RESOURCE_DEPENDENCY_LIMIT_PREFIX}超过 16 层");
        let error = expected(limit.clone());
        assert_eq!(error.code, "resource.dependencyLimit");
        assert_eq!(error.params["reason"], "超过 16 层");
        assert_eq!(error.detail.as_deref(), Some(limit.as_str()));

        let cycle = format!("{RESOURCE_DEPENDENCY_CYCLE_PREFIX}Dependency");
        let error = expected(cycle.clone());
        assert_eq!(error.code, "resource.dependencyCycle");
        assert_eq!(error.params["project"], "Dependency");
        assert_eq!(error.detail.as_deref(), Some(cycle.as_str()));

        let unavailable = format!(
            "{RESOURCE_DEPENDENCY_UNAVAILABLE_PREFIX}Fabric API\tCurseForge 必需前置「Fabric API」没有适用于当前游戏版本和加载器的文件"
        );
        let error = expected(unavailable.clone());
        assert_eq!(error.code, "resource.dependencyUnavailable");
        assert_eq!(error.params["name"], "Fabric API");
        assert_eq!(error.detail.as_deref(), Some(unavailable.as_str()));

        let conflict = format!("{RESOURCE_DEPENDENCY_CONFLICT_PREFIX}项目 789 被要求使用两个不同版本，未修改任何资源");
        let error = expected(conflict.clone());
        assert_eq!(error.code, "resource.dependencyConflict");
        assert_eq!(error.detail.as_deref(), Some(conflict.as_str()));

        for detail in [
            "依赖图包含仅服务端资源，不能安装到客户端",
            "依赖文件类型不匹配，未修改任何资源",
            "依赖图出现不支持的依赖关系类型",
            "必需前置没有可核验的项目标识",
            "不兼容依赖没有可核验标识，无法安全继续",
            "CurseForge 必需前置不支持固定文件版本",
            "CurseForge 安装计划缺少文件",
            "CurseForge 安装计划包含错误的文件类型",
        ] {
            assert_eq!(expected(detail).code, "resource.dependencyInvalid", "{detail}");
        }

        let install_first = format!(
            "{}「Entity Model Features」属于其他资源分类\t{}",
            crate::curseforge::DEPENDENCY_INSTALL_FIRST,
            serde_json::json!({
                "name": "Entity Model Features",
                "folder": "mods",
            })
        );
        let error = expected(install_first.clone());
        assert_eq!(error.code, "resource.dependencyInstallFirst");
        assert_eq!(error.params["name"], "Entity Model Features");
        assert_eq!(error.params["folder"], "mods");
        assert_eq!(error.detail.as_deref(), Some(install_first.as_str()));

        let manual = format!(
            "{}「Dependency」文件 dependency.jar（9001）禁止第三方分发\t{}",
            crate::curseforge::DEPENDENCY_MANUAL_DOWNLOAD,
            serde_json::json!({
                "name": "Dependency",
                "file": "dependency.jar",
                "url": "https://www.curseforge.com/projects/789",
                "folder": "resourcepacks",
            })
        );
        let error = expected(manual.clone());
        assert_eq!(error.code, "resource.dependencyManualDownload");
        assert_eq!(error.params["name"], "Dependency");
        assert_eq!(error.params["file"], "dependency.jar");
        assert_eq!(
            error.params["url"],
            "https://www.curseforge.com/projects/789"
        );
        assert_eq!(error.params["folder"], "resourcepacks");
        assert_eq!(error.detail.as_deref(), Some(manual.as_str()));
    }

    #[test]
    fn c12_manual_download_and_non_release_errors_have_their_own_codes() {
        let list = "「Pack」 → mods/a.jar（https://www.curseforge.com/minecraft/modpacks/pack）";
        let detail = format!("{}{list}", crate::modpacks::MANUAL_DOWNLOAD);
        let error = expected(detail.clone());
        assert_eq!(error.code, "modpack.manualDownload");
        assert_eq!(error.params["files"], list);
        assert_eq!(error.detail.as_deref(), Some(detail.as_str()));
        assert_eq!(expected(crate::modpacks::NOT_RELEASE).code, "modpack.versionMismatch");
        assert_eq!(
            expected(crate::modpacks::pack_update::MANUAL_DOWNLOAD_REQUIRED).code,
            "modpack.manualDownloadRequired"
        );
        assert_eq!(expected(crate::modpacks::pack_update::PACK_NOT_DOWNLOADABLE).code, "modpack.packNotDownloadable");
        for missing in [crate::modpacks::MANIFEST_FILE_MISSING, crate::modpacks::MANIFEST_PROJECT_MISSING] {
            assert_eq!(expected(missing).code, "modpack.manifestMissing");
        }
    }

    #[test]
    fn v2_server_import_refusals_have_their_own_codes() {
        use crate::server_manager::import::*;
        for (detail, code) in [
            (IMPORT_INSTALLER, "server.importInstaller"),
            (IMPORT_ARGS_FILE, "server.importArgsFile"),
            (IMPORT_NO_JAR, "server.importNoJar"),
            (IMPORT_NOT_JAR, "server.importNotJar"),
            (IMPORT_OWN_DATA, "server.importOwnData"),
            (IMPORT_LINKS, "server.importLinks"),
            (IMPORT_TOO_LARGE, "server.importTooLarge"),
            (IMPORT_CHANGED, "server.importChanged"),
            (crate::server_manager::IMPORTED_JAR_MISSING, "server.importedJarMissing"),
            (crate::server_manager::IMPORTED_RECORD_INVALID, "server.importedRecordInvalid"),
            (IMPORT_NEEDS_FOLDER, "server.importNeedsFolder"),
            (IMPORT_PROPERTIES_TEXT, "server.importPropertiesText"),
            (IMPORT_JAR_NAME, "server.importJarName"),
        ] {
            assert_eq!(expected(detail).code, code);
        }
        let detail = format!("{IMPORT_PROPERTIES}view-distance");
        let error = expected(detail.clone());
        assert_eq!(error.code, "server.importProperties");
        assert_eq!(error.params["key"], "view-distance", "the page names the key");
        assert_eq!(error.detail.as_deref(), Some(detail.as_str()));
    }

    #[test]
    fn mcp_server_failures_have_their_own_codes() {
        use crate::assistant::mcp::{bind_failed, MCP_FAILED, MCP_NOT_RUNNING};
        for error in [
            std::io::Error::from(std::io::ErrorKind::AddrInUse),
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        ] {
            let detail = bind_failed(25590, &error);
            let mapped = expected(detail.clone());
            assert_eq!(mapped.code, "assistant.mcpPortUnavailable", "{detail}");
            assert_eq!(mapped.params["port"], 25590);
            assert_eq!(mapped.detail.as_deref(), Some(detail.as_str()));
        }
        assert_eq!(expected(MCP_NOT_RUNNING).code, "assistant.mcpNotRunning");
        assert_eq!(expected(format!("{MCP_FAILED}服务锁异常")).code, "assistant.mcpFailed");
        // A managed server's own port conflict keeps its multiplayer code.
        assert_eq!(
            expected("另一个由启动器管理的服务端已使用此端口，请先更换端口").code,
            "server.portInUse"
        );
    }

    #[test]
    fn u7_optifine_loader_switch_and_args_file_errors_have_stable_codes() {
        use crate::loaders::{
            optifine_version_mismatch, OPTIFINE_CHANGED, OPTIFINE_FILENAME_INVALID,
            OPTIFINE_INVALID, OPTIFINE_NAME_INVALID, OPTIFINE_NOT_JAR, OPTIFINE_ONLINE_UNAVAILABLE,
            OPTIFINE_OPEN_FAILED, OPTIFINE_READ_FAILED, OPTIFINE_SIZE_INVALID,
        };
        for detail in [
            OPTIFINE_READ_FAILED,
            OPTIFINE_SIZE_INVALID,
            OPTIFINE_NAME_INVALID,
            OPTIFINE_OPEN_FAILED,
            OPTIFINE_NOT_JAR,
            OPTIFINE_INVALID,
            OPTIFINE_FILENAME_INVALID,
            OPTIFINE_CHANGED,
        ] {
            let error = expected(detail);
            assert_eq!(error.code, "loader.optifineInvalid", "{detail}");
            assert_eq!(error.detail.as_deref(), Some(detail), "{detail}");
        }
        assert_eq!(
            expected("所选 JAR 不是有效的 OptiFine 安装器").code,
            "loader.optifineInvalid"
        );
        let mismatch = optifine_version_mismatch("1.21.4", "1.20.4");
        let error = expected(mismatch.clone());
        assert_eq!(error.code, "loader.optifineVersionMismatch");
        assert_eq!(error.params["installer"], "1.21.4");
        assert_eq!(error.params["expected"], "1.20.4");
        assert_eq!(error.detail.as_deref(), Some(mismatch.as_str()));
        let legacy = expected(
            "所选 OptiFine 安装器适用于 Minecraft 1.21.4，与当前所选版本 1.20.4 不匹配",
        );
        assert_eq!(legacy.code, "loader.optifineVersionMismatch");
        assert_eq!(legacy.params["installer"], "1.21.4");
        assert_eq!(legacy.params["expected"], "1.20.4");
        let online = expected(OPTIFINE_ONLINE_UNAVAILABLE);
        assert_eq!(online.code, "loader.optifineOnlineUnavailable");
        assert_eq!(online.detail.as_deref(), Some(OPTIFINE_ONLINE_UNAVAILABLE));
        assert_eq!(
            expected(crate::instances::BASE_VERSION_UNKNOWN).code,
            "instance.baseVersionUnknown"
        );
        assert_eq!(
            expected("所选参数文件不在导入的内容中").code,
            "server.importArgsFileMismatch"
        );
    }

    #[test]
    fn u7_refused_pre_switch_backups_name_their_reason() {
        use crate::instances::{
            loader_backup_error, BACKUP_CHANGED, LINKS_REFUSED, TREE_SPECIAL_FILE, TREE_TOO_DEEP,
            TREE_TOO_LARGE, TREE_TOO_MANY_ENTRIES, TREE_TOO_MANY_FILES,
        };
        for (reason, code) in [
            (LINKS_REFUSED, "loader.switchBackupLinks"),
            (TREE_SPECIAL_FILE, "loader.switchBackupLinks"),
            (TREE_TOO_DEEP, "loader.switchBackupTooManyFiles"),
            (TREE_TOO_MANY_ENTRIES, "loader.switchBackupTooManyFiles"),
            (TREE_TOO_MANY_FILES, "loader.switchBackupTooManyFiles"),
            (TREE_TOO_LARGE, "loader.switchBackupTooLarge"),
            (BACKUP_CHANGED, "loader.switchBackupChanged"),
            ("Access is denied. (os error 5)", "loader.switchBackupFailed"),
        ] {
            let detail = loader_backup_error(reason.to_owned());
            let error = expected(detail.clone());
            assert_eq!(error.code, code, "{reason}");
            assert_eq!(error.detail.as_deref(), Some(detail.as_str()), "{reason}");
        }
        // A Cancel pressed while the backup runs is the user's choice, not a
        // refused backup.
        assert_eq!(
            expected(loader_backup_error(crate::downloads::CANCELLED.to_owned())).code,
            "download.cancelled"
        );
    }

    #[test]
    fn c5_memory_validation_errors_have_their_own_codes() {
        for (detail, code) in [
            (crate::memory::validate_mode("bogus").unwrap_err(), "config.memoryMode"),
            (crate::memory::validate_min("auto", Some(100), 4096).unwrap_err(), "config.minMemoryRange"),
            (crate::memory::validate_min("manual", Some(8192), 4096).unwrap_err(), "config.minMemoryAboveMax"),
            (crate::memory::validate_changed_heap_arguments("", "-Xmx2G").unwrap_err(), "config.heapArguments"),
        ] {
            assert_eq!(expected(detail.clone()).code, code, "{detail}");
            assert_eq!(crate::errors::AppError::from(detail).code, code);
        }
    }

    #[test]
    fn discover_failures_have_their_own_codes_and_keep_launcher_codes() {
        use crate::curseforge::{
            CF_HTTP_FAILED, CF_RATE_LIMITED, CF_READ_FAILED, CF_REFUSED, CF_UNREACHABLE, NOT_FOUND,
        };
        use crate::resources::{
            curseforge_sort, modrinth_search_query, search_limit, search_offset, version_offset,
            MODRINTH_NOT_FOUND, MODRINTH_RATE_LIMITED, MODRINTH_READ_FAILED, MODRINTH_UNREACHABLE,
        };
        use DiscoverSource::{CurseForge, Modrinth};
        let window = search_offset(Some(9977), 24).unwrap_err();
        let query = modrinth_search_query(&"x".repeat(501), "mod", None, None, None, None, None)
            .unwrap_err();
        let cases = [
            (Modrinth, expected(window.clone()), "discover.pageLimit"),
            (CurseForge, expected(window), "discover.pageLimit"),
            (Modrinth, expected(search_limit(Some(51)).unwrap_err()), "discover.requestInvalid"),
            (CurseForge, expected(curseforge_sort(Some("relevance")).unwrap_err()), "discover.requestInvalid"),
            (Modrinth, expected(query), "discover.requestInvalid"),
            (Modrinth, version_offset(Some(301)).unwrap_err(), "discover.versionPageLimit"),
            (Modrinth, expected(MODRINTH_UNREACHABLE), "discover.modrinthUnreachable"),
            (Modrinth, expected(MODRINTH_READ_FAILED), "discover.modrinthUnreachable"),
            (Modrinth, expected(MODRINTH_RATE_LIMITED), "discover.modrinthRateLimited"),
            (Modrinth, expected(MODRINTH_NOT_FOUND), "discover.projectNotFound"),
            (Modrinth, expected("Modrinth 请求失败（HTTP 502）"), "discover.modrinthFailed"),
            (Modrinth, expected("Modrinth 返回的资源信息无法解析"), "discover.modrinthFailed"),
            (CurseForge, expected(CF_UNREACHABLE), "discover.curseforgeUnreachable"),
            (CurseForge, expected(CF_READ_FAILED), "discover.curseforgeUnreachable"),
            (CurseForge, expected(CF_RATE_LIMITED), "discover.curseforgeRateLimited"),
            (CurseForge, expected(CF_REFUSED), "discover.curseforgeRefused"),
            (CurseForge, expected(NOT_FOUND), "discover.projectNotFound"),
            (CurseForge, expected(format!("{CF_HTTP_FAILED}500）")), "discover.curseforgeFailed"),
            (CurseForge, expected("CurseForge 数据格式无法解析"), "discover.curseforgeFailed"),
            // Launcher-wide codes keep their own explanation.
            (Modrinth, expected(crate::network::Error::Authentication.code()), "proxy.authentication"),
            (
                CurseForge,
                expected("请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。"),
                "auth.serviceKeyMissing",
            ),
        ];
        for (source, error, code) in cases {
            let detail = error.detail.clone();
            let mapped = discover_error(source, error);
            assert_eq!(mapped.code, code, "{detail:?}");
            assert_ne!(mapped.code, "internal.unexpected");
            if code.starts_with("discover.") {
                assert_eq!(mapped.detail, detail, "the diagnostic detail is kept");
            }
        }
        assert_eq!(
            discover_failure(Modrinth, MODRINTH_RATE_LIMITED).code,
            "discover.modrinthRateLimited"
        );
    }

    #[test]
    fn fb_launch_version_error_codes_map_stably() {
        let offline = expected(format!("{PROFILE_OFFLINE_UNVERIFIED_PREFIX}1.21.1"));
        assert_eq!(offline.code, "version.offlineUnverified");
        assert_eq!(offline.params["id"], "1.21.1");

        let conflict = expected(format!("{PROFILE_CONFLICT_PREFIX}1.21.1\n原有版本元数据保存在 C:\\backup"));
        assert_eq!(conflict.code, "version.profileConflict");
        assert_eq!(conflict.params["id"], "1.21.1");

        let reinstall = expected(format!("{LOADER_REINSTALL_PREFIX}1.21.1-fabric-0.19.3"));
        assert_eq!(reinstall.code, "version.loaderReinstall");
        assert_eq!(reinstall.params["id"], "1.21.1-fabric-0.19.3");

        let artifact = expected(format!("{LOADER_ARTIFACT_MISSING_PREFIX}client-srg.jar；请重新安装对应加载器"));
        assert_eq!(artifact.code, "version.loaderArtifactMissing");
    }
}
