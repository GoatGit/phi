//! Keep the main window's drag area reachable after moving or restoring it.
//!
//! Use work areas in physical desktop coordinates (including negative origins).
//! Do not constrain ordinary multi-monitor placement or change the window size.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

static RECOVERY_GENERATION: AtomicU64 = AtomicU64::new(0);
const SETTLE_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

impl Rect {
    fn from_physical(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Self {
        Self {
            x: position.x.into(),
            y: position.y.into(),
            width: size.width.into(),
            height: size.height.into(),
        }
    }

    fn overlap(self, other: Self) -> (i64, i64) {
        (
            ((self.x + self.width).min(other.x + other.width) - self.x.max(other.x)).max(0),
            ((self.y + self.height).min(other.y + other.height) - self.y.max(other.y)).max(0),
        )
    }
}

fn recovery_position(
    window: Rect,
    scale: f64,
    work_areas: &[Rect],
) -> Option<PhysicalPosition<i32>> {
    if window.width <= 0 || window.height <= 0 {
        return None;
    }
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let px = |logical: f64| (logical * scale).ceil() as i64;
    // Avoid counting only traffic lights / trailing action buttons as a usable
    // drag handle. The shell has a 44–52 logical-pixel header; native title bars
    // also provide a handle within this band.
    let left_inset = px(96.0).min(window.width / 4);
    let right_inset = px(160.0).min(window.width / 4);
    let handle = Rect {
        x: window.x + left_inset,
        y: window.y,
        width: window.width - left_inset - right_inset,
        height: px(40.0).min(window.height),
    };
    let required_width = px(160.0).min(handle.width);
    let required_height = px(24.0).min(handle.height);
    let areas = work_areas
        .iter()
        .filter(|area| area.width > 0 && area.height > 0);
    if areas.clone().any(|area| {
        let (width, height) = handle.overlap(*area);
        width >= required_width.min(area.width) && height >= required_height.min(area.height)
    }) {
        return None;
    }

    // Bring an unreachable window fully onto the closest usable display where
    // possible. Oversized windows stay at their current size, aligned top-left.
    // Minimize movement, rather than always sending the window to the primary.
    let (x, y) = areas
        .map(|area| {
            let x = window
                .x
                .clamp(area.x, (area.x + area.width - window.width).max(area.x));
            let y = window
                .y
                .clamp(area.y, (area.y + area.height - window.height).max(area.y));
            let dx = i128::from(x - window.x);
            let dy = i128::from(y - window.y);
            (dx * dx + dy * dy, x, y)
        })
        .min_by_key(|(distance, _, _)| *distance)
        .map(|(_, x, y)| (x, y))?;
    let position = PhysicalPosition::new(i32::try_from(x).ok()?, i32::try_from(y).ok()?);
    (x != window.x || y != window.y).then_some(position)
}

/// Queue a check after native move/resize/restore events settle. Geometry calls
/// run on the UI thread, outside window-state plugin callbacks and their locks.
/// A newer request cancels older checks, including ones from destroyed windows.
pub(crate) fn schedule_recovery(app: &AppHandle) {
    let generation = RECOVERY_GENERATION
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE_DELAY).await;
        if RECOVERY_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let ui_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if RECOVERY_GENERATION.load(Ordering::Relaxed) != generation {
                return;
            }
            // macOS can pause move events while the native drag loop is still
            // active. Wait for mouse-up instead of moving beneath the pointer.
            #[cfg(target_os = "macos")]
            if unsafe { objc2_app_kit::NSEvent::pressedMouseButtons() } & 1 != 0 {
                schedule_recovery(&ui_app);
                return;
            }
            if let Err(error) = recover_main_window(&ui_app) {
                // Some compositors (notably Wayland) do not expose positions.
                // Leave their placement policy alone when geometry is unavailable.
                log::debug!("Could not check main window visibility: {error}");
            }
        });
    });
}

fn recover_main_window(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if !window.is_visible()?
        || window.is_minimized()?
        || window.is_fullscreen()?
        || window.is_maximized()?
    {
        return Ok(());
    }
    let scale = window.scale_factor()?;
    let bounds = Rect::from_physical(window.outer_position()?, window.outer_size()?);
    let areas = main_work_areas(&window, scale)?;
    if let Some(position) = recovery_position(bounds, scale, &areas) {
        window.set_position(position)?;
        log::debug!("Recovered main window to ({}, {})", position.x, position.y);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main_work_areas(window: &tauri::WebviewWindow, _scale: f64) -> tauri::Result<Vec<Rect>> {
    Ok(window
        .available_monitors()?
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Rect::from_physical(area.position, area.size)
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn main_work_areas(window: &tauri::WebviewWindow, scale: f64) -> tauri::Result<Vec<Rect>> {
    use objc2_app_kit::{NSScreen, NSWindow};

    // SAFETY: Called only on the UI thread with a live Tauri NSWindow. Converting
    // its reference into a MainThreadMarker proves the NSScreen call is on it.
    let native_window = unsafe { &*(window.ns_window()? as *const NSWindow) };
    let screens = NSScreen::screens(native_window.into());
    let Some(primary) = screens.first() else {
        return Ok(Vec::new());
    };
    let primary_frame = primary.frame();
    let desktop_top = primary_frame.origin.y + primary_frame.size.height;
    Ok((0..screens.len())
        .filter_map(|index| screens.get(index))
        .map(|screen| {
            let visible = screen.visibleFrame();
            cocoa_work_area(
                desktop_top,
                (visible.origin.x, visible.origin.y),
                (visible.size.width, visible.size.height),
                scale,
            )
        })
        .collect())
}

#[cfg(any(target_os = "macos", test))]
fn cocoa_work_area(desktop_top: f64, origin: (f64, f64), size: (f64, f64), scale: f64) -> Rect {
    // Tao scales each display's global origin by that display's scale, but the
    // window position by the window's scale. Normalize all displays to the
    // latter to avoid false overlaps/gaps on mixed Retina/non-Retina desktops.
    // Read visibleFrame directly: Tauri 2.10's work_area omits the top inset.
    Rect::from_physical(
        tauri::LogicalPosition::new(origin.0, desktop_top - origin.1 - size.1).to_physical(scale),
        tauri::LogicalSize::new(size.0, size.1).to_physical(scale),
    )
}

#[cfg(test)]
mod tests;
