/// Return the native traffic-light centre in webview logical coordinates.
/// Tauri's trafficLightPosition.y adjusts the titlebar container, not the
/// button centre, so the renderer must not treat it as a CSS top offset.
#[tauri::command]
pub fn get_window_controls_center_y(window: tauri::WebviewWindow) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};

        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        // Synchronous Tauri commands run on the main thread. The borrowed
        // NSWindow and its views remain owned by the live WebviewWindow.
        unsafe {
            let native = &*(pointer as *const NSWindow);
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
