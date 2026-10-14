use super::*;

fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

const DESKTOP: Rect = Rect {
    x: 0,
    y: 25,
    width: 1440,
    height: 835,
};

#[test]
fn preserves_reachable_and_partially_offscreen_windows() {
    for (x, y) in [(100, 100), (-400, 100), (900, 100), (100, 700), (100, 15)] {
        assert_eq!(
            recovery_position(rect(x, y, 1000, 650), 1.0, &[DESKTOP]),
            None
        );
    }
}

#[test]
fn recovers_each_edge_when_header_is_unreachable() {
    for (x, y, expected_x, expected_y) in [
        (-990, 100, 0, 100),
        (1430, 100, 440, 100),
        (100, -100, 100, 25),
        (100, 850, 100, 210),
        (4000, -3000, 440, 25),
    ] {
        assert_eq!(
            recovery_position(rect(x, y, 1000, 650), 1.0, &[DESKTOP]),
            Some(PhysicalPosition::new(expected_x, expected_y))
        );
    }
}

#[test]
fn visible_body_does_not_make_a_hidden_header_reachable() {
    assert_eq!(
        recovery_position(rect(100, -200, 1000, 650), 1.0, &[DESKTOP]),
        Some(PhysicalPosition::new(100, 25))
    );
}

#[test]
fn visible_buttons_alone_do_not_count_as_a_drag_handle() {
    assert!(recovery_position(rect(-850, 100, 1000, 650), 1.0, &[DESKTOP]).is_some());
    assert!(recovery_position(rect(1340, 100, 1000, 650), 1.0, &[DESKTOP]).is_some());
}

#[test]
fn supports_negative_and_stacked_monitor_origins() {
    let areas = [
        DESKTOP,
        rect(-1920, -200, 1920, 1080),
        rect(0, -1080, 1920, 1055),
    ];
    for (x, y) in [(-1600, -100), (200, -1000), (-400, 100)] {
        assert_eq!(recovery_position(rect(x, y, 1000, 650), 1.0, &areas), None);
    }
    assert_eq!(
        recovery_position(rect(-2500, -800, 1000, 650), 1.0, &areas),
        Some(PhysicalPosition::new(-1920, -200))
    );
}

#[test]
fn monitor_gap_recovers_to_nearest_display() {
    let areas = [DESKTOP, rect(3000, 25, 1920, 1055)];
    assert_eq!(
        recovery_position(rect(2500, 1500, 1000, 650), 1.0, &areas),
        Some(PhysicalPosition::new(3000, 430))
    );
}

#[test]
fn unplugged_display_recovers_to_remaining_work_area() {
    assert_eq!(
        recovery_position(rect(-1800, 100, 1000, 650), 1.0, &[DESKTOP]),
        Some(PhysicalPosition::new(0, 100))
    );
}

#[test]
fn respects_taskbars_and_menu_bars() {
    let area = rect(80, 30, 1280, 770);
    assert_eq!(
        recovery_position(rect(0, -200, 1000, 650), 1.0, &[area]),
        Some(PhysicalPosition::new(80, 30))
    );
}

#[test]
fn uses_window_scale_for_handle_size_on_mixed_dpi_desktop() {
    let areas = [rect(0, 50, 2880, 1700), rect(-1920, 25, 1920, 1055)];
    assert_eq!(
        recovery_position(rect(-1500, 100, 2000, 1300), 2.0, &areas),
        None
    );
    assert_eq!(
        recovery_position(rect(2600, 100, 2000, 1300), 2.0, &areas),
        Some(PhysicalPosition::new(880, 100))
    );
}

#[test]
fn cocoa_work_area_accounts_for_menu_bar_and_dock() {
    // Primary screen is 900pt high: 30pt menu bar and 50pt bottom Dock.
    let area = cocoa_work_area(900.0, (0.0, 50.0), (1440.0, 820.0), 2.0);
    assert_eq!(
        (area.x, area.y, area.width, area.height),
        (0, 60, 2880, 1640)
    );
    assert_eq!(
        recovery_position(rect(200, -200, 2000, 1300), 2.0, &[area]),
        Some(PhysicalPosition::new(200, 60))
    );
}

#[test]
fn cocoa_displays_share_window_scale_even_when_display_scales_differ() {
    // A non-Retina monitor to the left/above a Retina primary. Cocoa coordinates
    // are points regardless of that monitor's backing scale.
    let area = cocoa_work_area(900.0, (-1920.0, 0.0), (1920.0, 1050.0), 2.0);
    assert_eq!(
        (area.x, area.y, area.width, area.height),
        (-3840, -300, 3840, 2100)
    );
    assert_eq!(
        recovery_position(rect(-3500, -200, 2000, 1300), 2.0, &[area]),
        None
    );
}

#[test]
fn oversized_window_is_aligned_without_resizing() {
    assert_eq!(
        recovery_position(rect(100, -1000, 2000, 1400), 1.0, &[DESKTOP]),
        Some(PhysicalPosition::new(0, 25))
    );
    assert_eq!(
        recovery_position(rect(0, 25, 2000, 1400), 1.0, &[DESKTOP]),
        None
    );
}

#[test]
fn missing_or_empty_geometry_is_a_noop() {
    let window = rect(5000, 5000, 1000, 650);
    assert_eq!(recovery_position(window, 1.0, &[]), None);
    assert_eq!(recovery_position(window, 1.0, &[rect(0, 0, 0, 0)]), None);
    assert_eq!(recovery_position(rect(0, 0, 0, 0), 1.0, &[DESKTOP]), None);
}

#[test]
fn correction_is_idempotent_across_screen_edges_and_scales() {
    let areas = [DESKTOP, rect(-1920, -500, 1920, 1080)];
    for scale in [1.0, 1.25, 2.0, f64::NAN] {
        for x in [-5000, -1920, -1000, -10, 0, 1400, 3000] {
            for y in [-3000, -500, -100, 25, 800, 2000] {
                let mut window = rect(x, y, 1000, 650);
                if let Some(position) = recovery_position(window, scale, &areas) {
                    window.x = position.x.into();
                    window.y = position.y.into();
                    assert_eq!(recovery_position(window, scale, &areas), None);
                }
            }
        }
    }
}
