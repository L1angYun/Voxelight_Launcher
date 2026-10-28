//! A resource transaction stages a complete directory and preserves its previous contents.
use super::*;
use crate::instances::{checked_absolute, collect_files, FileRecord};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone)]
struct LocalEntry {
    file_name: String,
    hash: String,
    enabled: bool,
    version: Option<Version>,
}

#[derive(Clone)]
struct Node {
    version: Version,
    enabled: bool,
}

struct Action {
    node: Node,
    destination: String,
    keep: Option<String>,
    remove: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    id: String,
    name: String,
    created_at: String,
    status: String,
    directory: String,
    projects: Vec<String>,
    before_exists: bool,
    before: Vec<FileRecord>,
    after: Vec<FileRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUpdate {
    pub file_name: String,
    pub name: String,
    pub current_version: String,
    pub new_version: String,
    pub project_id: String,
    pub new_version_id: String,
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHistory {
    pub update_id: String,
    pub name: String,
    pub created_at: String,
    pub status: String,
    pub projects: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub update_id: String,
    pub restored_files: usize,
    pub status: String,
}

async fn identify(
    api: &reqwest::Client,
    hashes: &[String],
) -> Result<HashMap<String, Version>, String> {
    let mut output = HashMap::new();
    for batch in hashes.chunks(100) {
        let response = api
            .post(format!("{API}/version_files"))
            .json(&serde_json::json!({"hashes": batch, "algorithm":"sha512"}))
            .send()
            .await
            .map_err(|_| "无法通过 Modrinth 校验本地资源身份")?;
        if !response.status().is_success() {
            return Err(format!(
                "Modrinth 资源识别失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Modrinth 资源身份数据读取失败")?;
            if bytes.len().saturating_add(chunk.len()) > MAX_METADATA_BYTES {
                return Err("Modrinth 资源身份数据过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let versions: HashMap<String, Version> =
            serde_json::from_slice(&bytes).map_err(|_| "Modrinth 资源身份数据格式无效")?;
        output.extend(versions);
    }
    Ok(output)
}

async fn scan(
    state: &LauncherState,
    api: &reqwest::Client,
    directory: &Path,
    kind: ResourceKind,
) -> Result<Vec<LocalEntry>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    checked_absolute(directory)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| "无法读取本地资源目录")? {
        state.control.checkpoint().await?;
        let path = entry.map_err(|_| "读取资源文件失败")?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取资源文件属性")?;
        if !metadata.is_file() || linked(&metadata) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let enabled = !name.to_ascii_lowercase().ends_with(".disabled");
        let base = if enabled {
            name
        } else {
            &name[..name.len() - 9]
        };
        if !kind.accepts(base) || validate_id(name).is_err() {
            continue;
        }
        entries.push(LocalEntry {
            file_name: name.into(),
            hash: file_sha512(&path)?,
            enabled,
            version: None,
        });
    }
    let values = identify(
        api,
        &entries.iter().map(|v| v.hash.clone()).collect::<Vec<_>>(),
    )
    .await?;
    for entry in &mut entries {
        entry.version = values.get(&entry.hash).cloned();
    }
    Ok(entries)
}

fn latest(versions: Vec<Version>) -> Option<Version> {
    versions
        .iter()
        .find(|v| v.version_type == "release")
        .cloned()
        .or_else(|| versions.into_iter().next())
}

fn check_cycle(graph: &HashMap<String, Vec<String>>) -> Result<(), String> {
    fn visit(
        node: &str,
        graph: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
    ) -> Result<(), String> {
        if done.contains(node) {
            return Ok(());
        }
        if !visiting.insert(node.into()) {
            return Err(format!("必需前置存在循环依赖：{node}"));
        }
        if let Some(edges) = graph.get(node) {
            for edge in edges {
                visit(edge, graph, visiting, done)?;
            }
        }
        visiting.remove(node);
        done.insert(node.into());
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    for node in graph.keys() {
        visit(node, graph, &mut visiting, &mut done)?;
    }
    Ok(())
}

async fn resolve_plan(
    state: &LauncherState,
    api: &reqwest::Client,
    selected: Version,
    enabled: bool,
    locals: &[LocalEntry],
    minecraft: &str,
    loader: Option<&str>,
    kind: ResourceKind,
) -> Result<Vec<Node>, String> {
    identifier(&selected.project_id)?;
    let root = selected.project_id.clone();
    let mut nodes = HashMap::from([(
        root.clone(),
        Node {
            version: selected.clone(),
            enabled,
        },
    )]);
    let mut queue = VecDeque::from([selected]);
    let mut graph = HashMap::<String, Vec<String>>::new();
    let mut incompatible = Vec::new();
    while let Some(version) = queue.pop_front() {
        state.control.checkpoint().await?;
        if nodes.len() > 64 {
            return Err("必需前置超过 64 个项目，已停止以避免异常依赖图".into());
        }
        if !compatible(&version, minecraft, loader) {
            return Err(format!("依赖版本 {} 与所选游戏或加载器不兼容", version.id));
        }
        if ["server_only", "dedicated_server_only"].contains(&version.environment.as_str()) {
            return Err("依赖图包含仅服务端资源，不能安装到客户端".into());
        }
        let file = primary_file(&version)?;
        if !kind.accepts(&file.filename) {
            return Err("依赖文件类型不匹配，未修改任何资源".into());
        }
        for dependency in &version.dependencies {
            match dependency.dependency_type.as_str() {
                "embedded" | "optional" => continue,
                "incompatible" => {
                    incompatible.push(dependency.clone());
                    continue;
                }
                "required" => {}
                _ => return Err("依赖图出现不支持的依赖关系类型".into()),
            }
            let desired = if let Some(id) = dependency.version_id.as_deref() {
                identifier(id)?;
                let value: Version = api_json(api, &format!("version/{id}"), &[]).await?;
                if dependency
                    .project_id
                    .as_deref()
                    .is_some_and(|p| p != value.project_id)
                {
                    return Err("固定前置版本与项目标识不一致".into());
                }
                value
            } else if let Some(project) = dependency.project_id.as_deref() {
                identifier(project)?;
                if let Some(existing) = nodes.get(project) {
                    existing.version.clone()
                } else if let Some(existing) = locals
                    .iter()
                    .filter(|v| v.enabled)
                    .filter_map(|v| v.version.as_ref())
                    .find(|v| v.project_id == project && compatible(v, minecraft, loader))
                {
                    existing.clone()
                } else {
                    latest(project_versions(api, project, minecraft, loader).await?)
                        .ok_or_else(|| format!("必需前置 {project} 没有兼容版本"))?
                }
            } else {
                return Err("必需前置没有可核验的 Modrinth 标识".into());
            };
            identifier(&desired.project_id)?;
            graph
                .entry(version.project_id.clone())
                .or_default()
                .push(desired.project_id.clone());
            if let Some(existing) = nodes.get(&desired.project_id) {
                if existing.version.id != desired.id {
                    return Err(format!(
                        "项目 {} 被要求使用两个不同版本，未修改任何资源",
                        desired.project_id
                    ));
                }
            } else {
                nodes.insert(
                    desired.project_id.clone(),
                    Node {
                        version: desired.clone(),
                        enabled: true,
                    },
                );
                queue.push_back(desired);
            }
        }
    }
    check_cycle(&graph)?;
    for dependency in incompatible {
        state.control.checkpoint().await?;
        let (project, pinned) = if let Some(id) = dependency.version_id {
            identifier(&id)?;
            let version: Version = api_json(api, &format!("version/{id}"), &[]).await?;
            (version.project_id, Some(id))
        } else if let Some(project) = dependency.project_id {
            (project, None)
        } else {
            return Err("不兼容依赖没有可核验标识，无法安全继续".into());
        };
        let conflicts = |version: &Version| {
            version.project_id == project && pinned.as_ref().is_none_or(|id| id == &version.id)
        };
        if nodes
            .values()
            .any(|node| node.enabled && conflicts(&node.version))
            || locals
                .iter()
                .filter(|entry| entry.enabled)
                .filter_map(|entry| entry.version.as_ref())
                .any(|version| !nodes.contains_key(&version.project_id) && conflicts(version))
        {
            return Err(format!(
                "检测到与依赖图不兼容的已启用项目 {project}，未修改任何文件"
            ));
        }
    }
    let mut ordered: Vec<Node> = nodes.into_values().collect();
    ordered.sort_by(|a, b| a.version.project_id.cmp(&b.version.project_id));
    Ok(ordered)
}

fn actions(nodes: Vec<Node>, locals: &[LocalEntry]) -> Result<Vec<Action>, String> {
    let mut output = Vec::new();
    let mut targets = HashSet::new();
    for node in nodes {
        let file = primary_file(&node.version)?;
        let keep = locals
            .iter()
            .find(|entry| {
                entry.enabled == node.enabled
                    && entry.hash.eq_ignore_ascii_case(&file.hashes.sha512)
                    && entry
                        .version
                        .as_ref()
                        .is_some_and(|v| v.project_id == node.version.project_id)
            })
            .map(|e| e.file_name.clone());
        let destination = keep.clone().unwrap_or_else(|| {
            format!(
                "{}{}",
                file.filename,
                if node.enabled { "" } else { ".disabled" }
            )
        });
        validate_id(&destination)?;
        if !targets.insert(destination.to_lowercase()) {
            return Err("两个依赖项目需要同名文件，无法安全安装".into());
        }
        if locals.iter().any(|entry| {
            entry.file_name.eq_ignore_ascii_case(&destination)
                && entry
                    .version
                    .as_ref()
                    .is_some_and(|v| v.project_id != node.version.project_id)
        }) {
            return Err(format!("目标文件 {destination} 属于其它项目，未替换该文件"));
        }
        let remove = locals
            .iter()
            .filter(|entry| {
                entry
                    .version
                    .as_ref()
                    .is_some_and(|v| v.project_id == node.version.project_id)
                    && keep.as_deref() != Some(entry.file_name.as_str())
            })
            .map(|entry| entry.file_name.clone())
            .collect();
        output.push(Action {
            node,
            destination,
            keep,
            remove,
        });
    }
    Ok(output)
}

fn history_root(directory: &Path) -> Result<PathBuf, String> {
    checked_absolute(directory)?;
    let parent = directory.parent().ok_or("资源目录无效")?;
    let name = directory
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("资源目录标识无效")?;
    safe_join(parent, &format!(".launcher-resource-history/{name}"))
}
fn journal_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "资源事务标识无效")?;
    safe_join(root, &format!("{id}/journal.json"))
}
fn save_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    checked_absolute(path)?;
    let parent = path.parent().ok_or("事务日志目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = safe_join(parent, &format!(".journal-{}.tmp", uuid::Uuid::new_v4()))?;
    fs::write(
        &temp,
        serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn read_journal(path: &Path, directory: &Path) -> Result<Journal, String> {
    checked_absolute(path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_METADATA_BYTES as u64 {
        return Err("资源事务日志过大".into());
    }
    let journal: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "资源事务日志无效")?;
    if Path::new(&journal.directory) != directory {
        return Err("资源事务目标目录校验失败".into());
    }
    Ok(journal)
}
fn inventory(directory: &Path) -> Result<Vec<FileRecord>, String> {
    if directory.exists() {
        collect_files(directory)
    } else {
        Ok(Vec::new())
    }
}

/// Commit cannot be cancelled between the two directory renames.
fn commit_using(
    directory: &Path,
    transaction: &Path,
    path: &Path,
    journal: &mut Journal,
    publish: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    checked_absolute(directory)?;
    checked_absolute(transaction)?;
    let next = safe_join(transaction, "next")?;
    let before = safe_join(transaction, "before")?;
    if inventory(directory)? != journal.before || directory.exists() != journal.before_exists {
        return Err("下载期间原资源目录发生变化，已停止提交".into());
    }
    if inventory(&next)? != journal.after {
        return Err("暂存目录校验失败，原资源未改变".into());
    }
    if before.exists() {
        return Err("事务备份目录已存在，原资源未改变".into());
    }
    journal.status = "committing".into();
    save_journal(path, journal)?;
    if journal.before_exists {
        if let Err(error) = fs::rename(directory, &before) {
            journal.status = "failed".into();
            let _ = save_journal(path, journal);
            return Err(format!(
                "资源目录被占用或无重命名权限，原目录未改变：{error}。请关闭游戏后重试。"
            ));
        }
    }
    if let Err(error) = publish(&next, directory) {
        let rollback = if journal.before_exists {
            fs::rename(&before, directory)
        } else {
            Ok(())
        };
        journal.status = if rollback.is_ok() {
            "failed"
        } else {
            "recoveryRequired"
        }
        .into();
        let _ = save_journal(path, journal);
        return Err(format!(
            "提交资源失败，{}：{error}",
            if rollback.is_ok() {
                "原目录已恢复"
            } else {
                "需从事务 before 目录恢复，所有副本已保留"
            }
        ));
    }
    journal.status = "committed".into();
    if let Err(error) = save_journal(path, journal) {
        let failed = safe_join(transaction, "uncommitted")?;
        let move_new = fs::rename(directory, &failed);
        let restored =
            move_new.is_ok() && (!journal.before_exists || fs::rename(&before, directory).is_ok());
        return Err(format!(
            "资源事务日志写入失败，{}：{error}",
            if restored {
                "已回滚原目录"
            } else {
                "副本已保留，需手动恢复"
            }
        ));
    }
    Ok(())
}

pub(super) fn recover(directory: &Path) -> Result<(), String> {
    let root = history_root(directory)?;
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let folder = entry.map_err(|e| e.to_string())?.path();
        checked_absolute(&folder)?;
        let path = folder.join("journal.json");
        if !path.is_file() {
            continue;
        }
        let mut journal = read_journal(&path, directory)?;
        if !["committing", "recoveryRequired"].contains(&journal.status.as_str()) {
            continue;
        }
        let before = safe_join(&folder, "before")?;
        if directory.exists() {
            if inventory(directory)? != journal.after {
                return Err(format!(
                    "检测到未完成事务 {}，当前资源已变化；已保留 before 备份，请先手动恢复",
                    journal.id
                ));
            }
            let interrupted = safe_join(&folder, "interrupted")?;
            if interrupted.exists() {
                return Err("中断事务的恢复副本已存在，请手动检查".into());
            }
            fs::rename(directory, interrupted).map_err(|e| format!("无法保留中断后的目录：{e}"))?;
        }
        if journal.before_exists {
            if !before.exists() || inventory(&before)? != journal.before {
                return Err("中断事务的原始备份校验失败，停止恢复".into());
            }
            fs::rename(&before, directory).map_err(|e| format!("无法恢复中断前目录：{e}"))?;
        }
        journal.status = "recovered".into();
        save_journal(&path, &journal)?;
    }
    Ok(())
}

pub(super) async fn install(
    state: &Arc<LauncherState>,
    directory: &Path,
    minecraft: &str,
    loader: Option<&str>,
    name: &str,
    selected: Version,
    kind: ResourceKind,
    enabled: bool,
) -> Result<ResourceInstall, String> {
    recover(directory)?;
    let api = client(false)?;
    let locals = scan(state, &api, directory, kind).await?;
    let root_project = selected.project_id.clone();
    let nodes = resolve_plan(
        state, &api, selected, enabled, &locals, minecraft, loader, kind,
    )
    .await?;
    let plan = actions(nodes, &locals)?;
    let root_action = plan
        .iter()
        .find(|a| a.node.version.project_id == root_project)
        .ok_or("缺少根资源计划")?;
    let root_filename = root_action.destination.clone();
    if plan.iter().all(|a| a.keep.is_some() && a.remove.is_empty()) {
        return Ok(ResourceInstall {
            name: name.into(),
            file_name: root_filename.clone(),
            path: directory.join(root_filename).to_string_lossy().into_owned(),
            warning: Some("资源及其必需前置已是选定版本。".into()),
            update_id: None,
        });
    }
    let root = history_root(directory)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let transaction = safe_join(&root, &id)?;
    fs::create_dir_all(&transaction).map_err(|e| e.to_string())?;
    let next = safe_join(&transaction, "next")?;
    let before_exists = directory.exists();
    let before = inventory(directory)?;
    let copied = before.clone();
    let source = directory.to_owned();
    let destination = next.clone();
    let arc = state.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        for record in &copied {
            crate::instances::sync_checkpoint(&arc)?;
            let from = safe_join(&source, &record.relative)?;
            let to = safe_join(&destination, &record.relative)?;
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(from, to).map_err(|e| e.to_string())?;
        }
        if inventory(&destination)? != copied {
            return Err("资源暂存副本校验失败".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let removed = safe_join(&transaction, "staged-replaced")?;
    fs::create_dir_all(&removed).map_err(|e| e.to_string())?;
    let mut changed = 0;
    for action in &plan {
        state.control.checkpoint().await?;
        for file in &action.remove {
            let from = safe_join(&next, file)?;
            let to = safe_join(&removed, file)?;
            if from.is_file() {
                fs::rename(from, to).map_err(|e| e.to_string())?;
            }
        }
        if action.keep.is_some() {
            continue;
        }
        let file = primary_file(&action.node.version)?;
        let raw = safe_join(&next, &file.filename)?;
        if raw.exists() {
            if !raw.is_file() {
                return Err("下载目标与原目录中的文件夹冲突，原目录未改变".into());
            }
            let alternate = safe_join(
                &removed,
                &format!("{}-{}", uuid::Uuid::new_v4(), file.filename),
            )?;
            fs::rename(&raw, alternate).map_err(|e| e.to_string())?;
        }
        let installed = download_verified(state, file, &next, kind).await?;
        if action.destination != file.filename {
            let target = safe_join(&next, &action.destination)?;
            if target.exists() {
                let alternate = safe_join(&removed, &format!("{}-disabled", uuid::Uuid::new_v4()))?;
                fs::rename(&target, alternate).map_err(|e| e.to_string())?;
            }
            fs::rename(installed, target).map_err(|e| e.to_string())?;
        }
        changed += 1;
    }
    state.control.checkpoint().await?;
    let after = inventory(&next)?;
    let mut journal = Journal {
        id: id.clone(),
        name: name.into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        status: "staged".into(),
        directory: directory.to_string_lossy().into_owned(),
        projects: plan
            .iter()
            .map(|a| a.node.version.project_id.clone())
            .collect(),
        before_exists,
        before,
        after,
    };
    let path = journal_path(&root, &id)?;
    save_journal(&path, &journal)?;
    commit_using(directory, &transaction, &path, &mut journal, |from, to| {
        fs::rename(from, to)
    })?;
    let dependency_count = plan.len().saturating_sub(1);
    let mut notices = Vec::new();
    if dependency_count > 0 {
        notices.push(format!(
            "已校验 {dependency_count} 个必需前置，本次新增或更新 {changed} 个资源"
        ));
    }
    if kind == ResourceKind::Shader {
        notices.push("光影仍需在游戏中配合 Iris、OptiFine 或兼容加载器启用".into());
    }
    Ok(ResourceInstall {
        name: name.into(),
        file_name: root_filename.clone(),
        path: directory.join(root_filename).to_string_lossy().into_owned(),
        warning: (!notices.is_empty()).then(|| notices.join("；")),
        update_id: Some(id),
    })
}

pub(super) async fn updates(
    state: &LauncherState,
    directory: &Path,
    minecraft: &str,
    loader: Option<&str>,
    kind: ResourceKind,
) -> Result<Vec<ResourceUpdate>, String> {
    recover(directory)?;
    let api = client(false)?;
    let locals = scan(state, &api, directory, kind).await?;
    let mut results = Vec::new();
    let mut cache = HashMap::<String, Option<Version>>::new();
    for entry in locals {
        state.control.checkpoint().await?;
        let Some(current) = entry.version else {
            continue;
        };
        if !cache.contains_key(&current.project_id) {
            cache.insert(
                current.project_id.clone(),
                latest(project_versions(&api, &current.project_id, minecraft, loader).await?),
            );
        }
        let Some(new) = cache.get(&current.project_id).and_then(Option::as_ref) else {
            continue;
        };
        if new.id == current.id
            || primary_file(new)?
                .hashes
                .sha512
                .eq_ignore_ascii_case(&entry.hash)
        {
            continue;
        }
        results.push(ResourceUpdate {
            file_name: entry.file_name,
            name: if new.name.is_empty() {
                current.project_id.clone()
            } else {
                new.name.clone()
            },
            current_version: if current.version_number.is_empty() {
                current.id
            } else {
                current.version_number
            },
            new_version: if new.version_number.is_empty() {
                new.id.clone()
            } else {
                new.version_number.clone()
            },
            project_id: current.project_id,
            new_version_id: new.id.clone(),
            enabled: entry.enabled,
        });
    }
    Ok(results)
}

pub(super) async fn update_one(
    state: &Arc<LauncherState>,
    directory: &Path,
    minecraft: &str,
    loader: Option<&str>,
    kind: ResourceKind,
    file_name: &str,
    new_id: &str,
) -> Result<ResourceInstall, String> {
    validate_id(file_name)?;
    identifier(new_id)?;
    recover(directory)?;
    let api = client(false)?;
    let locals = scan(state, &api, directory, kind).await?;
    let current = locals
        .iter()
        .find(|entry| entry.file_name == file_name)
        .ok_or("待更新资源不存在")?;
    let current_version = current
        .version
        .as_ref()
        .ok_or("无法识别此文件的 Modrinth 身份，未知资源不会被自动替换")?;
    let new: Version = api_json(&api, &format!("version/{new_id}"), &[]).await?;
    if new.project_id != current_version.project_id || !compatible(&new, minecraft, loader) {
        return Err("更新版本与当前项目、Minecraft 或加载器不一致".into());
    }
    let name = if new.name.is_empty() {
        new.project_id.clone()
    } else {
        new.name.clone()
    };
    install(
        state,
        directory,
        minecraft,
        loader,
        &name,
        new,
        kind,
        current.enabled,
    )
    .await
}

pub(super) fn history(directory: &Path) -> Result<Vec<ResourceHistory>, String> {
    recover(directory)?;
    let root = history_root(directory)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let folder = entry.map_err(|e| e.to_string())?.path();
        checked_absolute(&folder)?;
        let path = folder.join("journal.json");
        if !path.is_file() {
            continue;
        }
        let journal = read_journal(&path, directory)?;
        output.push(ResourceHistory {
            update_id: journal.id,
            name: journal.name,
            created_at: journal.created_at,
            status: journal.status,
            projects: journal.projects,
        });
    }
    output.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(output)
}

pub(super) fn rollback(directory: &Path, id: &str) -> Result<RollbackResult, String> {
    recover(directory)?;
    let root = history_root(directory)?;
    let path = journal_path(&root, id)?;
    let mut journal = read_journal(&path, directory)?;
    if journal.status != "committed" {
        return Err("此资源事务已经回滚或未成功提交".into());
    }
    if inventory(directory)? != journal.after {
        return Err("资源目录在该操作后发生变化。为保留后来添加或修改的文件，拒绝自动回滚；旧目录仍完整保存在历史记录的 before 中。".into());
    }
    let transaction = path.parent().ok_or("事务目录无效")?;
    let before = safe_join(transaction, "before")?;
    if journal.before_exists && inventory(&before)? != journal.before {
        return Err("原始资源备份校验失败，未改变当前目录".into());
    }
    let forward = safe_join(transaction, "rolled-forward")?;
    if forward.exists() {
        return Err("回滚副本已存在，未覆盖当前目录".into());
    }
    journal.status = "rollingBack".into();
    save_journal(&path, &journal)?;
    if let Err(error) = fs::rename(directory, &forward) {
        journal.status = "committed".into();
        save_journal(&path, &journal)?;
        return Err(format!("无法保留回滚前资源，请关闭游戏后重试：{error}"));
    }
    if journal.before_exists {
        if let Err(error) = fs::rename(&before, directory) {
            let _ = fs::rename(&forward, directory);
            journal.status = "committed".into();
            let _ = save_journal(&path, &journal);
            return Err(format!("无法恢复原始资源，已尝试退回当前版本：{error}"));
        }
    } else {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    }
    journal.status = "rolledBack".into();
    save_journal(&path, &journal)?;
    Ok(RollbackResult {
        update_id: id.into(),
        restored_files: journal.before.len(),
        status: journal.status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/resource-transaction-tests")
            .join(uuid::Uuid::new_v4().to_string())
    }
    fn cleanup(path: &Path) {
        let parent =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-transaction-tests");
        assert!(
            path.is_absolute()
                && path.starts_with(parent)
                && path.file_name().unwrap().to_string_lossy().len() == 36
        );
        fs::remove_dir_all(path).unwrap();
    }
    fn setup() -> (PathBuf, PathBuf, PathBuf, PathBuf, Journal) {
        let root = root();
        let directory = root.join("mods");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("unknown-user.jar"), b"private user jar").unwrap();
        fs::write(directory.join("old.jar"), b"old").unwrap();
        let history = history_root(&directory).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let transaction = history.join(&id);
        let next = transaction.join("next");
        fs::create_dir_all(&next).unwrap();
        fs::write(next.join("unknown-user.jar"), b"private user jar").unwrap();
        fs::write(next.join("new.jar"), b"new").unwrap();
        let journal = Journal {
            id: id.clone(),
            name: "Update".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            status: "staged".into(),
            directory: directory.to_string_lossy().into_owned(),
            projects: vec!["project".into()],
            before_exists: true,
            before: inventory(&directory).unwrap(),
            after: inventory(&next).unwrap(),
        };
        let path = journal_path(&history, &id).unwrap();
        (root, directory, transaction, path, journal)
    }
    #[test]
    fn real_directory_commit_and_rollback_preserve_unknown_jars() {
        let (root, directory, transaction, path, mut journal) = setup();
        commit_using(&directory, &transaction, &path, &mut journal, |a, b| {
            fs::rename(a, b)
        })
        .unwrap();
        assert!(directory.join("new.jar").is_file());
        assert!(!directory.join("old.jar").exists());
        assert_eq!(
            fs::read(directory.join("unknown-user.jar")).unwrap(),
            b"private user jar"
        );
        rollback(&directory, &journal.id).unwrap();
        assert!(directory.join("old.jar").is_file());
        assert!(!directory.join("new.jar").exists());
        assert_eq!(
            fs::read(directory.join("unknown-user.jar")).unwrap(),
            b"private user jar"
        );
        cleanup(&root);
    }
    #[test]
    fn publishing_failure_restores_the_complete_original_directory() {
        let (root, directory, transaction, path, mut journal) = setup();
        assert!(
            commit_using(&directory, &transaction, &path, &mut journal, |_, _| Err(
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated publish failure"
                )
            ))
            .is_err()
        );
        assert!(directory.join("old.jar").is_file());
        assert!(!directory.join("new.jar").exists());
        assert_eq!(
            fs::read(directory.join("unknown-user.jar")).unwrap(),
            b"private user jar"
        );
        cleanup(&root);
    }
    #[test]
    fn rollback_never_discards_files_added_after_an_update() {
        let (root, directory, transaction, path, mut journal) = setup();
        commit_using(&directory, &transaction, &path, &mut journal, |a, b| {
            fs::rename(a, b)
        })
        .unwrap();
        fs::write(directory.join("another-user.jar"), b"later user data").unwrap();
        assert!(rollback(&directory, &journal.id).is_err());
        assert_eq!(
            fs::read(directory.join("another-user.jar")).unwrap(),
            b"later user data"
        );
        cleanup(&root);
    }
    #[cfg(windows)]
    #[test]
    fn occupied_directory_leaves_rollback_retryable() {
        use std::os::windows::fs::OpenOptionsExt;
        let (root, directory, transaction, path, mut journal) = setup();
        commit_using(&directory, &transaction, &path, &mut journal, |a, b| {
            fs::rename(a, b)
        })
        .unwrap();
        let occupied = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x3)
            .open(directory.join("unknown-user.jar"))
            .unwrap();
        assert!(rollback(&directory, &journal.id).is_err());
        drop(occupied);
        assert!(directory.join("new.jar").is_file());
        rollback(&directory, &journal.id).unwrap();
        assert!(directory.join("old.jar").is_file());
        cleanup(&root);
    }
    #[test]
    fn circular_required_dependencies_are_rejected() {
        let graph = HashMap::from([
            ("a".into(), vec!["b".into()]),
            ("b".into(), vec!["a".into()]),
        ]);
        assert!(check_cycle(&graph).is_err());
    }
}
