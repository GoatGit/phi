//! 门判定的落库与结论回写。
//!
//! 两份数据分工明确：
//! - 卡片 frontmatter 的 `phi_verdict` 块 = 当前结论（门 2 / 门 3 / 时间 / 基线）。
//!   人和其他 agent 读卡片就能看到，是唯一事实源；
//! - sqlite 的 `task_gate_runs` = 判定历史与证据（输出尾部、越界清单、锚点核对）。
//!   这是本机事实，不进 git，留给成绩单和复盘。
//!
//! 回写刻意放在新的顶层键 `phi_verdict`，而不是塞进卡片作者写的 `phi:` 块：
//! 写回是按行定点替换，替换 `phi:` 会连它的缩进块一起吃掉，等于抹掉用户写的契约。

use serde_yaml::Value;

use super::model::{GateRun, Verdict};
use crate::database::lock_conn;
use crate::error::AppError;
use crate::tasks::document::Workspace;
use crate::tasks::frontmatter::{Document, FieldValue};
use crate::tasks::{document, repository};
use crate::Database;
use rusqlite::params;

pub(crate) const VERDICT_KEY: &str = "phi_verdict";

fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Orchestration: {e}"))
}

pub(super) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn create_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_gate_runs (
            id TEXT PRIMARY KEY,
            root TEXT NOT NULL,
            task_id TEXT NOT NULL,
            gate INTEGER NOT NULL,
            status TEXT NOT NULL,
            base_commit TEXT,
            created_at INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            evidence TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_gate_runs_task
            ON task_gate_runs(root, task_id, created_at DESC);",
    )
    .map_err(error)
}

impl Database {
    /// 记一次门判定的证据。证据整体存 JSON：字段会随门长，不值得为它建列。
    pub fn record_gate_run(
        &self,
        root: &str,
        task_id: &str,
        run: &GateRun,
    ) -> Result<(), AppError> {
        let evidence = serde_json::to_string(&run.evidence).map_err(error)?;
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO task_gate_runs
                (id, root, task_id, gate, status, base_commit, created_at, duration_ms, evidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                run.id,
                root,
                task_id,
                run.gate,
                run.status,
                run.base_commit,
                run.created_at,
                run.duration_ms,
                evidence
            ],
        )
        .map_err(error)?;
        Ok(())
    }

    /// 一个任务最近的门判定，新的在前。
    pub fn gate_runs(
        &self,
        root: &str,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<GateRun>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut statement = conn
            .prepare(
                "SELECT id, gate, status, base_commit, created_at, duration_ms, evidence
                 FROM task_gate_runs
                 WHERE root = ?1 AND task_id = ?2
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?3",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(params![root, task_id, limit as i64], |row| {
                let evidence: String = row.get(6)?;
                Ok(GateRun {
                    id: row.get(0)?,
                    gate: row.get(1)?,
                    status: row.get(2)?,
                    base_commit: row.get(3)?,
                    created_at: row.get(4)?,
                    duration_ms: row.get(5)?,
                    evidence: serde_json::from_str(&evidence).unwrap_or_default(),
                })
            })
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }
}

/// 读卡片上的结论块。
pub(crate) fn read(doc: &Document) -> Verdict {
    let mapping = doc.mapping();
    let Some(Value::Mapping(block)) = mapping.get(Value::String(VERDICT_KEY.into())) else {
        return Verdict::default();
    };
    let field = |key: &str| {
        block
            .get(Value::String(key.into()))
            .and_then(scalar)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    };
    Verdict {
        gate2: field("gate2"),
        gate3: field("gate3"),
        at: field("at"),
        base: field("base"),
    }
}

/// 把这次结论写回卡片。只重写 `phi_verdict` 块，其它字段和正文原样保留。
pub(crate) fn write_back(
    workspace: &Workspace,
    task_id: &str,
    gate: u8,
    status: &str,
    base: Option<&str>,
) -> Result<Verdict, String> {
    let path = repository::find_file(workspace, task_id)?;
    let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let doc = Document::parse(&raw).ok_or_else(|| "invalid-task-file".to_string())?;

    let mut next = read(&doc);
    match gate {
        2 => next.gate2 = Some(status.to_string()),
        3 => next.gate3 = Some(status.to_string()),
        _ => return Err("unknown-gate".into()),
    }
    next.at = Some(document::timestamp());
    if let Some(base) = base {
        next.base = Some(base.to_string());
    }

    let block = render(&next);
    let updated = doc.with_field(VERDICT_KEY, FieldValue::Block(&block));
    repository::write_atomic(&path, &updated)?;
    Ok(next)
}

/// 渲染成 YAML 块：缩进两格，值交给 YAML 自己决定要不要引号。
fn render(verdict: &Verdict) -> String {
    let mut lines = vec![format!("{VERDICT_KEY}:")];
    let pairs = [
        ("gate2", verdict.gate2.as_deref()),
        ("gate3", verdict.gate3.as_deref()),
        ("at", verdict.at.as_deref()),
        ("base", verdict.base.as_deref()),
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            lines.push(format!("  {key}: {}", render_scalar(value)));
        }
    }
    lines.join("\n")
}

fn render_scalar(text: &str) -> String {
    let rendered = serde_yaml::to_string(&Value::String(text.to_string()))
        .unwrap_or_else(|_| format!("{text}\n"));
    rendered.trim_end_matches('\n').to_string()
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::model::{GateEvidence, StepResult};

    fn doc(frontmatter: &str) -> Document {
        Document::parse(&format!("---\n{frontmatter}---\n\n正文\n")).expect("合法 frontmatter")
    }

    #[test]
    fn render_keeps_known_fields_only() {
        let block = render(&Verdict {
            gate2: Some("pass".into()),
            gate3: Some("invalid".into()),
            at: Some("2026-11-13 02:40".into()),
            base: Some("10466fa".into()),
        });
        assert_eq!(
            block,
            "phi_verdict:\n  gate2: pass\n  gate3: invalid\n  at: 2026-11-13 02:40\n  base: 10466fa"
        );
    }

    #[test]
    fn read_and_write_block_roundtrip() {
        let original = doc("id: TASK-1\nphi:\n  accept:\n    - cmd: make\n  touched: [src/**]\n");
        let updated = original.with_field(
            VERDICT_KEY,
            FieldValue::Block(&render(&Verdict {
                gate2: Some("pass".into()),
                gate3: None,
                at: Some("2026-11-13 02:40".into()),
                base: Some("10466fa".into()),
            })),
        );
        let parsed = Document::parse(&updated).expect("还能解析");
        let verdict = read(&parsed);
        assert_eq!(verdict.gate2.as_deref(), Some("pass"));
        assert_eq!(verdict.gate3, None);
        assert_eq!(verdict.base.as_deref(), Some("10466fa"));

        // 用户写的契约必须原样保留
        assert!(
            updated.contains("  accept:\n    - cmd: make\n"),
            "{updated}"
        );
        assert!(updated.contains("正文"));
    }

    #[test]
    fn second_write_replaces_the_block_instead_of_appending() {
        let first = doc("id: TASK-1\n").with_field(
            VERDICT_KEY,
            FieldValue::Block(&render(&Verdict {
                gate2: Some("fail".into()),
                ..Default::default()
            })),
        );
        let second = Document::parse(&first).expect("还能解析").with_field(
            VERDICT_KEY,
            FieldValue::Block(&render(&Verdict {
                gate2: Some("pass".into()),
                ..Default::default()
            })),
        );
        assert_eq!(second.matches(VERDICT_KEY).count(), 1, "{second}");
        assert!(second.contains("gate2: pass"));
    }

    #[test]
    fn stores_runs_newest_first() {
        let db = Database::memory().expect("memory db");
        let run = |id: &str, created_at: i64| GateRun {
            id: id.to_string(),
            gate: 2,
            status: "pass".to_string(),
            base_commit: Some("abc".into()),
            created_at,
            duration_ms: 12,
            evidence: GateEvidence {
                steps: vec![StepResult {
                    cmd: "make".into(),
                    expect_exit: 0,
                    exit_code: Some(0),
                    timed_out: false,
                    duration_ms: 12,
                    output_tail: "ok".into(),
                }],
                ..Default::default()
            },
        };

        db.record_gate_run("/repo", "TASK-1", &run("a", 1))
            .expect("record a");
        db.record_gate_run("/repo", "TASK-1", &run("b", 2))
            .expect("record b");
        db.record_gate_run("/repo", "TASK-2", &run("c", 3))
            .expect("record c");

        let runs = db.gate_runs("/repo", "TASK-1", 10).expect("list");
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].id, "b");
        assert_eq!(runs[0].evidence.steps[0].cmd, "make");
    }
}
