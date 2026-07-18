mod app;
mod media;
mod native_menu;
mod project;
mod ui;

use app::VideoEditor;

fn main() -> eframe::Result<()> {
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../assets/brand/kuro-icon.png"))
        .expect("Kuro app icon must be a valid PNG");

    eframe::run_native(
        "Kuro",
        eframe::NativeOptions {
            viewport: eframe::egui::ViewportBuilder::default()
                .with_min_inner_size([900.0, 600.0])
                .with_maximized(true)
                // On macOS this lets our black surface extend through the native title bar.
                .with_fullsize_content_view(true)
                .with_title_shown(false)
                .with_titlebar_shown(false)
                .with_titlebar_buttons_shown(true)
                .with_icon(icon),
            ..Default::default()
        },
        Box::new(|creation_context| {
            egui_extras::install_image_loaders(&creation_context.egui_ctx);
            ui::theme::configure(&creation_context.egui_ctx);
            Ok(Box::new(VideoEditor::new()))
        }),
    )
}
