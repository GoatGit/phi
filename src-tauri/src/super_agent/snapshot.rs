//! 快照：把「已登记的工作区 + 看板卡片 + 运行态」压成一次 tick 的输入。
//!
//! 这一层只有读，没有判断：读不到的工作区写成 note，不让整个 tick 失败。

use crate::super_agent::model::Candidate;
use crate::super_agent::store;
use crate::tasks::{document, repository};
use crate::Database;
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub(crate) struct Snapshot {
    pub candidates: Vec<Candidate>,
    /// 扫过的卡片数（含被后续过滤掉的）。
    pub scanned: usize,
    /// 读不到的工作区等非致命问题。
    pub notes: Vec<String>,
}

/// 扫全部已登记工作区。单个工作区读失败不影响其它工作区。
pub(crate) fn collect(db: &Database) -> Result<Snapshot, String> {
    // 键必须是 (仓库, 任务)：每个 backlog 仓库都有自己的 TASK-1，只按任务 id 索引
    // 会让一个仓库的运行态覆盖另一个仓库的同名任务（暂停、跑起来了都会串）。
    let runs: HashMap<(String, String), crate::super_agent::model::TaskRun> = db
        .router_runs()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|run| ((run.root.clone(), run.task_id.clone()), run))
        .collect();

    let mut snapshot = Snapshot::default();
    for root in db.task_workspaces().map_err(|e| e.to_string())? {
        let workspace = match document::open(std::path::Path::new(&root)) {
            Ok(workspace) => workspace,
            Err(error) => {
                snapshot.notes.push(format!("{root}: {error}"));
                continue;
            }
        };
        let tasks = match repository::list(&workspace) {
            Ok(tasks) => tasks,
            Err(error) => {
                snapshot.notes.push(format!("{root}: {error}"));
                continue;
            }
        };
        snapshot.scanned += tasks.len();
        for task in tasks {
            let run = runs.get(&(root.clone(), task.id.clone())).cloned();
            snapshot.candidates.push(Candidate {
                run,
                schedule: task.schedule_spec.clone(),
                task_id: task.id,
                root: root.clone(),
                title: task.title,
                status: task.status,
                file: task.file,
                fingerprint: task.fingerprint,
                dependencies: task.dependencies,
            });
        }
    }
    Ok(snapshot)
}

/// 一张卡当前的内容指纹。收尾时用它判断 worker 有没有动过这张卡。
#[cfg(test)]
pub(crate) fn task_fingerprint(root: &str, task_id: &str) -> Option<String> {
    let workspace = document::open(std::path::Path::new(root)).ok()?;
    repository::list(&workspace)
        .ok()?
        .into_iter()
        .find(|task| task.id == task_id)
        .map(|task| task.fingerprint)
}

/// 运行态里还占着并发名额的数量。
pub(crate) fn running(runs: &[crate::super_agent::model::TaskRun]) -> usize {
    runs.iter().filter(|run| run.state.is_running()).count()
}

/// 打一个 tick 用的 holder 标识：同一台机器上同一进程才有意义，
/// 只用于「谁的租约」这条日志，不参与鉴权。
pub(crate) fn holder() -> String {
    format!("{}:{}", std::process::id(), store::now_ms())
}
