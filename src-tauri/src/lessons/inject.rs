//! 注入：把教训块写进仓库的 `AGENTS.md`。
//!
//! 只动两块标记之间的内容，其余一个字节都不碰。默认关闭（`lesson_settings.inject`），
//! 打开才会写文件——教训库是增强，不能背着用户改他的 `AGENTS.md`。

use crate::error::AppError;
use std::path::Path;

pub(crate) const BEGIN_MARKER: &str = "<!-- phi:lessons:begin -->";
pub(crate) const END_MARKER: &str = "<!-- phi:lessons:end -->";

fn io_error(path: &Path, source: std::io::Error) -> AppError {
    AppError::Io {
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

/// 文件里现有的注入块（含首尾标记）；没有就返回 `None`。
pub(crate) fn current_block(text: &str) -> Option<String> {
    let start = text.find(BEGIN_MARKER)?;
    let end = text.find(END_MARKER)? + END_MARKER.len();
    if end <= start {
        return None;
    }
    Some(text[start..end].to_string())
}

/// 用 `block` 替换（或首次追加）注入块，其余内容原样保留。
pub(crate) fn upsert(text: &str, block: &str) -> String {
    let block = block.trim_end();
    if let (Some(start), Some(end)) = (text.find(BEGIN_MARKER), text.find(END_MARKER)) {
        if end > start {
            let end = end + END_MARKER.len();
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(block);
            out.push_str(&text[end..]);
            return out;
        }
    }

    let mut out = text.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(block);
    out.push('\n');
    out
}

/// 去掉注入块，连同它和前后文之间多出来的空行。
pub(crate) fn strip(text: &str) -> String {
    let (Some(start), Some(end)) = (text.find(BEGIN_MARKER), text.find(END_MARKER)) else {
        return text.to_string();
    };
    let end = end + END_MARKER.len();
    if end <= start {
        return text.to_string();
    }

    let mut out = text[..start].trim_end().to_string();
    let tail = text[end..].trim_start();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn read_text(file: &Path) -> Result<String, AppError> {
    match std::fs::read_to_string(file) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(io_error(file, error)),
    }
}

/// 写入注入块；内容没变就不写盘（少一次 mtime 变化，也少一次无意义的 diff）。
pub(crate) fn apply(file: &Path, block: &str) -> Result<bool, AppError> {
    let text = read_text(file)?;
    let next = upsert(&text, block);
    if next == text {
        return Ok(false);
    }
    std::fs::write(file, next).map_err(|error| io_error(file, error))?;
    Ok(true)
}

/// 移除注入块；文件里本来就没有就当成功。
pub(crate) fn remove(file: &Path) -> Result<bool, AppError> {
    let text = read_text(file)?;
    let next = strip(&text);
    if next == text {
        return Ok(false);
    }
    if next.trim().is_empty() {
        // 别留下一个只剩空白的 AGENTS.md
        std::fs::remove_file(file).map_err(|error| io_error(file, error))?;
        return Ok(true);
    }
    std::fs::write(file, next).map_err(|error| io_error(file, error))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const BLOCK: &str = "<!-- phi:lessons:begin -->\n## 禁区清单 · lessons v1\n\n- [2026-10-08] `src/a.rs`：`cargo test` 退出码 1。\n<!-- phi:lessons:end -->";

    #[test]
    fn appends_once_and_replaces_in_place_afterwards() {
        let original = "# AGENTS.md\n\n项目规则。\n";
        let once = upsert(original, BLOCK);
        assert!(once.starts_with("# AGENTS.md"));
        assert_eq!(once.matches(BEGIN_MARKER).count(), 1);

        let twice = upsert(&once, &BLOCK.replace("v1", "v2"));
        assert_eq!(twice.matches(BEGIN_MARKER).count(), 1);
        assert!(twice.contains("lessons v2"));
        assert!(twice.starts_with("# AGENTS.md\n\n项目规则。"));
    }

    #[test]
    fn stripping_restores_the_file_and_leaves_no_blank_tail() {
        let original = "# AGENTS.md\n\n项目规则。\n";
        let with_block = upsert(original, BLOCK);
        assert_eq!(strip(&with_block), original);
        // 没有块的文件不该被改动
        assert_eq!(strip(original), original);
    }

    #[test]
    fn apply_is_idempotent_and_remove_cleans_up_a_block_only_file() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("AGENTS.md");

        assert!(apply(&file, BLOCK).expect("apply"));
        assert!(!apply(&file, BLOCK).expect("apply again"));
        assert_eq!(
            current_block(&read_text(&file).expect("read")).as_deref(),
            Some(BLOCK)
        );

        assert!(remove(&file).expect("remove"));
        // 文件里原本只有这一块，删完就该整个消失
        assert!(!file.exists());
    }
}
