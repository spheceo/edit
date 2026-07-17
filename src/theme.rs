use eframe::egui::{Color32, CornerRadius, Stroke};

pub const BLACK: Color32 = Color32::BLACK;
pub const SURFACE: Color32 = Color32::from_rgb(10, 10, 10);
pub const SURFACE_HOVER: Color32 = Color32::from_rgb(23, 23, 23);
pub const BORDER: Color32 = Color32::from_rgb(39, 39, 39);
pub const MUTED: Color32 = Color32::from_rgb(142, 142, 147);
pub const TEXT: Color32 = Color32::from_rgb(244, 244, 245);
pub const ACCENT: Color32 = Color32::from_rgb(52, 120, 246);
pub const PLAYHEAD: Color32 = Color32::from_rgb(255, 56, 92);
pub const CLIP: Color32 = Color32::from_rgb(35, 105, 205);
pub const AUDIO: Color32 = Color32::from_rgb(62, 130, 220);
pub const SELECTION: Color32 = Color32::from_rgb(242, 194, 65);

pub fn configure(ctx: &eframe::egui::Context) {
    let mut visuals = eframe::egui::Visuals::dark();
    visuals.override_text_color = Some(TEXT);
    visuals.panel_fill = BLACK;
    visuals.window_fill = BLACK;
    visuals.extreme_bg_color = BLACK;
    visuals.faint_bg_color = SURFACE;
    visuals.widgets.noninteractive.bg_fill = BLACK;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.inactive.bg_fill = SURFACE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.hovered.bg_fill = SURFACE_HOVER;
    visuals.widgets.active.bg_fill = Color32::from_rgb(31, 31, 31);
    visuals.window_corner_radius = CornerRadius::ZERO;
    visuals.window_shadow = eframe::egui::epaint::Shadow::NONE;
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.button_padding = [12.0, 6.0].into();
    style.spacing.item_spacing = [8.0, 8.0].into();
    ctx.set_style(style);
}
