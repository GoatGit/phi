//! 插件脚本沙箱。
//!
//! 脚本插件是「用户提供的 JSON 变换函数」，不是可信代码：
//! - 每次执行都是独立 `Runtime`，不跨请求保留任何状态；
//! - 内存、栈、执行时间都有硬上限，超时由解释器中断器打断；
//! - 宿主不注入任何能力（没有 fetch、没有文件系统），脚本只能读写传进去的 JSON。
//!
//! 形状与 `usage_script` 的沙箱一致：两边都是不可信脚本，限制口径要能对齐。

use std::fmt;
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Runtime};
use serde_json::Value;

/// 脚本必须导出的入口函数名。
pub const ENTRY_FUNCTION: &str = "onRequest";

/// 沙箱限制。
#[derive(Debug, Clone, Copy)]
pub struct SandboxLimits {
    /// 单次执行的最长时间。
    pub timeout: Duration,
    /// QuickJS 堆内存上限。
    pub memory_bytes: usize,
    /// 脚本栈上限。
    pub stack_bytes: usize,
    /// 输入/输出 JSON 的字符数上限。
    pub max_payload_chars: usize,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(150),
            memory_bytes: 16 * 1024 * 1024,
            stack_bytes: 256 * 1024,
            max_payload_chars: 512 * 1024,
        }
    }
}

/// 沙箱执行失败的原因。
///
/// 调用方（阶段）只把它降级成「本次不生效 + 一条告警」：插件是增强，
/// 不能因为一个坏脚本让用户请求失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    PayloadTooLarge { limit: usize, actual: usize },
    Runtime(String),
    Compile(String),
    EntryMissing,
    Execution(String),
    OutputTooLarge { limit: usize, actual: usize },
    OutputNotJson(String),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge { limit, actual } => {
                write!(formatter, "请求体超过插件上限（{actual} > {limit} 字符）")
            }
            Self::Runtime(message) => write!(formatter, "创建 JS 运行时失败: {message}"),
            Self::Compile(message) => write!(formatter, "脚本编译失败: {message}"),
            Self::EntryMissing => write!(formatter, "脚本没有导出函数 {ENTRY_FUNCTION}"),
            Self::Execution(message) => write!(formatter, "脚本执行失败: {message}"),
            Self::OutputTooLarge { limit, actual } => {
                write!(formatter, "脚本输出超过上限（{actual} > {limit} 字符）")
            }
            Self::OutputNotJson(message) => write!(formatter, "脚本输出不是合法 JSON: {message}"),
        }
    }
}

impl std::error::Error for SandboxError {}

/// 在沙箱里执行请求钩子。
///
/// 返回 `Ok(None)` 表示脚本显式返回 `undefined` / `null`（保持原样），
/// `Ok(Some(value))` 表示用脚本返回值替换请求体。
pub fn run_request_script(
    script: &str,
    payload: &Value,
    limits: &SandboxLimits,
) -> Result<Option<Value>, SandboxError> {
    let payload_json = serde_json::to_string(payload)
        .map_err(|err| SandboxError::Execution(format!("请求体序列化失败: {err}")))?;
    let payload_chars = payload_json.chars().count();
    if payload_chars > limits.max_payload_chars {
        return Err(SandboxError::PayloadTooLarge {
            limit: limits.max_payload_chars,
            actual: payload_chars,
        });
    }

    let deadline = Instant::now()
        .checked_add(limits.timeout)
        .ok_or_else(|| SandboxError::Runtime("无法计算执行截止时间".to_string()))?;

    let runtime = Runtime::new().map_err(|err| SandboxError::Runtime(err.to_string()))?;
    runtime.set_memory_limit(limits.memory_bytes);
    runtime.set_max_stack_size(limits.stack_bytes);
    // 中断器每轮解释器循环检查一次：死循环脚本由此变成「超时」而不是「挂住代理」。
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));

    let context = Context::full(&runtime).map_err(|err| SandboxError::Runtime(err.to_string()))?;
    context.with(|ctx| {
        ctx.eval::<(), _>(script.as_bytes())
            .map_err(|err| SandboxError::Compile(err.to_string()))?;
        let function: Function = ctx
            .globals()
            .get(ENTRY_FUNCTION)
            .map_err(|_| SandboxError::EntryMissing)?;
        let argument = ctx
            .json_parse(payload_json.as_str())
            .map_err(|err| SandboxError::Execution(err.to_string()))?;
        let returned: rquickjs::Value = function
            .call((argument,))
            .map_err(|err| SandboxError::Execution(err.to_string()))?;
        if returned.is_undefined() || returned.is_null() {
            return Ok(None);
        }
        let serialized = ctx
            .json_stringify(returned)
            .map_err(|err| SandboxError::Execution(err.to_string()))?
            .ok_or_else(|| SandboxError::OutputNotJson("JSON.stringify 返回空".to_string()))?;
        let serialized = serialized
            .to_string()
            .map_err(|err| SandboxError::Execution(err.to_string()))?;
        let output_chars = serialized.chars().count();
        if output_chars > limits.max_payload_chars {
            return Err(SandboxError::OutputTooLarge {
                limit: limits.max_payload_chars,
                actual: output_chars,
            });
        }
        serde_json::from_str(serialized.as_str())
            .map(Some)
            .map_err(|err| SandboxError::OutputNotJson(err.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits() -> SandboxLimits {
        SandboxLimits {
            timeout: Duration::from_millis(200),
            ..SandboxLimits::default()
        }
    }

    #[test]
    fn returns_transformed_payload() {
        let script = r#"
            function onRequest(request) {
                request.model = String(request.model).toUpperCase();
                request.extra = Object.keys(request).length;
                delete request.dropMe;
                return request;
            }
        "#;
        let result = run_request_script(script, &json!({"model":"gpt","dropMe":true}), &limits())
            .expect("script runs");
        let body = result.expect("script returned a value");
        assert_eq!(body["model"], json!("GPT"));
        assert_eq!(body["extra"], json!(2));
        assert!(body.get("dropMe").is_none());
    }

    #[test]
    fn undefined_return_keeps_the_request_unchanged() {
        let result = run_request_script(
            "function onRequest() { return undefined; }",
            &json!({"a":1}),
            &limits(),
        )
        .expect("script runs");
        assert!(result.is_none());
    }

    #[test]
    fn missing_entry_function_is_reported() {
        let err = run_request_script("var x = 1;", &json!({}), &limits()).unwrap_err();
        assert!(matches!(err, SandboxError::EntryMissing), "{err}");
    }

    #[test]
    fn runtime_errors_do_not_escape_as_panics() {
        let err = run_request_script(
            "function onRequest() { throw new Error('boom'); }",
            &json!({}),
            &limits(),
        )
        .unwrap_err();
        assert!(matches!(err, SandboxError::Execution(_)), "{err}");
    }

    #[test]
    fn infinite_loops_hit_the_timeout() {
        let started = Instant::now();
        let err = run_request_script(
            "function onRequest() { while (true) {} }",
            &json!({}),
            &SandboxLimits {
                timeout: Duration::from_millis(50),
                ..SandboxLimits::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, SandboxError::Execution(_)), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "interrupt handler did not fire"
        );
    }

    #[test]
    fn oversized_payloads_are_rejected_before_execution() {
        let err = run_request_script(
            "function onRequest(request) { return request; }",
            &json!({"blob": "x".repeat(64)}),
            &SandboxLimits {
                max_payload_chars: 16,
                ..SandboxLimits::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, SandboxError::PayloadTooLarge { .. }), "{err}");
    }

    #[test]
    fn non_json_script_output_is_rejected() {
        let err = run_request_script(
            "function onRequest() { return function () {}; }",
            &json!({}),
            &limits(),
        )
        .unwrap_err();
        assert!(matches!(err, SandboxError::OutputNotJson(_)), "{err}");
    }

    #[test]
    fn scripts_do_not_inherit_state_between_runs() {
        let script = r#"
            globalThis.calls = (globalThis.calls || 0) + 1;
            function onRequest(request) { request.calls = globalThis.calls; return request; }
        "#;
        let first = run_request_script(script, &json!({}), &limits())
            .unwrap()
            .unwrap();
        let second = run_request_script(script, &json!({}), &limits())
            .unwrap()
            .unwrap();
        assert_eq!(first["calls"], json!(1));
        assert_eq!(second["calls"], json!(1));
    }
}
