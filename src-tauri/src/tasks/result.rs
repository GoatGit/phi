//! 「这次任务到底交付了什么」——从卡片正文里抽结果摘要与产物清单。
//!
//! 看板以前只显示过程信息（谁在跑、第几次、退出码），用户要的东西埋在几百字
//! 执行日志里。约定很简单，写在派发指令里：
//!
//! ```markdown
//! ## 结果
//!
//! 一句话说明交付了什么。
//!
//! ## 产物
//!
//! - `daily/2026-11-17.md` — 今天的新闻简报
//! - https://example.com/report 在线版本
//! ```
//!
//! 老卡片没有这两个段落：退一步把 `## Conclusion` 当结果摘要，仍然好过只显示
//! 运行状态。产物清单只从「产物」段落里取，不从整篇正文里猜——把一句普通正文
//! 认成文件路径，比少列一个产物更糟。

use std::path::{Component, Path, PathBuf};

use super::frontmatter::sections;

/// 结果摘要的段落标题，按优先级排列。
const RESULT_TITLES: [&str; 6] = [
    "结果",
    "结果说明",
    "交付结果",
    "Outcome",
    "Result",
    "Results",
];
/// 老卡片常用的收尾段落。只在没有上面的结果段落时兜底。
const FALLBACK_RESULT_TITLES: [&str; 3] = ["Conclusion", "结论", "总结"];
/// 产物清单的段落标题。
const ARTIFACT_TITLES: [&str; 6] = [
    "产物",
    "交付物",
    "产物与结果",
    "Artifacts",
    "Deliverables",
    "Output",
];

/// 一条产物。`label` 是给人看的名字，`path` 是卡片里写的原始路径或链接。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRef {
    pub label: String,
    pub path: String,
}

fn matches_title(title: &str, candidates: &[&str]) -> bool {
    let title = title.trim();
    candidates
        .iter()
        .any(|candidate| title.eq_ignore_ascii_case(candidate))
}

/// 结果摘要连同它来自哪一段。
///
/// 调用方要按**这一个**标题去重，而不是按「所有可能是结果的标题」：卡片里同时
/// 有 `## 结果` 和 `## Conclusion` 时，后者是过程记录，不该跟着被删掉。
pub fn outcome_section(body: &str) -> Option<(String, String)> {
    let sections = sections(body);
    for titles in [&RESULT_TITLES[..], &FALLBACK_RESULT_TITLES[..]] {
        if let Some(section) = sections
            .iter()
            .find(|section| matches_title(&section.title, titles))
        {
            let text = section.body.trim();
            if !text.is_empty() {
                return Some((section.title.clone(), text.to_string()));
            }
        }
    }
    None
}

/// 这一段是不是产物清单（详情页会单独渲染成文件列表，正文里不再重复）。
pub fn is_artifact_section(title: &str) -> bool {
    matches_title(title, &ARTIFACT_TITLES)
}

/// 产物清单：只认产物段落里的列表项与链接。
pub fn artifacts(body: &str) -> Vec<ArtifactRef> {
    let mut found: Vec<ArtifactRef> = Vec::new();
    for section in sections(body) {
        if !matches_title(&section.title, &ARTIFACT_TITLES) {
            continue;
        }
        for line in section.body.lines() {
            let Some(artifact) = parse_line(line) else {
                continue;
            };
            if found.iter().any(|item| item.path == artifact.path) {
                continue;
            }
            found.push(artifact);
        }
    }
    if found.len() > MAX_ARTIFACTS {
        log::warn!(
            "task artifacts truncated: found={} limit={MAX_ARTIFACTS}",
            found.len()
        );
        found.truncate(MAX_ARTIFACTS);
    }
    found
}

/// 一张卡最多列这么多产物：再多也不适合放在详情抽屉里看。
pub const MAX_ARTIFACTS: usize = 20;
const MAX_PATH_CHARS: usize = 512;

fn parse_line(line: &str) -> Option<ArtifactRef> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 只要列表项；正文里顺手写的一句话不算产物。
    let rest = strip_list_marker(trimmed)?;

    // `[名字](路径)`
    if let Some(open) = rest.find("](") {
        if rest.starts_with('[') {
            let label = rest[1..open].trim().to_string();
            let after = &rest[open + 2..];
            let path = after.split(')').next()?.trim();
            return build(label, path);
        }
    }
    // `` `路径` — 说明 ``
    if let Some(start) = rest.find('`') {
        let after = &rest[start + 1..];
        if let Some(end) = after.find('`') {
            let path = &after[..end];
            let label = after[end + 1..]
                .trim()
                .trim_start_matches(['—', '-', ':', '：', ' '])
                .trim()
                .to_string();
            return build(label, path);
        }
    }
    // `路径 — 说明` / `路径：说明` / 只有路径
    let (path, label) = split_description(rest);
    build(label.to_string(), path)
}

fn strip_list_marker(line: &str) -> Option<&str> {
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "));
    if let Some(rest) = rest {
        return Some(rest.trim());
    }
    // `1. path`
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        if let Some(rest) = rest.strip_prefix(". ") {
            return Some(rest.trim());
        }
    }
    None
}

fn split_description(value: &str) -> (&str, &str) {
    for separator in [" — ", " – ", " - ", "：", ": "] {
        if let Some((path, label)) = value.split_once(separator) {
            return (path.trim(), label.trim());
        }
    }
    (value.trim(), "")
}

fn build(label: String, path: &str) -> Option<ArtifactRef> {
    let path = path.trim().trim_matches('`').trim_matches('"').trim();
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS || path.contains('\n') {
        return None;
    }
    if is_url(path) {
        let label = if label.is_empty() {
            path.to_string()
        } else {
            label
        };
        return Some(ArtifactRef {
            label,
            path: path.to_string(),
        });
    }
    // 路径里带空格又没加反引号时基本是一句话，不当产物。
    if path.contains(char::is_whitespace) {
        return None;
    }
    if path.starts_with('/') || path.contains("..") {
        return None;
    }
    if !path.contains('.') && !path.contains('/') {
        return None;
    }
    let label = if label.is_empty() {
        Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    } else {
        label
    };
    Some(ArtifactRef {
        label,
        path: path.to_string(),
    })
}

fn is_url(path: &str) -> bool {
    path.starts_with("http://") || path.starts_with("https://")
}

/// 把产物路径落到磁盘上：在仓库里的文件给出大小，找不到就如实标 `exists=false`。
///
/// 路径来自卡片正文（不可信输入），所以这里只 stat，不读内容；越出仓库的路径
/// 一律拒绝，避免把工作区外的文件状态当看板信息展示出来。
pub fn resolve(root: &Path, refs: &[ArtifactRef]) -> Vec<super::model::TaskArtifact> {
    refs.iter()
        .map(|artifact| {
            let url = is_url(&artifact.path).then(|| artifact.path.clone());
            let file = url
                .is_none()
                .then(|| resolve_inside(root, &artifact.path))
                .flatten();
            let size = file
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok())
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len());
            super::model::TaskArtifact {
                label: artifact.label.clone(),
                path: artifact.path.clone(),
                exists: url.is_some() || size.is_some(),
                size,
                url,
            }
        })
        .collect()
}

/// 仓库内的**已存在文件**，用于「在文件管理器中显示」。
///
/// 卡片正文里的产物路径是不可信输入，这里除了越界检查还要确认它真的存在：
/// 把一个不存在的路径交结给系统，只会弹一个没有意义的错误。
pub fn within_workspace(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_inside(root, path).ok_or_else(|| "invalid-artifact".to_string())?;
    if !resolved.is_file() {
        return Err("artifact-not-found".into());
    }
    Ok(resolved)
}

/// 仓库内的绝对路径 / 相对路径，超出仓库一律 `None`。
fn resolve_inside(root: &Path, path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let normalized = normalize(&joined)?;
    let normalized_root = normalize(root)?;
    normalized
        .starts_with(&normalized_root)
        .then_some(normalized)
}

/// 消掉 `.` 与 `..`，不访问文件系统（`canonicalize` 会要求文件已经存在）。
fn normalize(path: &Path) -> Option<PathBuf> {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !output.pop() {
                    return None;
                }
            }
            other => output.push(other.as_os_str()),
        }
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(body: &str) -> Option<String> {
        outcome_section(body).map(|(_, text)| text)
    }

    const CARD: &str = "## Description\n\n做点事。\n\n## 结果\n\n整理出 7 条新闻，附来源。\n\n## 产物\n\n- `daily/2026-11-17.md` — 今日简报\n- [在线版本](https://example.com/report)\n- 见上面的说明\n\n## 执行记录\n\n跑了 3 分钟。\n";

    #[test]
    fn the_outcome_prefers_the_dedicated_section() {
        assert_eq!(outcome(CARD).as_deref(), Some("整理出 7 条新闻，附来源。"));
    }

    #[test]
    fn old_cards_fall_back_to_the_conclusion() {
        let body = "## Description\n\nx\n\n## Conclusion\n\n做完了，产物是 a.md。\n";
        assert_eq!(outcome(body).as_deref(), Some("做完了，产物是 a.md。"));
        // 被当成结果的那一段要能被准确指出来，正文才知道去重哪一段。
        assert_eq!(
            outcome_section(body).map(|(title, _)| title).as_deref(),
            Some("Conclusion")
        );
    }

    #[test]
    fn artifacts_come_only_from_the_artifact_section() {
        let items = artifacts(CARD);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].path, "daily/2026-11-17.md");
        assert_eq!(items[0].label, "今日简报");
        assert_eq!(items[1].path, "https://example.com/report");
        assert_eq!(items[1].label, "在线版本");
    }

    #[test]
    fn prose_is_not_mistaken_for_an_artifact() {
        let body = "## 产物\n\n- 这一轮没有生成文件\n- run tests\n";
        assert!(artifacts(body).is_empty());
    }

    #[test]
    fn paths_outside_the_repository_are_not_resolved() {
        let temp = tempfile::tempdir().unwrap();
        let refs = vec![
            ArtifactRef {
                label: "inside".into(),
                path: "report.md".into(),
            },
            ArtifactRef {
                label: "escape".into(),
                path: "../secret.md".into(),
            },
        ];
        std::fs::write(temp.path().join("report.md"), "hi").unwrap();
        let resolved = resolve(temp.path(), &refs);
        assert!(resolved[0].exists);
        assert_eq!(resolved[0].size, Some(2));
        assert!(!resolved[1].exists);
    }

    #[test]
    fn revealing_requires_a_file_inside_the_repository() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("a.md"), "x").unwrap();
        assert!(within_workspace(temp.path(), "a.md").is_ok());
        assert_eq!(
            within_workspace(temp.path(), "missing.md").unwrap_err(),
            "artifact-not-found"
        );
        assert_eq!(
            within_workspace(temp.path(), "../a.md").unwrap_err(),
            "invalid-artifact"
        );
    }

    #[test]
    fn duplicate_artifacts_are_listed_once() {
        let body = "## 产物\n\n- a.md\n- a.md\n- b.md\n";
        assert_eq!(artifacts(body).len(), 2);
    }
}
