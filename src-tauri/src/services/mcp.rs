use indexmap::IndexMap;
use std::collections::HashMap;

use crate::app_config::{AppType, McpServer};
use crate::error::AppError;
use crate::mcp;
use crate::store::AppState;

/// MCP 相关业务逻辑（v3.7.0 统一结构）
pub struct McpService;

/// 「重新同步到各应用」里单个应用的结果
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppSyncOutcome {
    pub app: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpService {
    /// 获取所有 MCP 服务器（统一结构）
    pub fn get_all_servers(state: &AppState) -> Result<IndexMap<String, McpServer>, AppError> {
        state.db.get_all_mcp_servers()
    }

    /// 添加或更新 MCP 服务器
    pub fn upsert_server(state: &AppState, server: McpServer) -> Result<(), AppError> {
        // 读取旧状态：用于处理“编辑时取消勾选某个应用”的场景（需要从对应 live 配置中移除）
        let prev_apps = state
            .db
            .get_all_mcp_servers()?
            .get(&server.id)
            .map(|s| s.apps.clone())
            .unwrap_or_default();

        // MCode / Pi 的文件和数据库一起提交：任一步失败都恢复原样
        let save_with_pi = || {
            if server.apps.pi || prev_apps.pi {
                mcp::pi::sync_and_commit(
                    &server.id,
                    mcp::pi::PiChange::from_enabled(server.apps.pi.then_some(&server.server)),
                    || state.db.save_mcp_server(&server),
                )
            } else {
                state.db.save_mcp_server(&server)
            }
        };
        if server.apps.mcode || prev_apps.mcode {
            mcp::mcode::sync_and_commit(
                &server.id,
                server.apps.mcode.then_some(&server.server),
                save_with_pi,
            )?;
        } else {
            save_with_pi()?;
        }

        // 处理禁用：若旧版本启用但新版本取消，则需要从该应用的 live 配置移除
        if prev_apps.claude && !server.apps.claude {
            Self::remove_server_from_app(state, &server.id, &AppType::Claude)?;
        }
        if prev_apps.codex && !server.apps.codex {
            Self::remove_server_from_app(state, &server.id, &AppType::Codex)?;
        }
        if prev_apps.gemini && !server.apps.gemini {
            Self::remove_server_from_app(state, &server.id, &AppType::Gemini)?;
        }
        if prev_apps.grokbuild && !server.apps.grokbuild {
            Self::remove_server_from_app(state, &server.id, &AppType::GrokBuild)?;
        }
        if prev_apps.opencode && !server.apps.opencode {
            Self::remove_server_from_app(state, &server.id, &AppType::OpenCode)?;
        }
        if prev_apps.hermes && !server.apps.hermes {
            Self::remove_server_from_app(state, &server.id, &AppType::Hermes)?;
        }

        // 同步到各个启用的应用
        Self::sync_server_to_apps(state, &server)?;

        Ok(())
    }

    /// 删除 MCP 服务器
    pub fn delete_server(state: &AppState, id: &str) -> Result<bool, AppError> {
        let server = state.db.get_all_mcp_servers()?.shift_remove(id);

        if let Some(server) = server {
            let delete_with_pi = || {
                if server.apps.pi {
                    mcp::pi::sync_and_commit(id, mcp::pi::PiChange::Remove, || {
                        state.db.delete_mcp_server(id)
                    })
                } else {
                    state.db.delete_mcp_server(id)
                }
            };
            if server.apps.mcode {
                mcp::mcode::sync_and_commit(id, None, delete_with_pi)?;
            } else {
                delete_with_pi()?;
            }
            if !server.apps.pi {
                // 取消勾选只在 Pi 里禁用、条目还留着：服务器删了就一并清掉（尽力而为）
                if let Err(err) = mcp::pi::remove_disabled_if_managed(id, &server.server) {
                    log::warn!("清理 Pi 中已禁用的 MCP 条目 '{id}' 失败: {err}");
                }
            }

            // 从所有应用的 live 配置中移除
            Self::remove_server_from_all_apps(state, id, &server)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 切换指定应用的启用状态
    pub fn toggle_app(
        state: &AppState,
        server_id: &str,
        app: AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::Mcode | AppType::Pi) {
            if let Some(server) = state.db.get_all_mcp_servers()?.get(server_id) {
                let spec = enabled.then_some(&server.server);
                let commit = || {
                    state
                        .db
                        .update_mcp_server_app_enabled(server_id, &app, enabled)
                };
                if app == AppType::Mcode {
                    mcp::mcode::sync_and_commit(server_id, spec, commit)?;
                } else {
                    mcp::pi::sync_and_commit(
                        server_id,
                        mcp::pi::PiChange::from_enabled(spec),
                        commit,
                    )?;
                }
            }
            return Ok(());
        }
        if let Some(server) = state
            .db
            .update_mcp_server_app_enabled(server_id, &app, enabled)?
        {
            // 同步到对应应用
            if enabled {
                Self::sync_server_to_app(state, &server, &app)?;
            } else {
                Self::remove_server_from_app(state, server_id, &app)?;
            }
        }

        Ok(())
    }

    /// 将 MCP 服务器同步到所有启用的应用
    fn sync_server_to_apps(state: &AppState, server: &McpServer) -> Result<(), AppError> {
        let mut projection = RouterProjection::begin(state);
        for app in server.apps.enabled_apps() {
            if matches!(app, AppType::Mcode | AppType::Pi) {
                continue; // Already written before saving the managed state.
            }
            projection.sync(server, &app)?;
        }
        projection.commit();
        Ok(())
    }

    /// 将 MCP 服务器同步到指定应用
    fn sync_server_to_app(
        state: &AppState,
        server: &McpServer,
        app: &AppType,
    ) -> Result<(), AppError> {
        let mut projection = RouterProjection::begin(state);
        projection.sync(server, app)?;
        projection.commit();
        Ok(())
    }

    fn sync_id_to_app(app: &AppType, id: &str, spec: &serde_json::Value) -> Result<(), AppError> {
        match app {
            AppType::Claude => {
                mcp::sync_single_server_to_claude(&Default::default(), id, spec)?;
            }
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use PHI MCP sync, skipping");
            }
            AppType::Codex => {
                // Codex uses TOML format, must use the correct function
                mcp::sync_single_server_to_codex(&Default::default(), id, spec)?;
            }
            AppType::Gemini => {
                mcp::sync_single_server_to_gemini(&Default::default(), id, spec)?;
            }
            AppType::GrokBuild => {
                mcp::sync_single_server_to_grokbuild(&Default::default(), id, spec)?;
            }
            AppType::OpenCode => {
                mcp::sync_single_server_to_opencode(&Default::default(), id, spec)?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development (Issue #4834)
                // Skip for now
                log::debug!("OpenClaw MCP support is still in development, skipping sync");
            }
            AppType::Hermes => {
                mcp::sync_single_server_to_hermes(&Default::default(), id, spec)?;
            }
            AppType::Mcode => mcp::mcode::sync(id, Some(spec))?,
            AppType::Pi => mcp::pi::sync(id, Some(spec))?,
            AppType::Zcode => {
                // ZCode 暂不支持 PHI 的 MCP 注入
                log::debug!("ZCode MCP sync is not supported yet, skipping");
            }
        }
        Ok(())
    }

    /// 从所有曾启用过该服务器的应用中移除
    fn remove_server_from_all_apps(
        state: &AppState,
        id: &str,
        server: &McpServer,
    ) -> Result<(), AppError> {
        let mut projection = RouterProjection::begin(state);
        // 从所有曾启用的应用中移除
        for app in server.apps.enabled_apps() {
            if matches!(app, AppType::Mcode | AppType::Pi) {
                continue; // Already removed before deleting the managed record.
            }
            projection.remove(id, &app, true)?;
        }
        // 服务器没了，账本里也不该再有它。
        projection.forget_server(id);
        projection.commit();
        Ok(())
    }

    fn remove_server_from_app(state: &AppState, id: &str, app: &AppType) -> Result<(), AppError> {
        let mut projection = RouterProjection::begin(state);
        projection.remove(id, app, true)?;
        projection.commit();
        Ok(())
    }

    fn remove_id_from_app(app: &AppType, id: &str) -> Result<(), AppError> {
        match app {
            AppType::Claude => mcp::remove_server_from_claude(id)?,
            AppType::ClaudeDesktop => {
                log::debug!("Claude Desktop 3P profiles do not use PHI MCP sync, skipping");
            }
            AppType::Codex => mcp::remove_server_from_codex(id)?,
            AppType::Gemini => mcp::remove_server_from_gemini(id)?,
            AppType::GrokBuild => mcp::remove_server_from_grokbuild(id)?,
            AppType::OpenCode => {
                mcp::remove_server_from_opencode(id)?;
            }
            AppType::OpenClaw => {
                // OpenClaw MCP support is still in development
                log::debug!("OpenClaw MCP support is still in development, skipping remove");
            }
            AppType::Hermes => {
                mcp::remove_server_from_hermes(id)?;
            }
            AppType::Mcode => mcp::mcode::sync(id, None)?,
            AppType::Pi => mcp::pi::sync(id, None)?,
            AppType::Zcode => {
                // ZCode 暂不支持 PHI 的 MCP 注入
                log::debug!("ZCode MCP remove is not supported yet, skipping");
            }
        }
        Ok(())
    }

    /// 路由配置保存后立刻重投影到所有受管客户端。
    ///
    /// 少了这一步，用户改完别名要等下一次无关的 MCP 同步才看到效果；
    /// 单条失败已经由 `sync_all_enabled` 聚合成错误，调用方按「保存成功、
    /// 应用失败」分别上报。
    pub fn apply_router_config(state: &AppState) -> Result<(), AppError> {
        Self::sync_all_enabled(state)
    }

    /// 手动同步所有启用的 MCP 服务器到对应的应用。
    ///
    /// Best-effort：单个应用投影失败（如 ~/.claude.json 坏 JSON）不阻断
    /// 其余应用——各应用的 live 文件互相独立，一处损坏没有理由让其他
    /// 应用的 MCP 状态陈旧。全部跑完后若有失败，聚合成一个错误上报，
    /// 保留调用方的可见性。
    pub fn sync_all_enabled(state: &AppState) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        let mut failures: Vec<String> = Vec::new();
        for app in AppType::all() {
            if let Err(err) = Self::project_servers_to_app(state, &servers, &app) {
                log::warn!("同步 MCP 到 {app:?} 失败: {err}");
                failures.push(format!("{}: {err}", app.as_str()));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message(format!(
                "部分应用 MCP 同步失败: {}",
                failures.join("; ")
            )))
        }
    }

    /// 只把启用状态投影到单个应用。某个应用的 live 被整体重写后用它做
    /// 定向重投影，避免把无关应用的失败面（如 ~/.claude.json 坏 JSON）
    /// 牵连进目标应用的关键路径。
    pub fn sync_enabled_for_app(state: &AppState, app: &AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;
        Self::project_servers_to_app(state, &servers, app)
    }

    /// 由 PHI 管理 MCP 的应用（Claude Desktop、OpenClaw 不支持）
    pub fn live_sync_apps() -> Vec<AppType> {
        AppType::all()
            .filter(|app| !matches!(app, AppType::OpenClaw | AppType::ClaudeDesktop))
            .collect()
    }

    /// 解析「重新同步」的目标应用：缺省或空列表＝全部受管应用；
    /// 不认识或不支持 MCP 的应用直接报错，不静默跳过。
    pub fn resync_targets(apps: Option<&[String]>) -> Result<Vec<AppType>, AppError> {
        let managed = Self::live_sync_apps();
        let Some(apps) = apps.filter(|apps| !apps.is_empty()) else {
            return Ok(managed);
        };
        let mut targets = Vec::new();
        for raw in apps {
            let app = <AppType as std::str::FromStr>::from_str(raw)?;
            if !managed.contains(&app) {
                return Err(AppError::Message(format!(
                    "{} 不支持由 PHI 管理 MCP",
                    app.as_str()
                )));
            }
            if !targets.contains(&app) {
                targets.push(app);
            }
        }
        Ok(targets)
    }

    /// 把数据库里的启用状态重新投影到一个应用的 live 配置，结果按应用报告。
    /// 调用方负责先拿这个应用的切换锁。
    pub fn resync_app(state: &AppState, app: &AppType) -> McpAppSyncOutcome {
        match Self::sync_enabled_for_app(state, app) {
            Ok(()) => McpAppSyncOutcome {
                app: app.as_str().to_string(),
                ok: true,
                error: None,
            },
            Err(err) => {
                log::warn!("重新同步 MCP 到 {app:?} 失败: {err}");
                McpAppSyncOutcome {
                    app: app.as_str().to_string(),
                    ok: false,
                    error: Some(err.to_string()),
                }
            }
        }
    }

    fn project_servers_to_app(
        state: &AppState,
        servers: &IndexMap<String, McpServer>,
        app: &AppType,
    ) -> Result<(), AppError> {
        if matches!(app, AppType::OpenClaw | AppType::ClaudeDesktop) {
            return Ok(());
        }

        // 逐条容错：一条写不进去（规范不是对象、这个应用不认的类型）不该让排在
        // 它后面的服务器全都停在旧状态。全部跑完后聚合上报，调用方照旧能看到
        // 失败。错误相同的条目归并成一项：live 文件本身损坏时每一条都报同一句。
        //
        // 顺序是契约：先清掉所有不该出现的条目（禁用、路由隐藏、撞名落败），再写
        // 该出现的。反过来会让「先写入的胜出者」被后面失败方的清理删掉。
        let mut failures: IndexMap<String, Vec<&str>> = IndexMap::new();
        let mut projection = RouterProjection::begin(state);
        let mut to_sync: Vec<&McpServer> = Vec::new();
        for server in servers.values() {
            let enabled_here = server.apps.is_enabled_for(app);
            if enabled_here && projection.allows(app, &server.id) {
                to_sync.push(server);
            } else if matches!(app, AppType::Mcode | AppType::Pi) {
                // MCode / Pi's false flag also covers pre-existing, unmanaged servers.
                // Only explicit disable/delete operations may remove those entries.
            } else if let Err(err) = projection.remove(&server.id, app, !enabled_here) {
                log::warn!("清理 MCP 服务器 '{}' 于 {app:?} 失败: {err}", server.id);
                failures
                    .entry(err.to_string())
                    .or_default()
                    .push(&server.id);
            }
        }
        for server in to_sync {
            if let Err(err) = projection.sync(server, app) {
                log::warn!("同步 MCP 服务器 '{}' 到 {app:?} 失败: {err}", server.id);
                failures
                    .entry(err.to_string())
                    .or_default()
                    .push(&server.id);
            }
        }
        projection.commit();

        if failures.is_empty() {
            return Ok(());
        }
        let detail = failures
            .iter()
            .map(|(error, ids)| format!("{}: {error}", ids.join(", ")))
            .collect::<Vec<_>>()
            .join("; ");
        Err(AppError::Message(format!(
            "部分 MCP 服务器同步到 {} 失败: {detail}",
            app.as_str()
        )))
    }

    // ========================================================================
    // 兼容层：支持旧的 v3.6.x 命令（已废弃，将在 v4.0 移除）
    // ========================================================================

    /// [已废弃] 获取指定应用的 MCP 服务器（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use get_all_servers instead")]
    pub fn get_servers(
        state: &AppState,
        app: AppType,
    ) -> Result<HashMap<String, serde_json::Value>, AppError> {
        let all_servers = Self::get_all_servers(state)?;
        let mut result = HashMap::new();

        for (id, server) in all_servers {
            if server.apps.is_enabled_for(&app) {
                result.insert(id, server.server);
            }
        }

        Ok(result)
    }

    /// [已废弃] 设置 MCP 服务器在指定应用的启用状态（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use toggle_app instead")]
    pub fn set_enabled(
        state: &AppState,
        app: AppType,
        id: &str,
        enabled: bool,
    ) -> Result<bool, AppError> {
        Self::toggle_app(state, id, app, enabled)?;
        Ok(true)
    }

    /// [已废弃] 同步启用的 MCP 到指定应用（兼容旧 API）
    #[deprecated(since = "3.7.0", note = "Use sync_all_enabled instead")]
    pub fn sync_enabled(state: &AppState, app: AppType) -> Result<(), AppError> {
        let servers = Self::get_all_servers(state)?;

        for server in servers.values() {
            if server.apps.is_enabled_for(&app) {
                Self::sync_server_to_app(state, server, &app)?;
            }
        }

        Ok(())
    }

    /// 从 Claude 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_claude(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_claude(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Claude，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.claude = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Codex 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_codex(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_codex(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Codex，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.codex = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Gemini 导入 MCP（v3.7.0 已更新为统一结构）
    pub fn import_from_gemini(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp.rs）
        let count = crate::mcp::import_from_gemini(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Gemini，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.gemini = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Grok Build 的 `[mcp_servers]` 导入 MCP。
    pub fn import_from_grokbuild(state: &AppState) -> Result<usize, AppError> {
        let mut temp_config = crate::app_config::MultiAppConfig::default();
        let count = crate::mcp::import_from_grokbuild(&mut temp_config)?;
        let mut new_count = 0;

        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.grokbuild = true;
                        merged
                    } else {
                        new_count += 1;
                        server.clone()
                    };
                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save);
                }
            }
        }
        Ok(new_count)
    }

    /// 从 OpenCode 导入 MCP（v3.9.2+ 新增）
    pub fn import_from_opencode(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用原有的导入逻辑（从 mcp/opencode.rs）
        let count = crate::mcp::import_from_opencode(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 OpenCode，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.opencode = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从 Hermes 导入 MCP
    pub fn import_from_hermes(state: &AppState) -> Result<usize, AppError> {
        // 创建临时 MultiAppConfig 用于导入
        let mut temp_config = crate::app_config::MultiAppConfig::default();

        // 调用导入逻辑（从 mcp/hermes.rs）
        let count = crate::mcp::import_from_hermes(&mut temp_config)?;

        let mut new_count = 0;

        // 如果有导入的服务器，保存到数据库
        if count > 0 {
            if let Some(servers) = &temp_config.mcp.servers {
                let mut existing = state.db.get_all_mcp_servers()?;
                for server in servers.values() {
                    // 已存在：仅启用 Hermes，不覆盖其他字段（与导入模块语义保持一致）
                    let to_save = if let Some(existing_server) = existing.get(&server.id) {
                        let mut merged = existing_server.clone();
                        merged.apps.hermes = true;
                        merged
                    } else {
                        // 真正的新服务器
                        new_count += 1;
                        server.clone()
                    };

                    state.db.save_mcp_server(&to_save)?;
                    existing.insert(to_save.id.clone(), to_save.clone());

                    // 导入是读取已有配置，不应反向写回任何应用的 live 配置。
                    // 显式编辑、启用/禁用或手动同步时再执行写回。
                }
            }
        }

        Ok(new_count)
    }

    /// 从所有支持 MCP 的应用导入服务器，返回新导入的数量。
    ///
    /// Best-effort：单个应用导入失败（如坏 config.toml）不阻断其余应用；
    /// 全部跑完后若有失败，聚合成一个错误上报——历史实现逐应用
    /// `unwrap_or(0)` 吞错，坏文件只会表现为"导入成功 0 个"，用户
    /// 无从得知哪个应用出了问题。
    pub fn import_from_all_apps(state: &AppState) -> Result<usize, AppError> {
        let mut total = 0;
        let mut failures: Vec<String> = Vec::new();

        let results: [(&str, Result<usize, AppError>); 8] = [
            ("claude", Self::import_from_claude(state)),
            ("codex", Self::import_from_codex(state)),
            ("gemini", Self::import_from_gemini(state)),
            ("grokbuild", Self::import_from_grokbuild(state)),
            ("opencode", Self::import_from_opencode(state)),
            ("hermes", Self::import_from_hermes(state)),
            ("mcode", mcp::mcode::import(state)),
            ("pi", mcp::pi::import(state)),
        ];
        for (app, result) in results {
            match result {
                Ok(count) => total += count,
                Err(err) => {
                    log::warn!("从 {app} 导入 MCP 失败: {err}");
                    failures.push(format!("{app}: {err}"));
                }
            }
        }

        if failures.is_empty() {
            Ok(total)
        } else {
            Err(AppError::Message(format!(
                "已导入 {total} 个，部分应用导入失败: {}",
                failures.join("; ")
            )))
        }
    }
}

/// 路由中心只在「客户端配置文件」上生效的应用。
///
/// MCode / Pi 的托管文件由 phi 自己读写（名字必须保持 canonical），
/// OpenClaw / Claude Desktop / ZCode 不支持注入，都不参与路由。
fn supports_mcp_routing(app: &AppType) -> bool {
    !matches!(
        app,
        AppType::Mcode | AppType::Pi | AppType::OpenClaw | AppType::ClaudeDesktop | AppType::Zcode
    )
}

/// 这个应用里该服务器实际使用的名字（路由别名 / 命名空间）。
fn effective_mcp_server_id(app: &AppType, server_id: &str) -> String {
    if supports_mcp_routing(app) {
        crate::mcp_router::active_config()
            .exposure(server_id)
            .exposed_id
    } else {
        server_id.to_string()
    }
}

/// 一次投影会话：旧名字清理、新名字写入、名字账本更新收在一处。
///
/// 为什么要账本：同步时用的名字由「当前路由配置」推导，用户把别名从
/// `work-github` 改成 `gh`、或者删掉整条路由之后，旧名字已经推不出来了，
/// 但它还留在客户端 live 文件里。账本记录上一轮写入的名字，下一轮先清再写。
struct RouterProjection {
    applied: crate::mcp_router::AppliedExposures,
    state_path: std::path::PathBuf,
    /// 撞名落败的服务器：不写入，且不能凭自己的别名去删胜出者的条目。
    shadowed: std::collections::HashSet<String>,
    /// 当前真正占着某个暴露名的服务器（用于判断删除时会不会误删别人的条目）。
    claimed: std::collections::HashMap<String, String>,
    dirty: bool,
}

impl RouterProjection {
    fn begin(state: &AppState) -> Self {
        let state_path = crate::mcp_router::applied_state_path();
        let (shadowed, claimed) = match state.db.get_all_mcp_servers() {
            Ok(servers) => {
                let catalog = crate::mcp_router::build_catalog(
                    servers.values(),
                    &crate::mcp_router::active_config(),
                );
                let shadowed = catalog
                    .entries
                    .iter()
                    .filter(|entry| entry.shadowed_by.is_some())
                    .map(|entry| entry.server_id.clone())
                    .collect();
                let claimed = catalog
                    .entries
                    .iter()
                    .filter(|entry| entry.enabled && entry.shadowed_by.is_none())
                    .map(|entry| (entry.exposed_id.clone(), entry.server_id.clone()))
                    .collect();
                (shadowed, claimed)
            }
            Err(err) => {
                log::warn!("读取 MCP 服务器失败，路由遮挡按空集处理: {err}");
                Default::default()
            }
        };
        Self {
            applied: crate::mcp_router::AppliedExposures::load(&state_path),
            state_path,
            shadowed,
            claimed,
            dirty: false,
        }
    }

    fn commit(self) {
        if !self.dirty {
            return;
        }
        if let Err(err) = self.applied.save(&self.state_path) {
            log::warn!("MCP 路由名字账本写入失败（下次同步会重试清理）: {err}");
        }
    }

    fn forget_server(&mut self, server_id: &str) {
        self.applied.forget_server(server_id);
        self.dirty = true;
    }

    /// 这个服务器在这个客户端上是否应该出现。
    fn allows(&self, app: &AppType, server_id: &str) -> bool {
        if !supports_mcp_routing(app) {
            return true;
        }
        !self.shadowed.contains(server_id)
            && crate::mcp_router::exposure_for_app(server_id, app.as_str()).allowed
    }

    /// 投影一个服务器：清掉上一轮的名字 + canonical 残留，再写当前暴露名。
    fn sync(&mut self, server: &McpServer, app: &AppType) -> Result<(), AppError> {
        if !self.allows(app, &server.id) {
            return self.remove(&server.id, app, false);
        }
        let exposed = effective_mcp_server_id(app, &server.id);
        if supports_mcp_routing(app) {
            let previous = self
                .applied
                .previous(app.as_str(), &server.id)
                .map(str::to_string);
            if let Some(previous) = previous {
                if previous != exposed && self.claimed_name_by_other(&previous, &server.id) {
                    McpService::remove_id_from_app(app, &previous)?;
                    self.dirty = true;
                }
            }
            // 账本缺失的历史（老版本写入、手工改过配置）里 canonical 可能还在；
            // 有别名时先清掉它，否则客户端会同时出现 `github` 和 `work-github`。
            if exposed != server.id && self.claimed_name_by_other(&server.id, &server.id) {
                McpService::remove_id_from_app(app, &server.id)?;
            }
        }
        McpService::sync_id_to_app(app, &exposed, &server.server)?;
        if supports_mcp_routing(app)
            && self.applied.previous(app.as_str(), &server.id) != Some(exposed.as_str())
        {
            self.applied.record(app.as_str(), &server.id, &exposed);
            self.dirty = true;
        }
        Ok(())
    }

    /// 从客户端移除一个服务器：canonical、账本里的旧名字、配置过的别名各清一遍。
    fn remove(
        &mut self,
        id: &str,
        app: &AppType,
        remove_configured_alias: bool,
    ) -> Result<(), AppError> {
        McpService::remove_id_from_app(app, id)?;
        if !supports_mcp_routing(app) {
            return Ok(());
        }
        let previous = self.applied.previous(app.as_str(), id).map(str::to_string);
        if let Some(previous) = previous {
            if previous != id && self.claimed_name_by_other(&previous, id) {
                McpService::remove_id_from_app(app, &previous)?;
            }
            self.applied.forget(app.as_str(), id);
            self.dirty = true;
        }
        if remove_configured_alias {
            if let Some(configured) = crate::mcp_router::active_config().configured_exposed_id(id) {
                if configured != id && self.claimed_name_by_other(&configured, id) {
                    McpService::remove_id_from_app(app, &configured)?;
                }
            }
        }
        Ok(())
    }

    /// 这个名字是不是没被别的服务器占着（防止清理时删掉胜出者的条目）。
    fn claimed_name_by_other(&self, name: &str, server_id: &str) -> bool {
        match self.claimed.get(name) {
            None => true,
            Some(owner) => owner == server_id,
        }
    }
}
