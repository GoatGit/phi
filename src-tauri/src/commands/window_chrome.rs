/// Return the native traffic-light centre in webview logical coordinates.
/// Tauri's trafficLightPosition.y adjusts the titlebar container, not the
/// button centre, so the renderer must not treat it as a CSS top offset.
#[tauri::command]
pub fn get_window_controls_center_y(window: tauri::WebviewWindow) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};

        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        // Synchronous Tauri commands run on the main thread. The borrowed
        // NSWindow and its views remain owned by the live WebviewWindow.
        unsafe {
            let native = &*(pointer as *const NSWindow);
            // 全屏时系统把红绿灯移出常规标题栏，对 content view 的几何换算
            // 会得到接近内容区高度的值，把对齐元素推到底部；返回 None 让前端
            // 沿用上一次（或默认）的位置。
            if native
                .styleMask()
                .contains(NSWindowStyleMask::FullScreen)
            {
                return Ok(None);
            }
            let button = native
                .standardWindowButton(NSWindowButton::NSWindowCloseButton)
                .ok_or("Missing native close button")?;
            let content = native.contentView().ok_or("Missing content view")?;
            let rect = button.convertRect_toView(button.bounds(), Some(&content));
            let centre = rect.origin.y + rect.size.height / 2.0;
            let y = if content.isFlipped() {
                centre - content.bounds().origin.y
            } else {
                content.bounds().origin.y + content.bounds().size.height - centre
            };
            Ok(Some(y))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(None)
    }
}
