use eframe::egui::{
    self, Align, Align2, Color32, CornerRadius, FontId, Frame, Layout, Margin, Pos2, Rect,
    RichText, Sense, Stroke, StrokeKind, Vec2,
};

use crate::{
    app::VideoEditor,
    export::{ExportQuality, ExportResolution},
    icons::{self, Icon},
    sequence::EditTool,
    theme, timeline,
};

pub fn startup(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::CentralPanel::default()
        .frame(Frame::new().fill(theme::BLACK))
        .show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space((ui.available_height() * 0.13).max(40.0));
                ui.heading(RichText::new("Kuro").size(34.0).strong());
                ui.label(RichText::new("A precise, local video editor").color(theme::MUTED));
                ui.add_space(28.0);
                ui.horizontal(|ui| {
                    let width = ui.available_width();
                    ui.add_space(((width - 360.0) * 0.5).max(0.0));
                    if ui
                        .add(dialog_primary_button("New Project"))
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        app.new_project_draft = crate::project::NewProjectDraft::default();
                        app.new_project_dialog_open = true;
                    }
                    if ui
                        .add(dialog_secondary_button("Open Project"))
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        app.open_project_picker(ctx);
                    }
                });
                ui.add_space(34.0);
                ui.allocate_ui(Vec2::new(520.0, ui.available_height()), |ui| {
                    ui.label(RichText::new("Recent Projects").size(15.0).strong());
                    ui.add_space(8.0);
                    if app.recent_projects.is_empty() {
                        ui.label(RichText::new("No recent projects yet").color(theme::MUTED));
                    }
                    let recent = app.recent_projects.clone();
                    for project in recent {
                        let path = project.path.clone();
                        let response = ui.add_sized(
                            [ui.available_width(), 52.0],
                            egui::Button::new(
                                RichText::new(format!(
                                    "{}\n{}",
                                    project.name,
                                    project.path.display()
                                ))
                                .color(theme::TEXT),
                            )
                            .fill(Color32::from_rgb(10, 10, 11))
                            .stroke(Stroke::new(1.0, theme::BORDER))
                            .corner_radius(CornerRadius::same(9)),
                        );
                        if response
                            .on_hover_cursor(egui::CursorIcon::PointingHand)
                            .clicked()
                        {
                            app.open_project_path(path, ctx);
                        }
                        ui.add_space(6.0);
                    }
                    if let Some(status) = &app.status {
                        ui.add_space(12.0);
                        ui.label(RichText::new(status).color(theme::PLAYHEAD));
                    }
                });
            });
        });
}

pub fn new_project_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    if !app.new_project_dialog_open {
        return;
    }
    let mut open = true;
    let mut close_requested = false;
    let mut create_requested = false;
    egui::Window::new("new-project-dialog")
        .title_bar(false)
        .collapsible(false)
        .resizable(false)
        .movable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .frame(dialog_frame())
        .default_width(470.0)
        .open(&mut open)
        .show(ctx, |ui| {
            style_dialog_controls(ui);
            dialog_header(ui, "New Project", &mut close_requested);
            ui.add_space(14.0);
            ui.label(RichText::new("Project name").small().color(theme::MUTED));
            ui.add_sized(
                [ui.available_width(), 34.0],
                egui::TextEdit::singleline(&mut app.new_project_draft.name),
            );
            ui.add_space(10.0);
            ui.label(RichText::new("Location").small().color(theme::MUTED));
            ui.horizontal(|ui| {
                ui.add_sized(
                    [ui.available_width() - 92.0, 34.0],
                    egui::Label::new(
                        RichText::new(app.new_project_draft.directory.display().to_string())
                            .color(theme::MUTED),
                    )
                    .truncate(),
                );
                if ui.add(dialog_secondary_button("Choose…")).clicked() {
                    app.choose_project_directory();
                }
            });
            ui.add_space(10.0);
            ui.columns(2, |columns| {
                columns[0].label(RichText::new("Aspect ratio").small().color(theme::MUTED));
                egui::ComboBox::from_id_salt("project-aspect")
                    .selected_text(app.new_project_draft.settings.aspect_label())
                    .width(columns[0].available_width())
                    .show_ui(&mut columns[0], |ui| {
                        for (label, width, height) in [
                            ("16:9", 16, 9),
                            ("9:16", 9, 16),
                            ("1:1", 1, 1),
                            ("4:3", 4, 3),
                        ] {
                            if ui
                                .selectable_label(
                                    app.new_project_draft.settings.aspect_width == width
                                        && app.new_project_draft.settings.aspect_height == height,
                                    label,
                                )
                                .clicked()
                            {
                                let was_portrait = app.new_project_draft.settings.aspect_height
                                    > app.new_project_draft.settings.aspect_width;
                                let will_be_portrait = height > width;
                                if was_portrait != will_be_portrait {
                                    std::mem::swap(
                                        &mut app.new_project_draft.settings.width,
                                        &mut app.new_project_draft.settings.height,
                                    );
                                }
                                app.new_project_draft.settings.aspect_width = width;
                                app.new_project_draft.settings.aspect_height = height;
                            }
                        }
                    });
                columns[1].label(RichText::new("Frame rate").small().color(theme::MUTED));
                egui::ComboBox::from_id_salt("project-frame-rate")
                    .selected_text(format!("{} fps", app.new_project_draft.settings.frame_rate))
                    .width(columns[1].available_width())
                    .show_ui(&mut columns[1], |ui| {
                        for fps in [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0] {
                            ui.selectable_value(
                                &mut app.new_project_draft.settings.frame_rate,
                                fps,
                                format!("{fps} fps"),
                            );
                        }
                    });
            });
            ui.add_space(10.0);
            ui.label(RichText::new("Resolution").small().color(theme::MUTED));
            ui.horizontal(|ui| {
                ui.add(
                    egui::DragValue::new(&mut app.new_project_draft.settings.width)
                        .range(64..=7680),
                );
                ui.label("×");
                ui.add(
                    egui::DragValue::new(&mut app.new_project_draft.settings.height)
                        .range(64..=4320),
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    egui::ComboBox::from_id_salt("project-resolution-preset")
                        .selected_text("Presets")
                        .show_ui(ui, |ui| {
                            for (label, width, height) in [
                                ("720p", 1280, 720),
                                ("1080p", 1920, 1080),
                                ("1440p", 2560, 1440),
                                ("4K", 3840, 2160),
                            ] {
                                if ui.button(label).clicked() {
                                    let portrait = app.new_project_draft.settings.aspect_height
                                        > app.new_project_draft.settings.aspect_width;
                                    app.new_project_draft.settings.width =
                                        if portrait { height } else { width };
                                    app.new_project_draft.settings.height =
                                        if portrait { width } else { height };
                                }
                            }
                        });
                });
            });
            ui.add_space(20.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.add(dialog_primary_button("Create Project")).clicked() {
                    create_requested = true;
                }
                if ui.add(dialog_secondary_button("Cancel")).clicked() {
                    close_requested = true;
                }
            });
        });
    app.new_project_dialog_open &= open && !close_requested;
    if create_requested {
        app.create_project(ctx);
    }
}

pub fn missing_media_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    let Some(media) = app.missing_media.clone() else {
        return;
    };
    egui::Window::new("missing-media-dialog")
        .title_bar(false)
        .collapsible(false)
        .resizable(false)
        .movable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .frame(dialog_frame())
        .default_width(430.0)
        .show(ctx, |ui| {
            style_dialog_controls(ui);
            ui.heading(RichText::new("Media is offline").strong());
            ui.add_space(8.0);
            ui.label(format!("Kuro could not find {}.", media.name));
            ui.label(
                RichText::new(media.path.display().to_string())
                    .small()
                    .color(theme::MUTED),
            );
            ui.add_space(18.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.add(dialog_primary_button("Relink Media…")).clicked() {
                    app.relink_missing_media(ctx);
                }
            });
        });
}

pub fn title_bar(ctx: &egui::Context) {
    egui::TopBottomPanel::top("title_bar")
        .exact_height(36.0)
        .frame(Frame::new().fill(theme::BLACK).inner_margin(Margin::ZERO))
        .show(ctx, |ui| {
            let rect = ui.max_rect();
            let drag = ui.interact(rect, ui.id().with("window_drag"), Sense::click_and_drag());
            if drag.drag_started() || drag.double_clicked() {
                if drag.double_clicked() {
                    let maximized = ctx.input(|input| input.viewport().maximized.unwrap_or(false));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
                } else {
                    ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
                }
            }
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                "KURO",
                FontId::proportional(12.0),
                theme::MUTED,
            );
        });
}

pub fn toolbar(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::TopBottomPanel::top("toolbar")
        .exact_height(52.0)
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::symmetric(16, 8))
                .stroke(Stroke::new(1.0, theme::BORDER)),
        )
        .show(ctx, |ui| {
            ui.horizontal_centered(|ui| {
                if icons::import_button(ui).clicked() {
                    app.import_video(ctx);
                }

                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if let Some(progress) = app.export_job.as_ref().map(|job| job.progress()) {
                        if ui.button("Cancel").clicked() {
                            app.cancel_export();
                        }
                        ui.add(
                            egui::ProgressBar::new(progress)
                                .desired_width(180.0)
                                .show_percentage(),
                        );
                    } else if ui
                        .add_enabled(
                            app.video.is_some(),
                            egui::Button::new(RichText::new("Export").strong())
                                .fill(theme::ACCENT)
                                .stroke(Stroke::NONE)
                                .corner_radius(CornerRadius::same(9))
                                .min_size(Vec2::new(96.0, 34.0)),
                        )
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        app.open_export();
                    }
                    if let Some(message) = &app.export_message {
                        ui.label(RichText::new(message).small().color(theme::MUTED));
                    }
                });
            });
        });
}

pub fn export_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    if !app.export_dialog_open {
        return;
    }
    let sequence_format = app.sequence_format();
    let Some(video) = app.video.as_ref() else {
        app.export_dialog_open = false;
        return;
    };
    let has_audio = video.has_audio;
    let mut open = app.export_dialog_open;
    let mut choose_destination = false;
    let mut close_requested = false;
    egui::Window::new("export-video-dialog")
        .title_bar(false)
        .collapsible(false)
        .resizable(false)
        .movable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .frame(dialog_frame())
        .default_width(390.0)
        .open(&mut open)
        .show(ctx, |ui| {
            style_dialog_controls(ui);
            dialog_header(ui, "Export video", &mut close_requested);
            ui.add_space(12.0);
            ui.label(RichText::new("Format").small().color(theme::MUTED));
            ui.label("MP4 video · AAC audio");
            ui.add_space(8.0);

            ui.label(RichText::new("Resolution").small().color(theme::MUTED));
            egui::ComboBox::from_id_salt("export-resolution")
                .selected_text(app.export_settings.resolution.label())
                .width(ui.available_width())
                .show_ui(ui, |ui| {
                    for resolution in ExportResolution::ALL {
                        ui.selectable_value(
                            &mut app.export_settings.resolution,
                            resolution,
                            resolution.label(),
                        );
                    }
                });
            let (width, height) = app
                .export_settings
                .resolution
                .dimensions(video, sequence_format);
            ui.label(
                RichText::new(format!("{width} × {height}"))
                    .small()
                    .color(theme::MUTED),
            );
            ui.add_space(8.0);

            ui.label(RichText::new("Quality").small().color(theme::MUTED));
            egui::ComboBox::from_id_salt("export-quality")
                .selected_text(app.export_settings.quality.label())
                .width(ui.available_width())
                .show_ui(ui, |ui| {
                    for quality in ExportQuality::ALL {
                        ui.selectable_value(
                            &mut app.export_settings.quality,
                            quality,
                            quality.label(),
                        );
                    }
                });
            ui.add_space(8.0);
            ui.add_enabled(
                has_audio,
                egui::Checkbox::new(&mut app.export_settings.include_audio, "Include audio"),
            );

            ui.add_space(16.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui
                    .add(dialog_primary_button("Choose destination…"))
                    .on_hover_cursor(egui::CursorIcon::PointingHand)
                    .clicked()
                {
                    choose_destination = true;
                }
                if ui
                    .add(dialog_secondary_button("Cancel"))
                    .on_hover_cursor(egui::CursorIcon::PointingHand)
                    .clicked()
                {
                    app.export_dialog_open = false;
                }
            });
        });
    app.export_dialog_open &= open && !close_requested;
    if choose_destination {
        app.choose_export_destination(ctx);
    }
}

pub fn media_info_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    let Some(clip_id) = app.media_info_clip else {
        return;
    };
    let (Some(video), Some(clip)) = (
        app.video.as_ref(),
        app.sequence
            .as_ref()
            .and_then(|sequence| sequence.clip(clip_id)),
    ) else {
        app.media_info_clip = None;
        return;
    };
    let mut open = true;
    let mut close_requested = false;
    egui::Window::new("clip-info-dialog")
        .title_bar(false)
        .collapsible(false)
        .resizable(false)
        .movable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .frame(dialog_frame())
        .default_width(420.0)
        .open(&mut open)
        .show(ctx, |ui| {
            style_dialog_controls(ui);
            dialog_header(ui, "Clip info", &mut close_requested);
            ui.add_space(12.0);
            egui::Grid::new("clip-info-grid")
                .num_columns(2)
                .spacing(Vec2::new(24.0, 9.0))
                .show(ui, |ui| {
                    info_row(ui, "File", &video.name);
                    info_row(
                        ui,
                        "Resolution",
                        &format!("{} × {}", video.source_width, video.source_height),
                    );
                    info_row(
                        ui,
                        "Aspect ratio",
                        &aspect_ratio_label(video.source_width, video.source_height),
                    );
                    info_row(ui, "Frame rate", &format!("{:.2} fps", video.fps));
                    info_row(ui, "Video codec", &video.video_codec);
                    info_row(
                        ui,
                        "Clip duration",
                        &timecode(clip.timeline_end - clip.timeline_start, video.fps),
                    );
                    info_row(ui, "Source duration", &timecode(video.duration, video.fps));
                    if let Some(codec) = &video.audio_codec {
                        info_row(ui, "Audio codec", codec);
                    }
                    if let Some(rate) = video.audio_sample_rate {
                        info_row(
                            ui,
                            "Audio sample rate",
                            &format!("{:.1} kHz", rate as f64 / 1_000.0),
                        );
                    }
                    if let Some(channels) = video.audio_channels {
                        let label = match channels {
                            1 => "Mono".to_owned(),
                            2 => "Stereo".to_owned(),
                            count => format!("{count} channels"),
                        };
                        info_row(ui, "Audio channels", &label);
                    }
                    if let Some(bitrate) = video.audio_bitrate {
                        info_row(ui, "Audio bitrate", &format!("{} kb/s", bitrate / 1_000));
                    }
                    if let Some(bytes) = video.file_size {
                        info_row(ui, "File size", &format_file_size(bytes));
                    }
                });
        });
    if !open || close_requested {
        app.media_info_clip = None;
    }
}

fn dialog_frame() -> Frame {
    Frame::new()
        .fill(theme::BLACK)
        .stroke(Stroke::new(1.0, theme::BORDER))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::same(20))
}

fn style_dialog_controls(ui: &mut egui::Ui) {
    let visuals = ui.visuals_mut();
    visuals.widgets.inactive.bg_fill = Color32::from_rgb(18, 18, 20);
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, Color32::from_rgb(52, 52, 56));
    visuals.widgets.inactive.corner_radius = CornerRadius::same(8);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(30, 30, 34);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(78, 78, 84));
    visuals.widgets.hovered.corner_radius = CornerRadius::same(8);
    visuals.widgets.active.bg_fill = Color32::from_rgb(38, 38, 42);
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, theme::ACCENT);
    visuals.widgets.active.corner_radius = CornerRadius::same(8);
    ui.spacing_mut().button_padding = Vec2::new(14.0, 8.0);
    ui.spacing_mut().combo_height = 34.0;
}

fn dialog_primary_button(label: &str) -> egui::Button<'_> {
    egui::Button::new(RichText::new(label).strong())
        .fill(theme::ACCENT)
        .stroke(Stroke::NONE)
        .corner_radius(CornerRadius::same(9))
        .min_size(Vec2::new(154.0, 34.0))
}

fn dialog_secondary_button(label: &str) -> egui::Button<'_> {
    egui::Button::new(label)
        .fill(Color32::from_rgb(20, 20, 22))
        .stroke(Stroke::new(1.0, Color32::from_rgb(55, 55, 60)))
        .corner_radius(CornerRadius::same(9))
        .min_size(Vec2::new(82.0, 34.0))
}

fn dialog_header(ui: &mut egui::Ui, title: &str, close_requested: &mut bool) {
    ui.horizontal(|ui| {
        ui.heading(RichText::new(title).strong());
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if ui
                .add(
                    egui::Button::new(RichText::new("×").size(22.0))
                        .frame(false)
                        .corner_radius(CornerRadius::same(8)),
                )
                .on_hover_cursor(egui::CursorIcon::PointingHand)
                .clicked()
            {
                *close_requested = true;
            }
        });
    });
}

fn info_row(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.label(RichText::new(label).color(theme::MUTED));
    ui.label(value);
    ui.end_row();
}

fn aspect_ratio_label(width: usize, height: usize) -> String {
    let divisor = gcd(width, height).max(1);
    format!("{}:{}", width / divisor, height / divisor)
}

fn gcd(mut left: usize, mut right: usize) -> usize {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn format_file_size(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    if bytes as f64 >= GIB {
        format!("{:.2} GB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

pub fn preview(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::CentralPanel::default()
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::same(18)),
        )
        .show(ctx, |ui| {
            let controls_height = 46.0;
            let preview_size = Vec2::new(
                ui.available_width(),
                (ui.available_height() - controls_height).max(100.0),
            );
            let (canvas, _) = ui.allocate_exact_size(preview_size, Sense::hover());
            ui.painter()
                .rect_filled(canvas, CornerRadius::same(4), theme::SURFACE);

            if let (Some(video), Some(texture)) = (&app.video, &app.texture) {
                let format = app.sequence_format();
                let project_frame = aspect_fit(
                    canvas.shrink(12.0),
                    format.width as f32 / format.height.max(1) as f32,
                );
                ui.painter()
                    .rect_filled(project_frame, CornerRadius::ZERO, Color32::BLACK);
                let image_rect = aspect_fit(project_frame, video.aspect_ratio());
                ui.painter().image(
                    texture.id(),
                    image_rect,
                    Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                    Color32::WHITE,
                );
            } else if app.video.is_none() {
                ui.painter().text(
                    canvas.center(),
                    Align2::CENTER_CENTER,
                    "Import a video to begin",
                    FontId::proportional(14.0),
                    theme::MUTED,
                );
            }
            ui.painter().rect_stroke(
                canvas,
                CornerRadius::same(4),
                Stroke::new(1.0, theme::BORDER),
                StrokeKind::Inside,
            );

            ui.allocate_ui_with_layout(
                Vec2::new(ui.available_width(), controls_height),
                Layout::left_to_right(Align::Center),
                |ui| {
                    let fps = app.frame_rate();
                    ui.columns(3, |columns| {
                        columns[0].with_layout(Layout::left_to_right(Align::Center), |ui| {
                            current_timecode_editor(ui, ctx, app, fps);
                            ui.add_space(14.0);
                            if icons::button(
                                ui,
                                Icon::Select,
                                "Select tool (V)",
                                app.tool == EditTool::Select,
                            )
                            .clicked()
                            {
                                app.tool = EditTool::Select;
                            }
                            if icons::button(
                                ui,
                                Icon::Razor,
                                "Razor tool (C)",
                                app.tool == EditTool::Razor,
                            )
                            .clicked()
                            {
                                app.tool = EditTool::Razor;
                            }
                        });
                        columns[1].with_layout(Layout::left_to_right(Align::Center), |ui| {
                            let group_width = 34.0 * 3.0 + ui.spacing().item_spacing.x * 2.0;
                            ui.add_space(((ui.available_width() - group_width) * 0.5).max(0.0));
                            if icons::button(ui, Icon::Previous, "Go to sequence start", false)
                                .clicked()
                            {
                                app.seek(0.0, ctx);
                            }
                            let (icon, tooltip) = if app.playing {
                                (Icon::Pause, "Pause (Space)")
                            } else {
                                (Icon::Play, "Play (Space)")
                            };
                            if icons::button(ui, icon, tooltip, false).clicked() {
                                app.toggle_playback(ctx);
                            }
                            if icons::button(ui, Icon::Next, "Go to sequence end", false).clicked()
                            {
                                app.seek(app.duration(), ctx);
                            }
                        });
                        columns[2].with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let total = app.duration();
                            ui.label(
                                RichText::new(timecode(total, fps))
                                    .monospace()
                                    .color(theme::MUTED),
                            );
                            ui.add_space(12.0);
                            timeline::zoom_controls(ui, app);
                        });
                    });
                },
            );
        });
}

fn current_timecode_editor(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    app: &mut VideoEditor,
    fps: f64,
) {
    if !app.timecode_editing {
        let response = ui
            .add(
                egui::Label::new(
                    RichText::new(timecode(app.current_time, fps))
                        .monospace()
                        .color(theme::TEXT),
                )
                .sense(Sense::click()),
            )
            .on_hover_cursor(egui::CursorIcon::Text)
            .on_hover_text_at_pointer("Click to enter a timecode");
        if response.clicked() {
            if app.playing {
                app.pause(ctx);
            }
            app.timecode_input = timecode(app.current_time, fps);
            app.timecode_editing = true;
            app.timecode_select_all = true;
            app.timecode_error = false;
        }
        return;
    }

    let id = ui.make_persistent_id("current-timecode-input");
    let color = if app.timecode_error {
        theme::PLAYHEAD
    } else {
        theme::TEXT
    };
    let mut output = egui::TextEdit::singleline(&mut app.timecode_input)
        .id(id)
        .desired_width(112.0)
        .font(egui::TextStyle::Monospace)
        .text_color(color)
        .show(ui);
    if app.timecode_select_all {
        output.response.request_focus();
        output
            .state
            .cursor
            .set_char_range(Some(egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(app.timecode_input.chars().count()),
            )));
        output.state.store(ui.ctx(), output.response.id);
        app.timecode_select_all = false;
    }

    let pressed_enter =
        output.response.has_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
    let pressed_escape =
        output.response.has_focus() && ui.input(|input| input.key_pressed(egui::Key::Escape));
    let lost_focus = output.response.lost_focus();
    if pressed_escape {
        app.timecode_editing = false;
        app.timecode_error = false;
        app.timecode_input = timecode(app.current_time, fps);
    } else if pressed_enter || lost_focus {
        if let Some(seconds) = parse_timecode(&app.timecode_input, fps) {
            app.timecode_editing = false;
            app.timecode_error = false;
            app.seek(seconds, ctx);
        } else {
            app.timecode_error = true;
            app.timecode_select_all = true;
        }
    } else if output.response.changed() {
        app.timecode_error = false;
    }
}

fn aspect_fit(bounds: Rect, aspect: f32) -> Rect {
    let aspect = aspect.max(0.01);
    let bounds_aspect = bounds.width() / bounds.height().max(1.0);
    let size = if bounds_aspect > aspect {
        Vec2::new(bounds.height() * aspect, bounds.height())
    } else {
        Vec2::new(bounds.width(), bounds.width() / aspect)
    };
    Rect::from_center_size(bounds.center(), size)
}

pub fn timecode(seconds: f64, fps: f64) -> String {
    let nominal_fps = fps.round().clamp(1.0, 99.0) as u64;
    let total_frames = (seconds.max(0.0) * fps.max(1.0)).round() as u64;
    let frames = total_frames % nominal_fps;
    let total_seconds = total_frames / nominal_fps;
    format!(
        "{:02}:{:02}:{:02}:{:02}",
        total_seconds / 3600,
        (total_seconds / 60) % 60,
        total_seconds % 60,
        frames
    )
}

pub fn parse_timecode(value: &str, fps: f64) -> Option<f64> {
    let parts: Vec<_> = value.trim().split(':').collect();
    let [hours, minutes, seconds, frames] = parts.as_slice() else {
        return None;
    };
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<u64>().ok()?;
    let frames = frames.parse::<u64>().ok()?;
    let nominal_fps = fps.round().clamp(1.0, 99.0) as u64;
    if minutes >= 60 || seconds >= 60 || frames >= nominal_fps {
        return None;
    }
    Some((hours * 3600 + minutes * 60 + seconds) as f64 + frames as f64 / fps.max(1.0))
}

#[cfg(test)]
mod tests {
    use eframe::egui::{Pos2, Rect};

    use super::{aspect_fit, parse_timecode, timecode};

    #[test]
    fn portrait_media_is_fitted_without_stretching() {
        let bounds = Rect::from_min_max(Pos2::ZERO, Pos2::new(1200.0, 600.0));
        let fitted = aspect_fit(bounds, 9.0 / 16.0);
        assert!((fitted.width() / fitted.height() - 9.0 / 16.0).abs() < 0.001);
        assert_eq!(fitted.height(), bounds.height());
        assert!(fitted.width() < bounds.width());
    }

    #[test]
    fn formats_editor_timecode_as_colon_separated_pairs() {
        assert_eq!(timecode(65.5, 30.0), "00:01:05:15");
    }

    #[test]
    fn parses_editor_timecode_back_into_seconds() {
        assert!((parse_timecode("00:01:05:15", 30.0).unwrap() - 65.5).abs() < 0.000_001);
        assert!(parse_timecode("00:61:00:00", 30.0).is_none());
        assert!(parse_timecode("00:00:00:30", 30.0).is_none());
    }
}
