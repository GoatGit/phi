//! 带超时的子进程输出。
//!
//! `Command::output()` 没有时间上限：登录 shell 或工具自身卡住时，调用它的
//! Tokio worker 会一直被占用。版本探测和 Codex 模型目录都在请求/启动路径上，
//! 一旦外部命令不返回，整个本地网关就会停止响应。这里统一给一个上限，超时就
//! 连同子进程树一起杀掉并返回 `None`。

use std::io::{self, Read};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// 运行命令并等待它退出；超过 `timeout` 时杀掉它并返回 `Ok(None)`。
///
/// stdout/stderr 由独立线程持续读走，避免输出撑满管道后子进程卡住；子进程放在
/// 独立进程组里，超时按组击杀，防止 `zsh -lic codex …` 这类包装器死后留下后代。
pub(crate) fn output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> io::Result<Option<Output>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate(command);
    let mut child = command.spawn()?;
    let stdout = read_in_background(child.stdout.take());
    let stderr = read_in_background(child.stderr.take());
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            terminate(child);
            // 不 join 读线程：被终止的进程树里可能还有后代持有管道。
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Some(Output {
        status,
        stdout: stdout
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default(),
        stderr: stderr
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default(),
    }))
}

fn read_in_background(
    pipe: Option<impl Read + Send + 'static>,
) -> Option<std::thread::JoinHandle<Vec<u8>>> {
    pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    })
}

/// 子进程必须有独立进程组，超时才能整组杀掉；`setsid` 同时让它脱离控制终端，
/// 避免 `zsh -lic` 在后台进程组里被 SIGTTIN/SIGTTOU 停住。
#[cfg(unix)]
fn isolate(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: setsid 是 async-signal-safe；fork 出的子进程继承父进程组、必不是组长。
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn isolate(_: &mut Command) {}

fn terminate(mut child: Child) {
    #[cfg(unix)]
    {
        // SAFETY: isolate() 已把子进程放进自己的进程组。
        let _ = unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_program_is_reported_instead_of_timing_out() {
        let mut command = Command::new("phi-definitely-missing-command");
        let error = output_with_timeout(&mut command, Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_program_is_killed_at_the_deadline() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("sleep 5");
        let started = Instant::now();
        let output = output_with_timeout(&mut command, Duration::from_millis(150)).unwrap();
        assert!(output.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn output_larger_than_the_pipe_buffer_is_read() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("yes x | head -c 300000");
        let output = output_with_timeout(&mut command, Duration::from_secs(5))
            .unwrap()
            .expect("completed");
        assert_eq!(output.stdout.len(), 300_000);
    }
}
