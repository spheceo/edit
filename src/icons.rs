use eframe::egui::{self, Align2, Color32, CornerRadius, FontId, Rect, Response, Sense, Vec2};

use crate::theme;

#[derive(Clone, Copy)]
pub enum Icon {
    Select,
    Razor,
    Play,
    Pause,
    Previous,
    Next,
    Import,
}

impl Icon {
    fn source(self) -> egui::ImageSource<'static> {
        match self {
            Self::Select => egui::include_image!("../assets/icons/select.svg"),
            Self::Razor => egui::include_image!("../assets/icons/razor.svg"),
            Self::Play => egui::include_image!("../assets/icons/play.svg"),
            Self::Pause => egui::include_image!("../assets/icons/pause.svg"),
            Self::Previous => egui::include_image!("../assets/icons/previous.svg"),
            Self::Next => egui::include_image!("../assets/icons/next.svg"),
            Self::Import => egui::include_image!("../assets/icons/import.svg"),
        }
    }
}

pub fn button(ui: &mut egui::Ui, icon: Icon, tooltip: &str, selected: bool) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::click());
    if response.hovered() || response.is_pointer_button_down_on() {
        ui.painter()
            .rect_filled(rect, CornerRadius::same(9), theme::SURFACE_HOVER);
    }
    let tint = if selected { theme::ACCENT } else { theme::TEXT };
    paint(
        ui,
        icon,
        Rect::from_center_size(rect.center(), Vec2::splat(19.0)),
        tint,
    );
    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text_at_pointer(tooltip)
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
