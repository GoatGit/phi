//! 编排接力的 Tauri 命令层。
//!
//! 和任务看板其它命令一样，`root` 必须是用户登记过的工作区：门 2 会在里面
//! 执行卡片声明的 shell 命令，绝不能接受前端随手传来的任意目录。

use tauri::State;

use super::model::{GateRun, RelayView};
use super::{contract, gate, review, verdict};
use crate::store::AppState;
use crate::tasks::commands::open;
use crate::tasks::frontmatter::Document;
use crate::tasks::repository;

/// 读一张卡的接力视图：契约、最近的结论、门判定历史、可核对的东西。
#[tauri::command]
pub fn task_relay(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
) -> Result<RelayView, String> {
    let workspace = open(state.inner(), &root)?;
    let path = repository::find_file(&workspace, &task_id)?;
    let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;

    let parsed = contract::parse(&doc);
    let current = verdict::read(&doc);
    let root_key = workspace.root.to_string_lossy().to_string();
    let runs = state
        .db
        .gate_runs(&root_key, &task_id, 10)
        .map_err(|error| error.to_string())?;

    let mut warnings = Vec::new();
    let base = current.base.clone().unwrap_or_else(|| "HEAD".to_string());
    let changed = match gate::changed_files(&workspace.root, &base) {
        Ok(changed) => changed,
        Err(reason) => {
            warnings.push(format!("拿不到相对 {base} 的改动清单：{reason}"));
            Vec::new()
        }
    };

    Ok(RelayView {
        task_id,
        contract: parsed,
        verdict: current,
        runs,
        review_claims: review::claims(doc.body()).len(),
        changed,
        warnings,
    })
}

/// 跑一次门判定并回写卡片。`gate_number` 目前只支持 2（实现成立）和 3（复查成立）。
#[tauri::command]
pub fn task_gate_run(
    state: State<'_, AppState>,
    root: String,
    task_id: String,
    gate_number: u8,
) -> Result<GateRun, String> {
    if !matches!(gate_number, 2 | 3) {
        return Err("unknown-gate".into());
    }

    let workspace = open(state.inner(), &root)?;
    let path = repository::find_file(&workspace, &task_id)?;
    let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;
    let parsed = contract::parse(&doc);
    let root_key = workspace.root.to_string_lossy().to_string();

    let started = std::time::Instant::now();
    let outcome = if gate_number == 2 {
        // 卡片没写 phi.base 时沿用上一轮的基线，免得每跑一次门基线往后溜
        let inherited = state
            .db
            .gate_runs(&root_key, &task_id, 1)
            .ok()
            .and_then(|runs| runs.into_iter().next())
            .and_then(|run| run.base_commit);
        gate::run_gate2(&workspace.root, &parsed, inherited)
    } else {
        gate::run_gate3(&workspace.root, &review::claims(doc.body()))
    };

    let run = GateRun {
        id: uuid::Uuid::new_v4().to_string(),
        gate: gate_number,
        status: outcome.status,
        base_commit: outcome.base,
        created_at: verdict::now(),
        duration_ms: started.elapsed().as_millis() as i64,
        evidence: outcome.evidence,
    };

    // 先落证据再回写卡片：卡片上的结论一定能追溯到这次判定的证据
    state
        .db
        .record_gate_run(&root_key, &task_id, &run)
        .map_err(|error| error.to_string())?;
    verdict::write_back(
        &workspace,
        &task_id,
        gate_number,
        &run.status,
        run.base_commit.as_deref(),
    )
    .map_err(|error| format!("verdict-write-failed: {error}"))?;

    Ok(run)
}
