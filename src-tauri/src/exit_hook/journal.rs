//! 退出记账的读写：`terminal/session.sh` 追加行，这里只做严格解析。
//!
//! 一行五个 TAB 分隔字段：终端会话 id、退出码、秒级时间戳、应用、cwd。
//! 任何字段不合规就整行丢弃——journal 在用户可写的配置目录里，
//! 不能让它变成一条注入通道（路径、应用名都会被下游拿去启动进程）。

use super::MAX_JOURNAL_LINE_BYTES;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExitRecord {
    pub terminal_id: String,
    pub app_id: String,
    pub exit_code: i32,
    /// 秒级时间戳（journal 由 shell 写，秒精度够用）。
    pub at: i64,
    pub cwd: String,
}

pub(crate) fn parse_line(line: &str) -> Option<ExitRecord> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() || line.len() > MAX_JOURNAL_LINE_BYTES {
        return None;
    }
    let mut fields = line.splitn(5, '\t');
    let terminal_id = fields.next()?.trim();
    let exit_code = fields.next()?.trim();
    let at = fields.next()?.trim();
    let app_id = fields.next()?.trim();
    let cwd = fields.next()?.trim();

    if uuid::Uuid::parse_str(terminal_id).is_err() {
        return None;
    }
    let exit_code: i32 = exit_code.parse().ok()?;
    // shell 的退出码是 0..=255，信号中断会被折成 128+N；超出这个区间的只能是被写脏了。
    if !(0..=255).contains(&exit_code) {
        return None;
    }
    let at: i64 = at.parse().ok()?;
    if at <= 0 {
        return None;
    }
    if crate::terminal::is_cli_app(app_id).is_err() {
        return None;
    }
    if cwd.is_empty() || cwd.len() > 4096 || cwd.contains('\0') || !Path::new(cwd).is_absolute() {
        return None;
    }
    Some(ExitRecord {
        terminal_id: terminal_id.to_string(),
        app_id: app_id.to_string(),
        exit_code,
        at,
        cwd: cwd.to_string(),
    })
}

/// 从 `offset` 读到文件尾，最多返回 `max_lines` 行（空行不计）。返回新行与
/// 下一次该用的偏移。
///
/// 只消费**完整**的行：journal 由另一个进程追加写入，读到的最后一段可能只写了
/// 一半。把偏移停在这半行之前，下一轮补全后再读，这次退出就不会被丢掉。
/// 单行非法 UTF-8 也只丢那一行——不能用一行脏数据牵连整批记账。
///
/// 文件被截断/轮转（当前长度小于偏移）时从头读，避免永远停在错误位置。
pub(crate) fn read_new_lines(path: &Path, offset: u64, max_lines: usize) -> (Vec<String>, u64) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (Vec::new(), 0);
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = if len < offset { 0 } else { offset };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (Vec::new(), start);
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return (Vec::new(), start);
    }
    let mut consumed = 0usize;
    let mut lines: Vec<String> = Vec::new();
    while consumed < bytes.len() && lines.len() < max_lines {
        let Some(end) = bytes[consumed..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let line = &bytes[consumed..consumed + end];
        consumed += end + 1;
        if !line.is_empty() {
            lines.push(String::from_utf8_lossy(line).into_owned());
        }
    }
    (lines, start + consumed as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    fn line(exit: &str, app: &str, cwd: &str) -> String {
        format!("{ID}\t{exit}\t1762900000\t{app}\t{cwd}")
    }

    #[test]
    fn parses_a_real_record() {
        let record = parse_line(&line("1", "claude", "/tmp/project")).expect("record");
        assert_eq!(record.terminal_id, ID);
        assert_eq!(record.app_id, "claude");
        assert_eq!(record.exit_code, 1);
        assert_eq!(record.at, 1_762_900_000);
        assert_eq!(record.cwd, "/tmp/project");
    }

    #[test]
    fn keeps_tabs_that_belong_to_cwd() {
        // cwd 里出现 TAB 时 splitn(5) 把剩下的全部留给最后一个字段。
        let record = parse_line(&format!("{ID}\t0\t1762900000\tcodex\t/tmp/a\tb")).expect("record");
        assert_eq!(record.cwd, "/tmp/a\tb");
    }

    #[test]
    fn rejects_records_that_could_steer_the_launch() {
        for bad in [
            String::new(),
            "not-a-uuid\t1\t1762900000\tclaude\t/tmp".to_string(),
            // 应用名只能是 terminal 认识的那几个，别的一律不认
            line("1", "claude; rm -rf /", "/tmp"),
            line("1", "shell", "/tmp"),
            // 退出码越界 / 非数字
            line("256", "claude", "/tmp"),
            line("-1", "claude", "/tmp"),
            line("boom", "claude", "/tmp"),
            // 时间戳非法
            format!("{ID}\t1\t0\tclaude\t/tmp"),
            format!("{ID}\t1\tyesterday\tclaude\t/tmp"),
            // 相对路径 / 空路径
            line("1", "claude", "relative/dir"),
            line("1", "claude", ""),
            // 字段缺失
            format!("{ID}\t1\t1762900000\tclaude"),
        ] {
            assert!(parse_line(&bad).is_none(), "should reject: {bad:?}");
        }
    }

    #[test]
    fn oversized_lines_are_dropped() {
        let long = format!("{ID}\t1\t1762900000\tclaude\t/{}", "a".repeat(9000));
        assert!(parse_line(&long).is_none());
    }

    #[test]
    fn reads_only_the_appended_bytes() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.log");
        std::fs::write(&path, format!("{}\n", line("0", "claude", "/tmp"))).unwrap();
        let (lines, offset) = read_new_lines(&path, 0, usize::MAX);
        assert_eq!(lines.len(), 1);
        assert_eq!(offset, path.metadata().unwrap().len());

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(format!("{}\n", line("1", "codex", "/tmp")).as_bytes())
            .unwrap();
        let (lines, offset) = read_new_lines(&path, offset, usize::MAX);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\tcodex\t"));
        assert_eq!(offset, path.metadata().unwrap().len());
    }

    #[test]
    fn a_half_written_line_waits_instead_of_being_consumed() {
        // journal 是另一个进程追加写的，读到的最后一段可能只写了一半。
        // 这半行一旦被消费掉，那次退出事件就永远丢了。
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.log");
        let full = line("1", "claude", "/tmp");
        let (head, tail) = full.split_at(20);
        std::fs::write(&path, head).unwrap();

        let (lines, offset) = read_new_lines(&path, 0, usize::MAX);
        assert!(lines.is_empty());
        assert_eq!(offset, 0, "半行不能被消费");

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(format!("{tail}\n").as_bytes())
            .unwrap();
        let (lines, offset) = read_new_lines(&path, offset, usize::MAX);
        assert_eq!(lines.len(), 1, "补全后必须能读到这一行");
        assert_eq!(
            parse_line(&lines[0]).map(|record| record.exit_code),
            Some(1)
        );
        assert_eq!(offset, path.metadata().unwrap().len());
    }

    #[test]
    fn a_capped_batch_leaves_the_rest_for_the_next_round() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.log");
        let mut file = std::fs::File::create(&path).unwrap();
        for app in ["claude", "codex", "gemini"] {
            writeln!(file, "{}", line("1", app, "/tmp")).unwrap();
        }
        drop(file);

        let (lines, offset) = read_new_lines(&path, 0, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("\tcodex\t"));
        assert!(offset < path.metadata().unwrap().len());

        let (lines, offset) = read_new_lines(&path, offset, 2);
        assert_eq!(lines.len(), 1, "上一轮没读的记账不能丢");
        assert!(lines[0].contains("\tgemini\t"));
        assert_eq!(offset, path.metadata().unwrap().len());
    }

    #[test]
    fn truncation_resets_the_offset_instead_of_going_blind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.log");
        std::fs::write(&path, format!("{}\n", line("0", "claude", "/tmp"))).unwrap();
        let (_, offset) = read_new_lines(&path, 0, usize::MAX);
        assert!(offset > 0);

        // 文件被清空（我们自己的轮转或用户手动清理）：不能停在旧偏移上装死。
        std::fs::write(&path, "").unwrap();
        let (lines, reset) = read_new_lines(&path, offset, usize::MAX);
        assert!(lines.is_empty());
        assert_eq!(reset, 0, "offset 必须回到文件头");

        std::fs::write(&path, format!("{}\n", line("2", "claude", "/tmp"))).unwrap();
        let (lines, new_offset) = read_new_lines(&path, reset, usize::MAX);
        assert_eq!(lines.len(), 1, "重写后的文件必须从开头读");
        assert_eq!(new_offset, path.metadata().unwrap().len());
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let (lines, offset) =
            read_new_lines(Path::new("/nonexistent/phi/journal.log"), 0, usize::MAX);
        assert!(lines.is_empty());
        assert_eq!(offset, 0);
    }
}
