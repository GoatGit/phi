//! 跨模块的同步互斥锁。
//!
//! 曾经服务 WebDAV/S3 配置同步（快照上传/下载、DB 与 Skills SSOT 还原），
//! 同步子系统移除后，剩余职责是让导入/导出与提示词回填互相串行：
//! 导入会整体替换数据库，提示词回填在这扇窗口内必须退回只读路径。

use std::sync::OnceLock;

/// 串行化导入/导出与受影响读写路径的全局锁。
pub(crate) fn sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sync_mutex_is_a_real_global_lock() {
        let guard = sync_mutex().lock().await;
        assert!(sync_mutex().try_lock().is_err());
        drop(guard);
        assert!(sync_mutex().try_lock().is_ok());
    }
}
