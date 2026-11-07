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

pub fn expected(detail: impl Into<String>) -> AppError {
    let detail = detail.into();
    let code = if detail.starts_with("预设 JSON 无效") {
        "config.presetInvalid"
    } else {
        match detail.as_str() {
            crate::auth::CLIENT_MISSING => "auth.clientIdRequired",
            crate::auth::CLIENT_REJECTED => "auth.clientRejected",
            crate::auth::APP_NOT_APPROVED => "auth.appNotApproved",
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
            "请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。" => {
                "auth.serviceKeyMissing"
            }
            "任务不存在" => "download.notFound",
            "请回到对应资源、整合包或备份页面重新执行；已校验文件会复用" => {
                "download.retryUnsupported"
            }
            "该任务仍在执行或排队" => "download.active",
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
            "已有安装或启动准备任务运行，请等待完成后修改配置" => {
                "config.busy"
            }
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
            | "暂不支持所选界面语言" => "config.invalid",
            _ => "internal.unexpected",
        }
    };
    AppError::new(code).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
