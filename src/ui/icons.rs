use eframe::egui::{self, Align2, Color32, CornerRadius, FontId, Rect, Response, Sense, Vec2};

use super::theme;

#[derive(Clone, Copy)]
pub enum Icon {
    Select,
    Razor,
    Play,
    Pause,
    Previous,
    Next,
    Import,
    Undo,
    Redo,
    Info,
    Duplicate,
    Delete,
}

impl Icon {
    fn source(self) -> egui::ImageSource<'static> {
        match self {
            Self::Select => egui::include_image!("../../assets/icons/select.svg"),
            Self::Razor => egui::include_image!("../../assets/icons/razor.svg"),
            Self::Play => egui::include_image!("../../assets/icons/play.svg"),
            Self::Pause => egui::include_image!("../../assets/icons/pause.svg"),
            Self::Previous => egui::include_image!("../../assets/icons/previous.svg"),
            Self::Next => egui::include_image!("../../assets/icons/next.svg"),
            Self::Import => egui::include_image!("../../assets/icons/import.svg"),
            Self::Undo => egui::include_image!("../../assets/icons/undo.svg"),
            Self::Redo => egui::include_image!("../../assets/icons/redo.svg"),
            Self::Info => egui::include_image!("../../assets/icons/info.svg"),
            Self::Duplicate => egui::include_image!("../../assets/icons/duplicate.svg"),
            Self::Delete => egui::include_image!("../../assets/icons/delete.svg"),
        }
    }
}

pub fn menu_item(ui: &mut egui::Ui, icon: Icon, label: &str) -> Response {
    let desired = Vec2::new(ui.available_width().max(120.0), 30.0);
    let (rect, response) = ui.allocate_exact_size(desired, Sense::click());
    if ui.is_rect_visible(rect) {
        if response.hovered() {
            ui.painter()
                .rect_filled(rect, CornerRadius::same(7), theme::SURFACE_HOVER);
        }
        let icon_rect = Rect::from_center_size(
            egui::pos2(rect.left() + 15.0, rect.center().y),
            Vec2::splat(16.0),
        );
        // Allocate a real Image widget so SVG loaders paint inside popup menus.
        ui.put(
            icon_rect,
            egui::Image::new(icon.source())
                .fit_to_exact_size(icon_rect.size())
                .tint(theme::TEXT)
                .sense(Sense::hover()),
        );
        ui.painter().text(
            egui::pos2(rect.left() + 30.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            FontId::proportional(12.0),
            theme::TEXT,
        );
    }
    response.on_hover_cursor(egui::CursorIcon::PointingHand)
}

pub fn button(ui: &mut egui::Ui, icon: Icon, tooltip: &str, selected: bool) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::click());
    let enabled = ui.is_enabled();
    if enabled && (response.hovered() || response.is_pointer_button_down_on()) {
        ui.painter()
            .rect_filled(rect, CornerRadius::same(9), theme::SURFACE_HOVER);
    }
    let tint = if !enabled {
        theme::MUTED
    } else if selected {
        theme::ACCENT
    } else {
        theme::TEXT
    };
    paint(
        ui,
        icon,
        Rect::from_center_size(rect.center(), Vec2::splat(19.0)),
        tint,
    );
    let response = response.on_hover_text_at_pointer(tooltip);
    if enabled {
        response.on_hover_cursor(egui::CursorIcon::PointingHand)
    } else {
        response
    }
}

pub fn import_button(ui: &mut egui::Ui) -> Response {
    let size = Vec2::new(116.0, 34.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    if response.hovered() || response.is_pointer_button_down_on() {
        ui.painter()
            .rect_filled(rect, CornerRadius::same(9), theme::SURFACE_HOVER);
    }
    paint(
        ui,
        Icon::Import,
        Rect::from_center_size(
            egui::pos2(rect.left() + 18.0, rect.center().y),
            Vec2::splat(18.0),
        ),
        theme::TEXT,
    );
    ui.painter().text(
        egui::pos2(rect.left() + 34.0, rect.center().y),
        Align2::LEFT_CENTER,
        "Import video",
        FontId::proportional(13.0),
        Color32::WHITE,
    );
    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text_at_pointer("Import video")
}

pub fn paint(ui: &egui::Ui, icon: Icon, rect: Rect, tint: Color32) {
    egui::Image::new(icon.source())
        .fit_to_exact_size(rect.size())
        .tint(tint)
        .paint_at(ui, rect);
}
