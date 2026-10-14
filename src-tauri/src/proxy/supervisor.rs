//! Own the listener task, including cancellation, port release and bounded restart.
//! This never retries a request; interrupted connections belong to their ledger guards.
use std::{
    future::Future,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::oneshot};

#[derive(Default)]
pub struct Health {
    pub state: &'static str,
    pub restarts: u32,
    pub heartbeat: Option<Instant>,
}
pub type SharedHealth = Arc<Mutex<Health>>;
struct AbortChild(tokio::task::AbortHandle);
impl Drop for AbortChild {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn heartbeat(health: &SharedHealth) {
    let mut value = health.lock().unwrap_or_else(|e| e.into_inner());
    value.heartbeat = Some(Instant::now());
    value.state = "listening";
}
fn state(health: &SharedHealth, next: &'static str) {
    health.lock().unwrap_or_else(|e| e.into_inner()).state = next;
}

pub async fn supervise<F, Fut>(
    listener: TcpListener,
    address: SocketAddr,
    health: SharedHealth,
    mut shutdown: oneshot::Receiver<()>,
    worker: F,
) where
    F: Fn(TcpListener, SharedHealth) -> Fut,
    Fut: Future<Output = std::io::Result<()>> + Send + 'static,
{
    let mut listener = Some(listener);
    let mut restart = 0;
    loop {
        if let Some(current) = listener.take() {
            heartbeat(&health);
            let mut child = tokio::spawn(worker(current, health.clone()));
            let _child_guard = AbortChild(child.abort_handle());
            let mut watchdog = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        child.abort(); let _ = child.await;
                        state(&health, "stopped"); return;
                    }
                    result = &mut child => {
                        log::warn!("[P-LISTENER-EXIT] listener task exited: {}", match result {
                            Ok(Ok(())) => "unexpected completion", Ok(Err(_)) => "accept failed", Err(_) => "task panic or cancellation"
                        });
                        break;
                    }
                    _ = watchdog.tick() => {
                        let stale = health.lock().unwrap_or_else(|e| e.into_inner()).heartbeat.is_none_or(|t| t.elapsed() > Duration::from_secs(15));
                        if stale {
                            child.abort(); let _ = child.await;
                            log::warn!("[P-LISTENER-STALE] listener heartbeat expired"); break;
                        }
                    }
                }
            }
            // The completed/aborted worker is awaited before any rebind.
        }
        if restart >= 3 {
            state(&health, "failed");
            return;
        }
        state(&health, "restarting");
        let delay = [100, 500, 1000][restart as usize];
        restart += 1;
        health.lock().unwrap_or_else(|e| e.into_inner()).restarts = restart;
        tokio::select! {
            biased;
            _ = &mut shutdown => { state(&health, "stopped"); return; }
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
        }
        listener = TcpListener::bind(address).await.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn panic_releases_port_and_restarts_then_shutdown_joins_the_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counts = calls.clone();
        let health: SharedHealth = Default::default();
        let observed = health.clone();
        let (tx, rx) = oneshot::channel();
        let handle = tokio::spawn(supervise(
            listener,
            address,
            health,
            rx,
            move |listener, health| {
                let calls = counts.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        panic!("injected listener panic");
                    }
                    heartbeat(&health);
                    let _keep_port = listener;
                    futures::future::pending::<std::io::Result<()>>().await
                }
            },
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(observed.lock().unwrap().restarts, 1);
        assert!(TcpListener::bind(address).await.is_err());
        tx.send(()).unwrap();
        handle.await.unwrap();
        assert!(TcpListener::bind(address).await.is_ok());
        assert_eq!(observed.lock().unwrap().state, "stopped");
    }
    #[tokio::test]
    async fn persistent_failure_has_a_finite_restart_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let health: SharedHealth = Default::default();
        let observed = health.clone();
        let (_tx, rx) = oneshot::channel();
        supervise(listener, address, health, rx, |listener, _| async move {
            drop(listener);
            Err(std::io::Error::other("injected"))
        })
        .await;
        assert_eq!(observed.lock().unwrap().state, "failed");
        assert_eq!(observed.lock().unwrap().restarts, 3);
        assert!(TcpListener::bind(address).await.is_ok());
    }
}
