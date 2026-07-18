use eframe::egui::{Color32, CornerRadius, Stroke};

pub const BLACK: Color32 = Color32::BLACK;
pub const SURFACE: Color32 = Color32::from_rgb(10, 10, 10);
pub const SURFACE_HOVER: Color32 = Color32::from_rgb(23, 23, 23);
pub const BORDER: Color32 = Color32::from_rgb(39, 39, 39);
pub const MUTED: Color32 = Color32::from_rgb(142, 142, 147);
pub const TEXT: Color32 = Color32::from_rgb(244, 244, 245);
pub const ACCENT: Color32 = Color32::from_rgb(52, 120, 246);
pub const PLAYHEAD: Color32 = Color32::from_rgb(255, 56, 92);
pub const SELECTION: Color32 = Color32::from_rgb(242, 194, 65);

/// Shared corner radius for interactive widgets (buttons, combos, fields).
pub const CONTROL_RADIUS: u8 = 8;
/// Popup / menu corner radius — keep in step with control radius.
pub const MENU_RADIUS: u8 = 8;

pub fn configure(ctx: &eframe::egui::Context) {
    // Unclip owns its palette. Never allow the operating system's current
    // appearance to swap egui back to its built-in light visuals.
    ctx.set_theme(eframe::egui::ThemePreference::Dark);
    let mut visuals = eframe::egui::Visuals::dark();
    visuals.dark_mode = true;
    visuals.override_text_color = Some(TEXT);
    visuals.panel_fill = BLACK;
    visuals.window_fill = BLACK;
    visuals.extreme_bg_color = BLACK;
    visuals.faint_bg_color = SURFACE;

    let radius = CornerRadius::same(CONTROL_RADIUS);
    // Quiet chrome: fill changes on hover/open, not a thicker/brighter border ring.
    let quiet_stroke = Stroke::new(1.0, BORDER);

    visuals.widgets.noninteractive.bg_fill = BLACK;
    visuals.widgets.noninteractive.weak_bg_fill = BLACK;
    visuals.widgets.noninteractive.bg_stroke = quiet_stroke;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.noninteractive.corner_radius = radius;
    visuals.widgets.noninteractive.expansion = 0.0;

    visuals.widgets.inactive.bg_fill = SURFACE;
    visuals.widgets.inactive.weak_bg_fill = SURFACE;
    visuals.widgets.inactive.bg_stroke = quiet_stroke;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.inactive.corner_radius = radius;
    visuals.widgets.inactive.expansion = 0.0;

    visuals.widgets.hovered.bg_fill = SURFACE_HOVER;
    visuals.widgets.hovered.weak_bg_fill = SURFACE_HOVER;
    visuals.widgets.hovered.bg_stroke = quiet_stroke;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.hovered.corner_radius = radius;
    visuals.widgets.hovered.expansion = 0.0;

    visuals.widgets.active.bg_fill = Color32::from_rgb(31, 31, 31);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(31, 31, 31);
    visuals.widgets.active.bg_stroke = quiet_stroke;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.active.corner_radius = radius;
    visuals.widgets.active.expansion = 0.0;

    // Open state must match inactive/hovered radius — otherwise ComboBox snaps
    // from rounded (8) to egui's default ~2 when the popup opens.
    visuals.widgets.open.bg_fill = SURFACE_HOVER;
    visuals.widgets.open.weak_bg_fill = SURFACE_HOVER;
    visuals.widgets.open.bg_stroke = quiet_stroke;
    visuals.widgets.open.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.open.corner_radius = radius;
    visuals.widgets.open.expansion = 0.0;

    visuals.selection.bg_fill = Color32::from_rgb(32, 48, 78);
    visuals.selection.stroke = Stroke::NONE;
    visuals.window_stroke = Stroke::new(1.0, BORDER);
    visuals.window_corner_radius = CornerRadius::ZERO;
    visuals.menu_corner_radius = CornerRadius::same(MENU_RADIUS);
    visuals.window_shadow = eframe::egui::epaint::Shadow::NONE;
    visuals.popup_shadow = eframe::egui::epaint::Shadow::NONE;
    visuals.hyperlink_color = ACCENT;
    visuals.code_bg_color = SURFACE;
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.button_padding = [12.0, 6.0].into();
    style.spacing.item_spacing = [8.0, 8.0].into();
    style.spacing.combo_height = 220.0;
    ctx.set_style(style);
}
