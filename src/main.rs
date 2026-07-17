mod app;
mod audio;
mod export;
mod icons;
mod media;
mod playback;
mod project;
mod sequence;
mod theme;
mod timeline;
mod ui;
mod waveform;

use app::VideoEditor;

fn main() -> eframe::Result<()> {
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
                .with_titlebar_buttons_shown(true),
            ..Default::default()
        },
        Box::new(|creation_context| {
            egui_extras::install_image_loaders(&creation_context.egui_ctx);
            theme::configure(&creation_context.egui_ctx);
            Ok(Box::new(VideoEditor::new()))
        }),
    )
}
