//! User interface surfaces and reusable presentation components.

use eframe::egui::{
    self, epaint::Vertex, Align, Align2, Color32, CornerRadius, FontId, Frame, Layout, Margin,
    Mesh, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, TextureHandle, TextureId, Vec2,
};

use crate::{
    app::{PropertiesTab, VideoEditor},
    media::{
        export::{ExportQuality, ExportResolution},
        transcription::{self, TranscriptionStage},
    },
    project::{
        sequence::{ClipLane, ClipMotion},
        EditTool,
    },
};

pub mod icons;
pub mod theme;
pub mod timeline;

use icons::Icon;

pub fn startup(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::CentralPanel::default()
        .frame(Frame::new().fill(theme::BLACK))
        .show(ctx, |ui| {
            let column_width = 400.0_f32.min(ui.available_width() - 48.0).max(280.0);
            let top_pad = (ui.available_height() * 0.18).clamp(56.0, 120.0);

            ui.vertical_centered(|ui| {
                ui.add_space(top_pad);

                ui.add(
                    egui::Image::new(egui::include_image!("../../assets/brand/unclip-mark.svg"))
                        .fit_to_exact_size(Vec2::splat(52.0))
                        .bg_fill(theme::BLACK),
                );
                ui.add_space(14.0);
                ui.label(RichText::new("Unclip").size(26.0).strong().color(theme::TEXT));
                ui.add_space(6.0);
                ui.label(
                    RichText::new("Local video editing")
                        .size(13.0)
                        .color(theme::MUTED),
                );

                ui.add_space(28.0);

                ui.horizontal(|ui| {
                    let actions_width = 236.0;
                    ui.add_space(((ui.available_width() - actions_width) * 0.5).max(0.0));
                    if ui
                        .add(
                            egui::Button::new(RichText::new("New Project").strong())
                                .fill(theme::ACCENT)
                                .stroke(Stroke::NONE)
                                .corner_radius(CornerRadius::same(theme::CONTROL_RADIUS))
                                .min_size(Vec2::new(132.0, 34.0)),
                        )
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        app.open_new_project_dialog();
                    }
                    // Secondary control — still a real button, not plain text.
                    if ui
                        .add(
                            egui::Button::new(RichText::new("Open").color(theme::TEXT))
                                .fill(theme::SURFACE)
                                .stroke(Stroke::new(1.0, theme::BORDER))
                                .corner_radius(CornerRadius::same(theme::CONTROL_RADIUS))
                                .min_size(Vec2::new(84.0, 34.0)),
                        )
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        app.open_project_picker(ctx);
                    }
                });

                ui.add_space(48.0);

                ui.allocate_ui_with_layout(
                    Vec2::new(column_width, ui.available_height()),
                    Layout::top_down(Align::Min),
                    |ui| {
                        ui.label(RichText::new("Recent").size(11.0).color(theme::MUTED));
                        ui.add_space(10.0);

                        if app.recent_projects.is_empty() {
                            ui.label(
                                RichText::new("No projects yet")
                                    .size(13.0)
                                    .color(theme::MUTED),
                            );
                        } else {
                            let recent = app.recent_projects.clone();
                            for project in recent {
                                let path = project.path.clone();
                                let opened = format_relative_opened(project.opened_unix_ms);
                                if recent_project_row(ui, &project.name, &opened, &path).clicked() {
                                    app.open_project_path(path, ctx);
                                }
                            }
                        }

                        if let Some(status) = &app.status {
                            ui.add_space(16.0);
                            ui.label(RichText::new(status).size(12.0).color(theme::PLAYHEAD));
                        }
                    },
                );
            });
        });
}

fn recent_project_row(
    ui: &mut egui::Ui,
    name: &str,
    opened: &str,
    path: &std::path::Path,
) -> egui::Response {
    let height = 40.0;
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::click());

    if ui.is_rect_visible(rect) {
        if response.hovered() {
            ui.painter().rect_filled(
                rect.expand2(Vec2::new(8.0, 0.0)),
                CornerRadius::same(6),
                theme::SURFACE_HOVER,
            );
        }

        let time_galley = ui.fonts(|fonts| {
            fonts.layout_no_wrap(opened.to_owned(), FontId::proportional(12.0), theme::MUTED)
        });
        let time_width = time_galley.size().x;
        let gap = 16.0;
        let name_right = rect.right() - 4.0 - time_width - gap;
        let name_rect = Rect::from_min_max(
            Pos2::new(rect.left() + 4.0, rect.top()),
            Pos2::new(name_right.max(rect.left() + 44.0), rect.bottom()),
        );
        let mid_y = rect.center().y;

        let name_galley = ui.fonts(|fonts| {
            fonts.layout_no_wrap(name.to_owned(), FontId::proportional(14.0), theme::TEXT)
        });
        ui.painter().with_clip_rect(name_rect).galley(
            Pos2::new(name_rect.left(), mid_y - name_galley.size().y * 0.5),
            name_galley,
            theme::TEXT,
        );
        ui.painter().galley(
            Pos2::new(
                rect.right() - 4.0 - time_width,
                mid_y - time_galley.size().y * 0.5,
            ),
            time_galley,
            theme::MUTED,
        );
    }

    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text(path.display().to_string())
}

fn format_relative_opened(opened_unix_ms: u64) -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(opened_unix_ms);
    let elapsed_secs = now_ms.saturating_sub(opened_unix_ms) / 1000;

    match elapsed_secs {
        0..=59 => "Just now".to_owned(),
        60..=3599 => {
            let minutes = elapsed_secs / 60;
            format!("{minutes}m ago")
        }
        3600..=86_399 => {
            let hours = elapsed_secs / 3600;
            format!("{hours}h ago")
        }
        86_400..=604_799 => {
            let days = elapsed_secs / 86_400;
            format!("{days}d ago")
        }
        _ => {
            let weeks = elapsed_secs / 604_800;
            if weeks < 8 {
                format!("{weeks}w ago")
            } else {
                "Earlier".to_owned()
            }
        }
    }
}

pub fn new_project_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    if !app.new_project_dialog_open {
        return;
    }
    let mut open = true;
    let mut close_requested = false;
    let mut create_requested = false;
    let mut choose_directory = false;

    let name_trimmed = app.new_project_draft.name.trim().to_owned();
    let project_path =
        crate::project::project_path(&app.new_project_draft.directory, &name_trimmed);
    let name_empty = name_trimmed.is_empty();
    let name_conflict = !name_empty && project_path.exists();
    let can_create = !name_empty && !name_conflict;

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
            let name_edit = ui.add_sized(
                [ui.available_width(), 34.0],
                egui::TextEdit::singleline(&mut app.new_project_draft.name)
                    .vertical_align(Align::Center)
                    .margin(Margin::symmetric(10, 0))
                    .frame(true),
            );
            if name_edit.changed() {
                app.status = None;
            }
            if name_empty {
                ui.add_space(4.0);
                ui.label(
                    RichText::new("Enter a project name.")
                        .size(12.0)
                        .color(theme::PLAYHEAD),
                );
            } else if name_conflict {
                ui.add_space(4.0);
                ui.label(
                    RichText::new("A project with that name already exists in this folder.")
                        .size(12.0)
                        .color(theme::PLAYHEAD),
                );
            }

            ui.add_space(10.0);
            ui.label(RichText::new("Location").small().color(theme::MUTED));
            ui.horizontal(|ui| {
                let path_width = (ui.available_width() - 100.0).max(120.0);
                let path_height = 34.0;
                let (path_rect, _) =
                    ui.allocate_exact_size(Vec2::new(path_width, path_height), Sense::hover());
                if ui.is_rect_visible(path_rect) {
                    ui.painter().rect(
                        path_rect,
                        CornerRadius::same(theme::CONTROL_RADIUS),
                        Color32::from_rgb(18, 18, 20),
                        Stroke::new(1.0, Color32::from_rgb(52, 52, 56)),
                        StrokeKind::Inside,
                    );
                    let path_text = app.new_project_draft.directory.display().to_string();
                    let font = FontId::proportional(13.0);
                    let max_text_w = (path_rect.width() - 20.0).max(1.0);
                    let display = truncate_to_width(ui.painter(), &path_text, &font, max_text_w);
                    ui.painter().text(
                        Pos2::new(path_rect.left() + 10.0, path_rect.center().y),
                        Align2::LEFT_CENTER,
                        display,
                        font,
                        theme::MUTED,
                    );
                }
                if ui.add(dialog_secondary_button("Choose…")).clicked() {
                    choose_directory = true;
                }
            });

            ui.add_space(10.0);
            ui.columns(2, |columns| {
                columns[0].label(RichText::new("Aspect ratio").small().color(theme::MUTED));
                egui::ComboBox::from_id_salt("project-aspect")
                    .selected_text(app.new_project_draft.settings.aspect_label())
                    .width(columns[0].available_width())
                    .show_ui(&mut columns[0], |ui| {
                        style_combo_menu(ui);
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
                        style_combo_menu(ui);
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
                        .width(112.0)
                        .show_ui(ui, |ui| {
                            style_combo_menu(ui);
                            let portrait = app.new_project_draft.settings.aspect_height
                                > app.new_project_draft.settings.aspect_width;
                            for (label, width, height) in [
                                ("720p", 1280, 720),
                                ("1080p", 1920, 1080),
                                ("1440p", 2560, 1440),
                                ("4K", 3840, 2160),
                            ] {
                                let (w, h) = if portrait {
                                    (height, width)
                                } else {
                                    (width, height)
                                };
                                let selected = app.new_project_draft.settings.width == w
                                    && app.new_project_draft.settings.height == h;
                                if ui.selectable_label(selected, label).clicked() {
                                    app.new_project_draft.settings.width = w;
                                    app.new_project_draft.settings.height = h;
                                }
                            }
                        });
                });
            });

            if let Some(status) = &app.status {
                ui.add_space(12.0);
                ui.label(RichText::new(status).size(12.0).color(theme::PLAYHEAD));
            }

            ui.add_space(20.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let create = ui.add_enabled(can_create, dialog_primary_button("Create Project"));
                if create.clicked() {
                    create_requested = true;
                }
                if ui.add(dialog_secondary_button("Cancel")).clicked() {
                    close_requested = true;
                }
            });
        });
    app.new_project_dialog_open &= open && !close_requested;
    if choose_directory {
        app.choose_project_directory();
    }
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
            ui.label(format!("Unclip could not find {}.", media.name));
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
                "UNCLIP",
                FontId::proportional(12.0),
                theme::MUTED,
            );
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
                    style_combo_menu(ui);
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
                    style_combo_menu(ui);
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

pub fn export_progress_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    let Some(progress) = app.export_job.as_ref().map(|job| job.progress()) else {
        return;
    };

    let destination = app
        .export_destination
        .as_deref()
        .and_then(std::path::Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("video.mp4")
        .to_owned();
    let (width, height) = app
        .video
        .as_ref()
        .map(|video| {
            app.export_settings
                .resolution
                .dimensions(video, app.sequence_format())
        })
        .unwrap_or((0, 0));

    // Intentionally do not call `should_close`: this remains open through Escape,
    // click-away, and any window-close affordance until `poll_export` clears the job.
    egui::Modal::new(egui::Id::new("export-progress-dialog"))
        .frame(dialog_frame())
        .show(ctx, |ui| {
            style_dialog_controls(ui);
            ui.heading(RichText::new("Exporting…").strong());
            ui.add_space(10.0);
            ui.label(RichText::new(destination).size(12.0).color(theme::TEXT));
            ui.label(
                RichText::new(format!(
                    "{width} × {height} · {}",
                    app.export_settings.quality.label()
                ))
                .size(11.0)
                .color(theme::MUTED),
            );
            ui.add_space(14.0);
            ui.add(
                egui::ProgressBar::new(progress)
                    .desired_width(300.0)
                    .show_percentage(),
            );
            ui.add_space(16.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui
                    .add(dialog_secondary_button("Cancel"))
                    .on_hover_cursor(egui::CursorIcon::PointingHand)
                    .clicked()
                {
                    app.cancel_export();
                }
            });
        });
}

pub fn export_notice(ctx: &egui::Context, app: &mut VideoEditor) {
    if app.export_job.is_some() {
        return;
    }
    let Some(message) = app.export_message.clone() else {
        return;
    };
    const AUTO_HIDE: std::time::Duration = std::time::Duration::from_secs(2);
    if app.export_message_age().is_some_and(|age| age >= AUTO_HIDE) {
        app.clear_export_message();
        return;
    }
    if let Some(age) = app.export_message_age() {
        ctx.request_repaint_after(AUTO_HIDE.saturating_sub(age));
    }

    let mut dismiss = false;
    egui::Area::new(egui::Id::new("export-notice"))
        .anchor(Align2::RIGHT_TOP, Vec2::new(-16.0, 48.0))
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            dialog_frame().show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(message).size(12.0).color(theme::TEXT));
                    if ui
                        .add(egui::Button::new("×").frame(false))
                        .on_hover_cursor(egui::CursorIcon::PointingHand)
                        .clicked()
                    {
                        dismiss = true;
                    }
                });
            });
        });
    if dismiss {
        app.clear_export_message();
    }
}

pub fn media_info_dialog(ctx: &egui::Context, app: &mut VideoEditor) {
    let Some(clip_id) = app.media_info_clip else {
        return;
    };
    let Some(clip) = app
        .sequence
        .as_ref()
        .and_then(|sequence| sequence.clip(clip_id))
        .cloned()
    else {
        app.media_info_clip = None;
        return;
    };
    let Some(video) = app.media_asset(clip.media_id).cloned() else {
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
    let radius = CornerRadius::same(theme::CONTROL_RADIUS);
    let field_stroke = Stroke::new(1.0, Color32::from_rgb(52, 52, 56));
    let visuals = ui.visuals_mut();
    visuals.widgets.inactive.bg_fill = Color32::from_rgb(18, 18, 20);
    visuals.widgets.inactive.weak_bg_fill = Color32::from_rgb(18, 18, 20);
    visuals.widgets.inactive.bg_stroke = field_stroke;
    visuals.widgets.inactive.corner_radius = radius;
    visuals.widgets.inactive.expansion = 0.0;
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(26, 26, 30);
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(26, 26, 30);
    visuals.widgets.hovered.bg_stroke = field_stroke;
    visuals.widgets.hovered.corner_radius = radius;
    visuals.widgets.hovered.expansion = 0.0;
    visuals.widgets.active.bg_fill = Color32::from_rgb(30, 30, 34);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(30, 30, 34);
    visuals.widgets.active.bg_stroke = field_stroke;
    visuals.widgets.active.corner_radius = radius;
    visuals.widgets.active.expansion = 0.0;
    visuals.widgets.open.bg_fill = Color32::from_rgb(26, 26, 30);
    visuals.widgets.open.weak_bg_fill = Color32::from_rgb(26, 26, 30);
    visuals.widgets.open.bg_stroke = field_stroke;
    visuals.widgets.open.corner_radius = radius;
    visuals.widgets.open.expansion = 0.0;
    visuals.menu_corner_radius = CornerRadius::same(theme::MENU_RADIUS);
    ui.spacing_mut().button_padding = Vec2::new(12.0, 8.0);
    ui.spacing_mut().combo_height = 220.0;
}

/// Flat menu rows for ComboBox popups — fill hover, no border/expansion ring.
fn style_combo_menu(ui: &mut egui::Ui) {
    let visuals = ui.visuals_mut();
    visuals.widgets.hovered.bg_fill = theme::SURFACE_HOVER;
    visuals.widgets.hovered.weak_bg_fill = theme::SURFACE_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::NONE;
    visuals.widgets.hovered.expansion = 0.0;
    visuals.widgets.hovered.corner_radius = CornerRadius::same(6);
    visuals.widgets.active.bg_fill = theme::SURFACE_HOVER;
    visuals.widgets.active.weak_bg_fill = theme::SURFACE_HOVER;
    visuals.widgets.active.bg_stroke = Stroke::NONE;
    visuals.widgets.active.expansion = 0.0;
    visuals.widgets.active.corner_radius = CornerRadius::same(6);
    visuals.widgets.inactive.bg_stroke = Stroke::NONE;
    visuals.widgets.inactive.expansion = 0.0;
    visuals.selection.bg_fill = Color32::from_rgb(32, 48, 78);
    visuals.selection.stroke = Stroke::NONE;
    ui.spacing_mut().button_padding = Vec2::new(10.0, 6.0);
    ui.spacing_mut().item_spacing.y = 2.0;
}

fn dialog_primary_button(label: &str) -> egui::Button<'_> {
    egui::Button::new(RichText::new(label).strong())
        .fill(theme::ACCENT)
        .stroke(Stroke::NONE)
        .corner_radius(CornerRadius::same(theme::CONTROL_RADIUS))
        .min_size(Vec2::new(154.0, 34.0))
}

fn dialog_secondary_button(label: &str) -> egui::Button<'_> {
    egui::Button::new(label)
        .fill(Color32::from_rgb(20, 20, 22))
        .stroke(Stroke::new(1.0, Color32::from_rgb(55, 55, 60)))
        .corner_radius(CornerRadius::same(theme::CONTROL_RADIUS))
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

fn truncate_to_width(painter: &egui::Painter, text: &str, font: &FontId, max_width: f32) -> String {
    if painter
        .layout_no_wrap(text.to_owned(), font.clone(), theme::TEXT)
        .size()
        .x
        <= max_width
    {
        return text.to_owned();
    }

    let characters = text.chars().collect::<Vec<_>>();
    let mut low = 0;
    let mut high = characters.len();
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = characters[..middle]
            .iter()
            .chain(std::iter::once(&'…'))
            .collect::<String>();
        if painter
            .layout_no_wrap(candidate, font.clone(), theme::TEXT)
            .size()
            .x
            <= max_width
        {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    characters[..low]
        .iter()
        .chain(std::iter::once(&'…'))
        .collect()
}

pub fn properties_panel(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::SidePanel::right("clip-properties")
        .exact_width(268.0)
        .resizable(false)
        .show_separator_line(true)
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::same(14)),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                properties_tab(
                    ui,
                    &mut app.properties_tab,
                    PropertiesTab::Properties,
                    "Properties",
                );
                ui.add_space(14.0);
                properties_tab(
                    ui,
                    &mut app.properties_tab,
                    PropertiesTab::Transcription,
                    "Transcription",
                );
            });
            ui.add_space(10.0);

            if app.properties_tab == PropertiesTab::Transcription {
                transcription_panel(ui, app, ctx);
                return;
            }

            let selected_count = app
                .sequence
                .as_ref()
                .map(|sequence| sequence.selected.len())
                .unwrap_or(0);
            if selected_count == 0 {
                ui.label(
                    RichText::new("Select a clip on the timeline to edit motion and audio.")
                        .size(12.0)
                        .color(theme::MUTED),
                );
                return;
            }
            if selected_count > 1 {
                ui.label(
                    RichText::new(format!("{selected_count} clips selected"))
                        .size(12.0)
                        .color(theme::MUTED),
                );
                ui.add_space(8.0);
                ui.label(
                    RichText::new("Select a single clip to edit properties.")
                        .size(12.0)
                        .color(theme::MUTED),
                );
                return;
            }

            let (mut motion, mut audio, lane, name) = {
                let Some(clip) = app.selected_clip() else {
                    return;
                };
                let name = app
                    .media_asset(clip.media_id)
                    .map(|asset| asset.name.clone())
                    .unwrap_or_else(|| "Offline media".to_owned());
                (clip.motion, clip.audio, clip.lane, name)
            };

            ui.label(RichText::new(name).size(12.0).color(theme::TEXT));
            ui.add_space(14.0);
            let (show_motion, show_audio) = property_sections(lane);

            if show_motion {
                ui.label(RichText::new("Motion").size(11.0).color(theme::MUTED));
                ui.add_space(6.0);
                let mut commit_motion = false;
                commit_motion |= edit_property(
                    ui,
                    app,
                    "Position X",
                    &mut motion.position_x,
                    -4000.0..=4000.0,
                    1.0,
                );
                commit_motion |= edit_property(
                    ui,
                    app,
                    "Position Y",
                    &mut motion.position_y,
                    -4000.0..=4000.0,
                    1.0,
                );
                commit_motion |=
                    edit_property(ui, app, "Scale", &mut motion.scale, 1.0..=1000.0, 0.1);
                commit_motion |= edit_property(
                    ui,
                    app,
                    "Rotation",
                    &mut motion.rotation,
                    -3600.0..=3600.0,
                    0.1,
                );
                app.update_selected_clip_motion(motion);
                if commit_motion {
                    app.commit_history_transaction();
                }
            }

            if show_audio {
                if show_motion {
                    ui.add_space(16.0);
                }
                ui.label(RichText::new("Audio").size(11.0).color(theme::MUTED));
                ui.add_space(6.0);
                let commit_audio = edit_property(
                    ui,
                    app,
                    "Level (dB)",
                    &mut audio.volume_db,
                    -60.0..=12.0,
                    0.1,
                );
                app.update_selected_clip_audio(audio);
                if commit_audio {
                    app.commit_history_transaction();
                }
            }
        });
}

fn transcription_panel(ui: &mut egui::Ui, app: &mut VideoEditor, ctx: &egui::Context) {
    if !transcription::supported() {
        ui.label(
            RichText::new("Transcription on Windows is coming soon.")
                .size(12.0)
                .color(theme::MUTED),
        );
        return;
    }

    if let Some(job) = &app.transcription_job {
        let stage = match job.stage() {
            TranscriptionStage::Preparing => "Preparing sequence audio…",
            TranscriptionStage::Recognizing => "Transcribing on this Mac…",
        };
        ui.label(RichText::new(stage).size(12.0).color(theme::TEXT));
        ui.add_space(6.0);
        ui.add(
            egui::ProgressBar::new(job.progress())
                .animate(true)
                .show_percentage(),
        );
        ui.add_space(8.0);
        if ui.button("Cancel").clicked() {
            app.cancel_transcription();
        }
        return;
    }

    let transcript = app.transcript().cloned();
    if let Some(transcript) = &transcript {
        if ui.button("Re-transcribe entire sequence").clicked() {
            app.start_transcription(ctx);
        }
        if let Some(language) = &transcript.language {
            ui.add_space(5.0);
            ui.label(
                RichText::new(format!("On-device · {language}"))
                    .size(10.0)
                    .color(theme::MUTED),
            );
        }
        ui.add_space(10.0);
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing = Vec2::new(4.0, 6.0);
                ui.horizontal_wrapped(|ui| {
                    for word in &transcript.words {
                        let strength = word.highlight_strength(app.current_time);
                        let alpha = (strength * 255.0).round() as u8;
                        let background = Color32::from_rgba_unmultiplied(
                            theme::SELECTION.r(),
                            theme::SELECTION.g(),
                            theme::SELECTION.b(),
                            alpha,
                        );
                        let color = if strength > 0.42 {
                            theme::BLACK
                        } else {
                            theme::TEXT
                        };
                        let response = ui.label(
                            RichText::new(&word.text)
                                .size(13.0)
                                .color(color)
                                .background_color(background),
                        );
                        if word.contains(app.current_time) {
                            response.scroll_to_me(Some(Align::Center));
                        }
                    }
                });
            });
    } else {
        ui.label(
            RichText::new("Create a word-timed transcript from the edited sequence audio.")
                .size(12.0)
                .color(theme::MUTED),
        );
        ui.add_space(8.0);
        if ui.button("Transcribe").clicked() {
            app.start_transcription(ctx);
        }
    }

    if let Some(message) = &app.transcription_message {
        ui.add_space(8.0);
        ui.label(RichText::new(message).size(11.0).color(theme::MUTED));
    }
}

fn property_sections(lane: ClipLane) -> (bool, bool) {
    (lane.shows_video(), lane.shows_audio())
}

fn properties_tab(
    ui: &mut egui::Ui,
    current: &mut PropertiesTab,
    value: PropertiesTab,
    label: &str,
) {
    let active = *current == value;
    let galley = ui.fonts(|fonts| {
        fonts.layout_no_wrap(
            label.to_owned(),
            FontId::proportional(13.0),
            if active { theme::TEXT } else { theme::MUTED },
        )
    });
    let size = Vec2::new(galley.size().x, 22.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    if ui.is_rect_visible(rect) {
        ui.painter().galley(
            egui::pos2(rect.left(), rect.center().y - galley.size().y * 0.5),
            galley,
            if active { theme::TEXT } else { theme::MUTED },
        );
        if active {
            let y = rect.bottom() - 1.0;
            ui.painter().line_segment(
                [egui::pos2(rect.left(), y), egui::pos2(rect.right(), y)],
                Stroke::new(1.5, Color32::WHITE),
            );
        }
    }
    if response.clicked() {
        *current = value;
    }
    response.on_hover_cursor(egui::CursorIcon::PointingHand);
}

/// Returns true when the edit should be committed to undo history this frame.
fn edit_property(
    ui: &mut egui::Ui,
    app: &mut VideoEditor,
    label: &str,
    value: &mut f32,
    range: std::ops::RangeInclusive<f32>,
    speed: f32,
) -> bool {
    let mut should_commit = false;
    ui.horizontal(|ui| {
        ui.allocate_ui_with_layout(
            Vec2::new(88.0, ui.spacing().interact_size.y),
            Layout::left_to_right(Align::Center),
            |ui| {
                ui.label(RichText::new(label).size(12.0).color(theme::MUTED));
            },
        );
        let response = ui.add(
            egui::DragValue::new(value)
                .range(range)
                .speed(speed)
                .max_decimals(1),
        );
        if response.drag_started() || (response.changed() && !response.dragged()) {
            app.begin_history_transaction();
        }
        if response.drag_stopped() || (response.changed() && !response.dragged()) {
            should_commit = true;
        }
    });
    ui.add_space(4.0);
    should_commit
}

fn paint_clip_frame(
    painter: &egui::Painter,
    texture: TextureId,
    fitted: Rect,
    frame: Rect,
    format_width: f32,
    format_height: f32,
    motion: ClipMotion,
) {
    let scale = (motion.scale / 100.0).max(0.01);
    let size = fitted.size() * scale;
    let offset = Vec2::new(
        motion.position_x / format_width.max(1.0) * frame.width(),
        -motion.position_y / format_height.max(1.0) * frame.height(),
    );
    let dest = Rect::from_center_size(fitted.center() + offset, size);
    let painter = painter.with_clip_rect(frame);
    let angle = motion.rotation.to_radians();
    if angle.abs() < 0.000_1 {
        painter.image(
            texture,
            dest,
            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            Color32::WHITE,
        );
        return;
    }

    let center = dest.center();
    let cos = angle.cos();
    let sin = angle.sin();
    let corners = [
        (dest.left_top(), Pos2::new(0.0, 0.0)),
        (dest.right_top(), Pos2::new(1.0, 0.0)),
        (dest.right_bottom(), Pos2::new(1.0, 1.0)),
        (dest.left_bottom(), Pos2::new(0.0, 1.0)),
    ];
    let mut mesh = Mesh::with_texture(texture);
    for (pos, uv) in corners {
        let delta = pos - center;
        mesh.vertices.push(Vertex {
            pos: Pos2::new(
                center.x + delta.x * cos - delta.y * sin,
                center.y + delta.x * sin + delta.y * cos,
            ),
            uv,
            color: Color32::WHITE,
        });
    }
    mesh.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
    painter.add(egui::Shape::mesh(mesh));
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
                .rect_filled(canvas, CornerRadius::same(6), theme::SURFACE);

            let format = app.sequence_format();
            let project_frame = aspect_fit(
                canvas.shrink(12.0),
                format.width as f32 / format.height.max(1) as f32,
            );
            ui.painter()
                .rect_filled(project_frame, CornerRadius::ZERO, Color32::BLACK);

            if let (Some(video), Some(texture)) = (&app.video, &app.texture) {
                // Premiere-style 100%: one source pixel = one sequence pixel, so
                // lower-resolution clips sit smaller inside the project frame.
                let image_rect = sequence_pixel_rect(
                    project_frame,
                    format.width,
                    format.height,
                    video.source_width,
                    video.source_height,
                );
                let motion = app
                    .sequence
                    .as_ref()
                    .and_then(|sequence| sequence.clip_at(app.current_time))
                    .map(|clip| clip.motion)
                    .unwrap_or_default();
                paint_clip_frame(
                    ui.painter(),
                    texture.id(),
                    image_rect,
                    project_frame,
                    format.width as f32,
                    format.height as f32,
                    motion,
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

pub fn media_panel(ctx: &egui::Context, app: &mut VideoEditor) {
    let mut delete_requested = None;
    let mut import_requested = false;
    egui::SidePanel::left("project-media")
        .exact_width(300.0)
        .resizable(false)
        .show_separator_line(true)
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::same(12)),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Project media").strong());
                if !app.media_library.is_empty() {
                    ui.label(
                        RichText::new(app.media_library.len().to_string())
                            .small()
                            .color(theme::MUTED),
                    );
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let response = icons::import_menu_button(ui);
                    let popup_id = ui.make_persistent_id("media-import-menu");
                    if response.clicked() {
                        ui.memory_mut(|mem| mem.toggle_popup(popup_id));
                    }
                    egui::popup::popup_below_widget(
                        ui,
                        popup_id,
                        &response,
                        egui::popup::PopupCloseBehavior::CloseOnClick,
                        |ui| {
                            ui.set_min_width(148.0);
                            ui.visuals_mut().panel_fill = theme::BLACK;
                            ui.visuals_mut().window_fill = theme::BLACK;
                            style_combo_menu(ui);
                            if icons::menu_item(ui, Icon::Import, "Import").clicked() {
                                import_requested = true;
                                ui.memory_mut(|mem| mem.close_popup());
                            }
                        },
                    );
                });
            });
            ui.add_space(10.0);
            if app.media_library.is_empty() {
                ui.label(RichText::new("Import footage to add it here.").color(theme::MUTED));
                return;
            }

            let entries = app
                .media_library
                .iter()
                .map(|media| {
                    (
                        media.id,
                        media.asset.name.clone(),
                        media.asset.file_size,
                        media.asset.duration,
                        media.asset.source_width,
                        media.asset.source_height,
                        media.thumbnail.as_ref().map(TextureHandle::id),
                    )
                })
                .collect::<Vec<_>>();
            egui::ScrollArea::vertical().show(ui, |ui| {
                for (id, name, size, duration, width, height, thumbnail) in entries {
                    let selected = app.selected_media_id == Some(id);
                    let (rect, response) = ui.allocate_exact_size(
                        Vec2::new(ui.available_width(), 72.0),
                        Sense::click_and_drag(),
                    );
                    response.dnd_set_drag_payload(id);
                    let response = response
                        .on_hover_cursor(egui::CursorIcon::Grab)
                        .on_hover_text_at_pointer("Drag onto the timeline");
                    if response.secondary_clicked() {
                        app.select_library_media(id);
                    }
                    response.context_menu(|ui| {
                        ui.visuals_mut().panel_fill = theme::BLACK;
                        ui.visuals_mut().window_fill = theme::BLACK;
                        ui.set_min_width(158.0);
                        ui.set_max_width(180.0);
                        ui.spacing_mut().item_spacing.y = 2.0;
                        ui.spacing_mut().button_padding = Vec2::new(7.0, 5.0);
                        if icons::menu_item(ui, Icon::Delete, "Delete media").clicked() {
                            delete_requested = Some(id);
                            ui.close_menu();
                        }
                    });
                    let hovered = response.hovered();
                    ui.painter().rect_filled(
                        rect,
                        CornerRadius::same(8),
                        if selected {
                            theme::SURFACE
                        } else if hovered {
                            theme::SURFACE_HOVER
                        } else {
                            Color32::TRANSPARENT
                        },
                    );
                    if selected {
                        ui.painter().rect_stroke(
                            rect,
                            CornerRadius::same(8),
                            Stroke::new(1.0, theme::ACCENT),
                            StrokeKind::Inside,
                        );
                    }
                    // Fixed 16:9 frame; media keeps its native aspect (letterbox / pillarbox).
                    let thumb_h = 50.0;
                    let thumb_w = thumb_h * 16.0 / 9.0;
                    let thumb = Rect::from_min_size(
                        rect.min + Vec2::new(7.0, (rect.height() - thumb_h) * 0.5),
                        Vec2::new(thumb_w, thumb_h),
                    );
                    ui.painter()
                        .rect_filled(thumb, CornerRadius::same(5), theme::SURFACE);
                    if let Some(texture) = thumbnail {
                        let image_rect =
                            aspect_fit(thumb, width.max(1) as f32 / height.max(1) as f32);
                        ui.painter().with_clip_rect(thumb).image(
                            texture,
                            image_rect,
                            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                            Color32::WHITE,
                        );
                    }
                    let text_x = thumb.right() + 9.0;
                    let title_font = FontId::proportional(12.0);
                    let title = truncate_to_width(
                        ui.painter(),
                        &name,
                        &title_font,
                        (rect.right() - text_x - 8.0).max(1.0),
                    );
                    ui.painter().text(
                        Pos2::new(text_x, rect.top() + 9.0),
                        Align2::LEFT_TOP,
                        title,
                        title_font,
                        theme::TEXT,
                    );
                    ui.painter().text(
                        Pos2::new(text_x, rect.top() + 34.0),
                        Align2::LEFT_TOP,
                        format!(
                            "{} × {}  ·  {}",
                            width,
                            height,
                            format_file_size(size.unwrap_or(0))
                        ),
                        FontId::proportional(10.0),
                        theme::MUTED,
                    );
                    ui.painter().text(
                        Pos2::new(text_x, rect.top() + 50.0),
                        Align2::LEFT_TOP,
                        format!("{duration:.1}s"),
                        FontId::proportional(10.0),
                        theme::MUTED,
                    );
                    if response.clicked() {
                        app.select_library_media(id);
                    }
                    ui.add_space(7.0);
                }
            });
        });
    if import_requested {
        app.import_video(ctx);
    }
    if let Some(id) = delete_requested {
        app.delete_library_media(id, ctx);
    }
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

/// Map source pixels into the project frame. At 100% scale, a 960×540 clip on a
/// 1920×1080 sequence occupies half the frame (centered), not the full frame.
fn sequence_pixel_rect(
    project_frame: Rect,
    format_width: usize,
    format_height: usize,
    source_width: usize,
    source_height: usize,
) -> Rect {
    let width = project_frame.width() * (source_width.max(1) as f32 / format_width.max(1) as f32);
    let height =
        project_frame.height() * (source_height.max(1) as f32 / format_height.max(1) as f32);
    Rect::from_center_size(
        project_frame.center(),
        Vec2::new(width.max(1.0), height.max(1.0)),
    )
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

    use super::{
        aspect_fit, format_relative_opened, parse_timecode, property_sections, sequence_pixel_rect,
        timecode,
    };
    use crate::project::sequence::ClipLane;

    #[test]
    fn portrait_media_is_fitted_without_stretching() {
        let bounds = Rect::from_min_max(Pos2::ZERO, Pos2::new(1200.0, 600.0));
        let fitted = aspect_fit(bounds, 9.0 / 16.0);
        assert!((fitted.width() / fitted.height() - 9.0 / 16.0).abs() < 0.001);
        assert_eq!(fitted.height(), bounds.height());
        assert!(fitted.width() < bounds.width());
    }

    #[test]
    fn lower_resolution_clips_occupy_native_pixel_size_in_the_project_frame() {
        let frame = Rect::from_min_max(Pos2::ZERO, Pos2::new(1920.0, 1080.0));
        let half = sequence_pixel_rect(frame, 1920, 1080, 960, 540);
        assert!((half.width() - 960.0).abs() < 0.001);
        assert!((half.height() - 540.0).abs() < 0.001);
        assert!((half.center() - frame.center()).length() < 0.001);
    }

    #[test]
    fn formats_editor_timecode_as_colon_separated_pairs() {
        assert_eq!(timecode(65.5, 30.0), "00:01:05:15");
    }

    #[test]
    fn property_sections_follow_the_clip_lane() {
        assert_eq!(property_sections(ClipLane::Both), (true, true));
        assert_eq!(property_sections(ClipLane::Video), (true, false));
        assert_eq!(property_sections(ClipLane::Audio), (false, true));
    }

    #[test]
    fn parses_editor_timecode_back_into_seconds() {
        assert!((parse_timecode("00:01:05:15", 30.0).unwrap() - 65.5).abs() < 0.000_001);
        assert!(parse_timecode("00:61:00:00", 30.0).is_none());
        assert!(parse_timecode("00:00:00:30", 30.0).is_none());
    }

    #[test]
    fn formats_recent_project_relative_times() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert_eq!(format_relative_opened(now_ms), "Just now");
        assert_eq!(
            format_relative_opened(now_ms.saturating_sub(5 * 60 * 1000)),
            "5m ago"
        );
        assert_eq!(
            format_relative_opened(now_ms.saturating_sub(3 * 60 * 60 * 1000)),
            "3h ago"
        );
    }
}
