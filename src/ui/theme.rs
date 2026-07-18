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

pub fn configure(ctx: &eframe::egui::Context) {
    // Kuro owns its palette. Never allow the operating system's current
    // appearance to swap egui back to its built-in light visuals.
    ctx.set_theme(eframe::egui::ThemePreference::Dark);
    let mut visuals = eframe::egui::Visuals::dark();
    visuals.dark_mode = true;
    visuals.override_text_color = Some(TEXT);
    visuals.panel_fill = BLACK;
    visuals.window_fill = BLACK;
    visuals.extreme_bg_color = BLACK;
    visuals.faint_bg_color = SURFACE;
    visuals.widgets.noninteractive.bg_fill = BLACK;
    visuals.widgets.noninteractive.weak_bg_fill = BLACK;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.inactive.bg_fill = SURFACE;
    visuals.widgets.inactive.weak_bg_fill = SURFACE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.hovered.bg_fill = SURFACE_HOVER;
    visuals.widgets.hovered.weak_bg_fill = SURFACE_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(62, 62, 66));
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.active.bg_fill = Color32::from_rgb(31, 31, 31);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(31, 31, 31);
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, Color32::from_rgb(78, 78, 82));
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.open.bg_fill = SURFACE_HOVER;
    visuals.widgets.open.weak_bg_fill = SURFACE_HOVER;
    visuals.widgets.open.bg_stroke = Stroke::new(1.0, Color32::from_rgb(62, 62, 66));
    visuals.widgets.open.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.selection.bg_fill = ACCENT;
    visuals.selection.stroke = Stroke::new(1.0, Color32::WHITE);
    visuals.window_stroke = Stroke::new(1.0, BORDER);
    visuals.window_corner_radius = CornerRadius::ZERO;
    visuals.window_shadow = eframe::egui::epaint::Shadow::NONE;
    visuals.popup_shadow = eframe::egui::epaint::Shadow::NONE;
    visuals.hyperlink_color = ACCENT;
    visuals.code_bg_color = SURFACE;
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.button_padding = [12.0, 6.0].into();
    style.spacing.item_spacing = [8.0, 8.0].into();
    ctx.set_style(style);
}
