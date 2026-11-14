//! 教训库的 Tauri 命令层。
//!
//! 教训贴仓库长，但仓库不需要人工登记：扫一遍本机会话，会话 cwd 所在的仓库（向上找
//! 最近的 `.git`）就自动成为一份禁区清单的归属地。任务页登记过的仓库仍然可用，
//! 只是不再是「能不能扫」的前提。

use crate::error::AppError;
use crate::lessons::model::{
    InjectionPreview, InjectionState, Lesson, LessonOverview, LessonProject, LessonState,
};
use crate::lessons::{detect, inject, render, store};
use crate::session_manager::SessionMeta;
use crate::store::AppState;
use crate::Database;
use std::path::{Path, PathBuf};
use tauri::State;

/// 注入落点：仓库根的 `AGENTS.md`，agent 每次进这个仓库都会读到。
const AGENTS_FILE: &str = "AGENTS.md";

fn err(error: AppError) -> String {
    error.to_string()
}

/// 可操作的目录：任务页登记过的仓库，或上一次扫描从会话里发现的仓库。
///
/// 后者是自动发现的落点：会话里出现过这个目录，就已经足够当教训的归属地，
/// 不必再去任务页登记一次。
fn known_workspace(state: &AppState, root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|_| "invalid-directory".to_string())?;
    if !path.is_dir() {
        return Err("invalid-directory".into());
    }
    let key = path.to_string_lossy().into_owned();
    let registered = state
        .db
        .task_workspaces()
        .map_err(err)?
        .iter()
        .any(|entry| Path::new(entry) == path);
    if registered || state.db.lesson_root_known(&key).map_err(err)? {
        return Ok(path);
    }
    Err("workspace-not-registered".into())
}

/// 目录名：给人看的短名字（路径本身另外显示一行）。
fn project_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn active_lessons(lessons: &[Lesson]) -> Vec<Lesson> {
    lessons
        .iter()
        .filter(|lesson| !lesson.dismissed)
        .cloned()
        .collect()
}

/// 算出「现在应该写进 `AGENTS.md` 的块」，以及它对应的版本号。
///
/// 内容没变就沿用原版本号（不制造无意义的版本跳号），变了才 `+1`——版本号的意义
/// 只是让读者（和缓存策略）知道这份清单换过。
fn plan_block(active: &[Lesson], current: Option<&str>, version: i64) -> (String, i64) {
    let rendered = render::render_block(active, version.max(1));
    if rendered.is_empty() || current == Some(rendered.as_str()) {
        return (rendered, version);
    }
    let next_version = version + 1;
    (render::render_block(active, next_version), next_version)
}

/// 删掉的教训要立刻从 `AGENTS.md` 里消失，而不是等下一次刷新。
/// 用户看到的是「我删了它」，文件里却还在，就等于删不掉。
fn dismiss_lesson(
    db: &Database,
    key: &str,
    workspace: &Path,
    id: &str,
    reason: &str,
) -> Result<(), String> {
    if !db.dismiss_lesson(key, id, reason).map_err(err)? {
        return Err("lesson-not-found".into());
    }
    sync_injection(db, key, workspace)
}

fn restore_lesson(db: &Database, key: &str, workspace: &Path, id: &str) -> Result<(), String> {
    if !db.restore_lesson(key, id).map_err(err)? {
        return Err("lesson-not-found".into());
    }
    sync_injection(db, key, workspace)
}

fn read_text(file: &Path) -> String {
    std::fs::read_to_string(file).unwrap_or_default()
}

fn preview_of(db: &Database, key: &str, workspace: &Path) -> Result<InjectionPreview, String> {
    let settings = db.lesson_settings(key).map_err(err)?;
    let lessons = db.lessons(key).map_err(err)?;
    let active = active_lessons(&lessons);
    let file = workspace.join(AGENTS_FILE);
    let current = inject::current_block(&read_text(&file));
    let (block, version) = plan_block(&active, current.as_deref(), settings.version);

    Ok(InjectionPreview {
        file: AGENTS_FILE.to_string(),
        used_chars: render::block_chars(&block),
        lesson_count: block.lines().filter(|line| line.starts_with("- [")).count(),
        budget_chars: render::BUDGET_CHARS,
        block,
        version,
    })
}

fn state_of(db: &Database, key: &str, workspace: &Path) -> Result<LessonState, String> {
    let settings = db.lesson_settings(key).map_err(err)?;
    let lessons = db.lessons(key).map_err(err)?;
    let active = active_lessons(&lessons);
    let file = workspace.join(AGENTS_FILE);
    let current = inject::current_block(&read_text(&file));
    let expected = render::render_block(&active, settings.version.max(1));

    Ok(LessonState {
        root: key.to_string(),
        lessons,
        injection: InjectionState {
            enabled: settings.inject,
            file: AGENTS_FILE.to_string(),
            version: settings.version,
            used_chars: current.as_deref().map(render::block_chars).unwrap_or(0),
            budget_chars: render::BUDGET_CHARS,
            applied: !expected.is_empty() && current.as_deref() == Some(expected.as_str()),
        },
        last_scan_at: settings.last_scan_at,
        scanned_sessions: settings.scanned_sessions,
        pending_sessions: settings.pending_sessions,
        failures: settings.failures,
    })
}

/// 注入开着的时候，教训变了就跟着更新文件（日更的落点就在这里）。
fn sync_injection(db: &Database, key: &str, workspace: &Path) -> Result<(), String> {
    let mut settings = db.lesson_settings(key).map_err(err)?;
    if !settings.inject {
        return Ok(());
    }
    let lessons = db.lessons(key).map_err(err)?;
    let active = active_lessons(&lessons);
    let file = workspace.join(AGENTS_FILE);
    let current = inject::current_block(&read_text(&file));
    let (block, version) = plan_block(&active, current.as_deref(), settings.version);

    if block.is_empty() {
        inject::remove(&file).map_err(err)?;
    } else {
        inject::apply(&file, &block).map_err(err)?;
    }
    if version != settings.version {
        settings.version = version;
        db.save_lesson_settings(key, settings).map_err(err)?;
    }
    Ok(())
}

/// 扫一遍会话，把失败沉淀成教训。纯增量：已经扫过的会话不再重扫。
fn refresh_with(
    db: &Database,
    key: &str,
    workspace: &Path,
    sessions: &[SessionMeta],
) -> Result<LessonState, String> {
    let mut settings = db.lesson_settings(key).map_err(err)?;
    let collected = detect::collect(
        workspace,
        sessions,
        settings.scanned_through,
        detect::SCAN_LIMIT,
    );

    for event in &collected.events {
        let candidate = render::candidate(event);
        let previous = db.lesson(key, &candidate.id).map_err(err)?;
        // 同一个会话重复扫到不会把命中次数刷高，也不再让被删的教训长回来
        let hits = db
            .add_lesson_occurrence(key, &candidate.id, &event.session_id, event.ts)
            .map_err(err)?;
        match previous {
            Some(previous) => {
                let mut apps = previous.apps;
                if !apps.iter().any(|app| app == &event.app) {
                    apps.push(event.app.clone());
                }
                let last_seen = previous.last_seen.max(event.ts);
                db.touch_lesson(key, &candidate.id, hits, last_seen, &apps)
                    .map_err(err)?;
            }
            None => {
                db.insert_lesson(
                    key,
                    &Lesson {
                        id: candidate.id,
                        paths: candidate.paths,
                        trigger: candidate.trigger,
                        evidence: candidate.evidence,
                        next_step: candidate.next_step,
                        hits,
                        first_seen: event.ts,
                        last_seen: event.ts,
                        apps: vec![event.app.clone()],
                        dismissed: false,
                        dismiss_reason: None,
                    },
                )
                .map_err(err)?;
            }
        }
    }

    settings.scanned_through = collected.scanned_through;
    settings.last_scan_at = Some(store::now_ms());
    settings.scanned_sessions = collected.scanned_sessions;
    settings.pending_sessions = collected.pending_sessions;
    settings.failures = collected.events.len();
    db.save_lesson_settings(key, settings).map_err(err)?;

    sync_injection(db, key, workspace)?;
    state_of(db, key, workspace)
}

#[tauri::command]
pub fn lesson_state(state: State<'_, AppState>, root: String) -> Result<LessonState, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    state_of(&state.db, &key, &path)
}

/// 已经扫出来的仓库状态（不重新扫，只读库）。
fn overview_of(db: &Database) -> Result<LessonOverview, String> {
    let mut projects = Vec::new();
    let mut last_scan_at: Option<i64> = None;
    for key in db.lesson_roots().map_err(err)? {
        let path = PathBuf::from(&key);
        if !path.is_dir() {
            // 仓库目录被删了或挪了：库里的教训留着，但不再占一个位置
            continue;
        }
        let state = state_of(db, &key, &path)?;
        last_scan_at = last_scan_at.max(state.last_scan_at);
        projects.push(LessonProject {
            root: key,
            name: project_name(&path),
            state,
        });
    }
    sort_projects(&mut projects);
    Ok(LessonOverview {
        scanned_projects: projects.len(),
        projects,
        scanned_sessions: 0,
        pending_sessions: 0,
        failures: 0,
        last_scan_at,
    })
}

/// 有教训的排前面，其次按名字：扫完一眼就能看到哪里真的炸过。
fn sort_projects(projects: &mut [LessonProject]) {
    projects.sort_by(|a, b| {
        let active = |project: &LessonProject| {
            project
                .state
                .lessons
                .iter()
                .filter(|lesson| !lesson.dismissed)
                .count()
        };
        active(b)
            .cmp(&active(a))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.root.cmp(&b.root))
    });
}

/// 扫一遍本机所有会话，把涉及的每个仓库都跑出来。
///
/// 一次只读一遍会话列表（九个应用的扫描并行跑在内里），再按仓库归组分别增量扫描，
/// 所以仓库多也不会把会话读成 N 倍。
fn scan_all(db: &Database) -> Result<LessonOverview, String> {
    let sessions = crate::session_manager::scan_sessions();
    let roots = detect::projects(&sessions);
    let mut projects = Vec::new();
    let mut scanned_sessions = 0;
    let mut pending_sessions = 0;
    let mut failures = 0;
    let mut last_scan_at: Option<i64> = None;

    for workspace in roots {
        let key = workspace.to_string_lossy().into_owned();
        let state = refresh_with(db, &key, &workspace, &sessions)?;
        scanned_sessions += state.scanned_sessions;
        pending_sessions += state.pending_sessions;
        failures += state.failures;
        last_scan_at = last_scan_at.max(state.last_scan_at);
        projects.push(LessonProject {
            root: key,
            name: project_name(&workspace),
            state,
        });
    }

    sort_projects(&mut projects);
    Ok(LessonOverview {
        scanned_projects: projects.len(),
        projects,
        scanned_sessions,
        pending_sessions,
        failures,
        last_scan_at,
    })
}

/// 页面打开时：库里已经发现过的仓库直接给出去，不偷偷扫。
#[tauri::command]
pub async fn lesson_overview(state: State<'_, AppState>) -> Result<LessonOverview, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || overview_of(&db))
        .await
        .map_err(|e| format!("lesson overview failed: {e}"))?
}

/// 「扫描会话」：不看仓库选择器，把本机会话涉及的所有仓库都扫一遍。
#[tauri::command]
pub async fn lesson_scan(state: State<'_, AppState>) -> Result<LessonOverview, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || scan_all(&db))
        .await
        .map_err(|e| format!("lesson scan failed: {e}"))?
}

#[tauri::command]
pub async fn lesson_refresh(
    state: State<'_, AppState>,
    root: String,
) -> Result<LessonState, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = crate::session_manager::scan_sessions();
        refresh_with(&db, &key, &path, &sessions)
    })
    .await
    .map_err(|e| format!("lesson refresh failed: {e}"))?
}

/// 阀一：这次要动的路径命中了哪些禁区。
#[tauri::command]
pub fn lesson_matches(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<Vec<Lesson>, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    let lessons = state.db.lessons(&key).map_err(err)?;
    Ok(active_lessons(&lessons)
        .into_iter()
        .filter(|lesson| {
            lesson
                .paths
                .iter()
                .any(|tag| paths.iter().any(|path| render::matches(tag, path)))
        })
        .collect())
}

/// 删掉一条教训。理由必填：下次重算才能知道「为什么这条不该出现」。
#[tauri::command]
pub fn lesson_dismiss(
    state: State<'_, AppState>,
    root: String,
    id: String,
    reason: String,
) -> Result<LessonState, String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("reason-required".into());
    }
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    dismiss_lesson(&state.db, &key, &path, &id, reason)?;
    state_of(&state.db, &key, &path)
}

#[tauri::command]
pub fn lesson_restore(
    state: State<'_, AppState>,
    root: String,
    id: String,
) -> Result<LessonState, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    restore_lesson(&state.db, &key, &path, &id)?;
    state_of(&state.db, &key, &path)
}

#[tauri::command]
pub fn lesson_injection_preview(
    state: State<'_, AppState>,
    root: String,
) -> Result<InjectionPreview, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    preview_of(&state.db, &key, &path)
}

/// 开关注入。打开才会写用户的 `AGENTS.md`，关掉就把那一块摘干净。
#[tauri::command]
pub fn lesson_set_injection(
    state: State<'_, AppState>,
    root: String,
    enabled: bool,
) -> Result<InjectionPreview, String> {
    let path = known_workspace(&state, &root)?;
    let key = path.to_string_lossy().into_owned();
    let db = &state.db;
    let mut settings = db.lesson_settings(&key).map_err(err)?;
    let lessons = db.lessons(&key).map_err(err)?;
    let active = active_lessons(&lessons);
    let file = path.join(AGENTS_FILE);

    if enabled {
        let current = inject::current_block(&read_text(&file));
        let (block, version) = plan_block(&active, current.as_deref(), settings.version);
        if block.is_empty() {
            inject::remove(&file).map_err(err)?;
        } else {
            inject::apply(&file, &block).map_err(err)?;
        }
        settings.version = version;
    } else {
        inject::remove(&file).map_err(err)?;
    }
    settings.inject = enabled;
    db.save_lesson_settings(&key, settings).map_err(err)?;

    preview_of(db, &key, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lessons::model::Lesson;
    use crate::lessons::store::Settings;

    /// 手工验证：在本机真实会话上跑一遍全量扫描，看仓库是不是真的都被发现了。
    ///
    /// 依赖本机的会话文件，所以不进 CI；跑法：
    /// `cargo test --lib lessons::commands::tests::scan -- --ignored --nocapture`。
    /// 用的是内存库，不碰真实教训库，也不会写任何 `AGENTS.md`。
    #[test]
    #[ignore = "扫描本机真实会话，只在手工验证时跑"]
    fn scan_finds_every_repository_this_machine_has_sessions_in() {
        let db = Database::memory().expect("memory db");
        let overview = scan_all(&db).expect("scan");
        println!(
            "projects={} sessions={} failures={} pending={}",
            overview.scanned_projects,
            overview.scanned_sessions,
            overview.failures,
            overview.pending_sessions
        );
        for project in overview.projects.iter().take(20) {
            println!(
                "- {} {:?} lessons={} sessions={}",
                project.name,
                project.root,
                project.state.lessons.len(),
                project.state.scanned_sessions
            );
        }
        assert!(!overview.projects.is_empty());
        // 页面打开（不重扫）时应当能把这些仓库原样读回来
        let listed = overview_of(&db).expect("overview");
        assert_eq!(listed.projects.len(), overview.projects.len());
        assert_eq!(listed.scanned_projects, overview.scanned_projects);
        // 有教训的排前面
        let counts: Vec<usize> = listed
            .projects
            .iter()
            .map(|project| project.state.lessons.len())
            .collect();
        assert!(counts.windows(2).all(|pair| pair[0] >= pair[1]));
    }

    fn lesson(id: &str, path: &str) -> Lesson {
        Lesson {
            id: id.into(),
            paths: vec![path.into()],
            trigger: "`cargo test` 退出码 1".into(),
            evidence: "codex 会话 abcdef12（2026-11-12）".into(),
            next_step: "下次：动手前先跑 `cargo test` 确认基线。".into(),
            hits: 1,
            first_seen: 1_700_000_000_000,
            last_seen: 1_700_000_000_000,
            apps: vec!["codex".into()],
            dismissed: false,
            dismiss_reason: None,
        }
    }

    #[test]
    fn dismissing_and_restoring_syncs_agents_md_while_injection_is_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path();
        let file = workspace.join(AGENTS_FILE);
        std::fs::write(&file, "# AGENTS.md\n\n项目规则。\n").expect("seed file");

        let db = Database::memory().expect("memory db");
        let key = workspace.to_string_lossy().into_owned();
        db.insert_lesson(&key, &lesson("a", "src/a.rs"))
            .expect("insert");
        db.save_lesson_settings(
            &key,
            Settings {
                inject: true,
                ..Settings::default()
            },
        )
        .expect("settings");

        sync_injection(&db, &key, workspace).expect("sync");
        assert!(read_text(&file).contains("src/a.rs"));

        // 删掉就等于「从 AGENTS.md 里消失」，不能只改库、把文件留给下次刷新
        dismiss_lesson(&db, &key, workspace, "a", "误报").expect("dismiss");
        assert!(!read_text(&file).contains("src/a.rs"));

        restore_lesson(&db, &key, workspace, "a").expect("restore");
        assert!(read_text(&file).contains("src/a.rs"));
    }

    #[test]
    fn dismiss_requires_a_reason_that_the_store_can_keep() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path();
        let db = Database::memory().expect("memory db");
        let key = workspace.to_string_lossy().into_owned();
        db.insert_lesson(&key, &lesson("a", "src/a.rs"))
            .expect("insert");

        assert!(dismiss_lesson(&db, &key, workspace, "missing", "误报").is_err());
        assert!(dismiss_lesson(&db, &key, workspace, "a", "误报").is_ok());
        assert_eq!(
            db.lesson(&key, "a")
                .expect("get")
                .expect("exists")
                .dismiss_reason
                .as_deref(),
            Some("误报")
        );
    }
}
