//! 卡片里 `touched` / `forbidden` 用的极小 glob。
//!
//! 只需要覆盖人写路径时的几种直觉写法，不追求完整 glob 语法：
//! - `**` 跨任意多层目录（`src/auth/**`）；
//! - `*` / `?` 只在一层目录名里匹配（`tests/*.rs`）；
//! - 没有通配符时按目录前缀算（`src/auth` 覆盖 `src/auth/login.rs`）。

/// `pattern` 是否覆盖仓库相对路径 `path`。路径一律用 `/` 分隔。
pub fn matches(pattern: &str, path: &str) -> bool {
    let pattern = normalize(pattern);
    let path = normalize(path);
    if pattern.is_empty() || path.is_empty() {
        return false;
    }

    let segments: Vec<&str> = pattern.split('/').collect();
    let target: Vec<&str> = path.split('/').collect();
    if match_segments(&segments, &target) {
        return true;
    }

    // 写成目录（`src/auth`）时，按前缀覆盖它下面的文件
    !pattern.contains('*') && !pattern.contains('?') && path.starts_with(&format!("{pattern}/"))
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/')
        .replace('\\', "/")
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.first() {
        None => path.is_empty(),
        Some(&"**") => (0..=path.len()).any(|skip| match_segments(&pattern[1..], &path[skip..])),
        Some(segment) => match path.first() {
            None => false,
            Some(name) => match_segment(segment, name) && match_segments(&pattern[1..], &path[1..]),
        },
    }
}

fn match_segment(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    match_from(&pattern, &name)
}

fn match_from(pattern: &[char], name: &[char]) -> bool {
    match pattern.first() {
        None => name.is_empty(),
        Some('*') => (0..=name.len()).any(|skip| match_from(&pattern[1..], &name[skip..])),
        Some('?') => !name.is_empty() && match_from(&pattern[1..], &name[1..]),
        Some(expected) => name.first() == Some(expected) && match_from(&pattern[1..], &name[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn double_star_covers_whole_tree() {
        assert!(matches("src/auth/**", "src/auth/login.rs"));
        assert!(matches("src/auth/**", "src/auth/providers/oauth.rs"));
        assert!(!matches("src/auth/**", "src/billing/invoice.rs"));
    }

    #[test]
    fn single_star_stays_in_one_segment() {
        assert!(matches("tests/*.rs", "tests/auth.rs"));
        assert!(!matches("tests/*.rs", "tests/auth/login.rs"));
    }

    #[test]
    fn directory_prefix_counts_without_wildcards() {
        assert!(matches("src/auth", "src/auth/login.rs"));
        assert!(matches("./src/auth/", "src/auth/login.rs"));
        assert!(!matches("src/auth", "src/authentication.rs"));
    }

    #[test]
    fn matches_exact_file_and_question_mark() {
        assert!(matches("package.json", "package.json"));
        assert!(matches("src/?.rs", "src/a.rs"));
        assert!(!matches("src/?.rs", "src/ab.rs"));
    }
}
