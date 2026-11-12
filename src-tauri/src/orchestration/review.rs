//! 门 3 的证据锚点：复查意见必须能落到「文件 + 行号 + 原文引用」。
//!
//! 复查 agent 把意见写进卡片正文的 `phi-review` 围栏里，一行一条，
//! 形如 `- src/auth/login.rs:42 | fn login(`（竖线右边是那一行的原文）。
//!
//! PHI 只做一件事：把每条锚点拿去和仓库里的真实源码对一遍。对不上就是
//! `invalid`——复查意见没有可校验的证据，不能被当成通过。

use std::path::{Path, PathBuf};

use super::model::ClaimCheck;

/// 复查意见里的一条证据锚点。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub file: String,
    pub line: usize,
    pub quote: String,
}

/// 从卡片正文里取出所有 `phi-review` 围栏中的锚点。读不懂的行直接跳过。
pub fn claims(body: &str) -> Vec<Claim> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if !inside {
            if trimmed.starts_with("```phi-review") {
                inside = true;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            inside = false;
            continue;
        }
        if let Some(claim) = parse_claim(trimmed) {
            out.push(claim);
        }
    }
    out
}

fn parse_claim(line: &str) -> Option<Claim> {
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line)
        .trim();
    let (anchor, quote) = line.split_once('|')?;
    let (file, number) = anchor.trim().rsplit_once(':')?;
    let line_no: usize = number.trim().parse().ok()?;
    let file = file.trim().trim_start_matches("./").to_string();
    let quote = quote.trim().to_string();
    if file.is_empty() || quote.is_empty() || line_no == 0 {
        return None;
    }
    Some(Claim {
        file,
        line: line_no,
        quote,
    })
}

/// 逐个核对锚点：文件在工作区内、行号在范围内、那一行确实包含引用的原文。
pub fn verify(root: &Path, claims: &[Claim]) -> Vec<ClaimCheck> {
    claims
        .iter()
        .map(|claim| match resolve(root, &claim.file) {
            Err(reason) => ClaimCheck {
                file: claim.file.clone(),
                line: claim.line,
                quote: claim.quote.clone(),
                ok: false,
                actual: None,
                reason: Some(reason.to_string()),
            },
            Ok(path) => {
                let text =
                    String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default()).to_string();
                let lines: Vec<&str> = text.lines().collect();
                let Some(actual) = lines.get(claim.line - 1) else {
                    return ClaimCheck {
                        file: claim.file.clone(),
                        line: claim.line,
                        quote: claim.quote.clone(),
                        ok: false,
                        actual: None,
                        reason: Some("line-out-of-range".to_string()),
                    };
                };
                let ok = collapse(actual).contains(&collapse(&claim.quote));
                ClaimCheck {
                    file: claim.file.clone(),
                    line: claim.line,
                    quote: claim.quote.clone(),
                    ok,
                    actual: Some(truncate(actual.trim(), 200)),
                    reason: (!ok).then(|| "quote-not-found".to_string()),
                }
            }
        })
        .collect()
}

/// 把仓库相对路径解析成真实文件路径，并保证没有越出工作区。
fn resolve(root: &Path, file: &str) -> Result<PathBuf, &'static str> {
    if file.is_empty() || Path::new(file).is_absolute() {
        return Err("outside-workspace");
    }
    if file.split(['/', '\\']).any(|segment| segment == "..") {
        return Err("outside-workspace");
    }
    let base = root.canonicalize().map_err(|_| "outside-workspace")?;
    let path = root.join(file);
    let canonical = path.canonicalize().map_err(|_| "file-not-found")?;
    if !canonical.starts_with(&base) {
        return Err("outside-workspace");
    }
    if !canonical.is_file() {
        return Err("file-not-found");
    }
    Ok(canonical)
}

/// 比较前抹平空白差异：换行、缩进、制表符都不该影响「是不是同一段原文」。
fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_claims_and_ignores_prose() {
        let body = "## Review\n\n我看了实现，觉得还行。\n\n```phi-review\n- src/auth/login.rs:42 | fn login(\nsrc/auth/session.rs:18 | expire_at\n这不是锚点\n```\n\n完。\n";
        let claims = claims(body);
        assert_eq!(claims.len(), 2);
        assert_eq!(claims[0].file, "src/auth/login.rs");
        assert_eq!(claims[0].line, 42);
        assert_eq!(claims[0].quote, "fn login(");
        assert_eq!(claims[1].line, 18);
    }

    #[test]
    fn no_fence_means_no_claims() {
        assert!(claims("## Review\n\nsrc/auth/login.rs:42 | fn login(\n").is_empty());
    }

    #[test]
    fn verifies_real_anchor() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(
            root.path().join("src/login.rs"),
            "pub fn login(\n    name: &str,\n) {}\n",
        )
        .unwrap();

        let checks = verify(
            root.path(),
            &[Claim {
                file: "src/login.rs".into(),
                line: 1,
                quote: "pub fn login(".into(),
            }],
        );
        assert!(checks[0].ok, "{checks:?}");
        assert_eq!(checks[0].actual.as_deref(), Some("pub fn login("));
    }

    #[test]
    fn rejects_wrong_line_missing_file_and_escape() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("a.rs"), "fn a() {}\n").unwrap();

        let checks = verify(
            root.path(),
            &[
                Claim {
                    file: "a.rs".into(),
                    line: 2,
                    quote: "fn a() {}".into(),
                },
                Claim {
                    file: "missing.rs".into(),
                    line: 1,
                    quote: "x".into(),
                },
                Claim {
                    file: "../etc/passwd".into(),
                    line: 1,
                    quote: "root".into(),
                },
            ],
        );
        assert_eq!(checks[0].reason.as_deref(), Some("line-out-of-range"));
        assert_eq!(checks[1].reason.as_deref(), Some("file-not-found"));
        assert_eq!(checks[2].reason.as_deref(), Some("outside-workspace"));
        assert!(checks.iter().all(|check| !check.ok));
    }

    #[test]
    fn whitespace_differences_still_match() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("a.rs"), "    old   value,\n").unwrap();
        let checks = verify(
            root.path(),
            &[Claim {
                file: "a.rs".into(),
                line: 1,
                quote: "old value,".into(),
            }],
        );
        assert!(checks[0].ok, "{checks:?}");
    }
}
