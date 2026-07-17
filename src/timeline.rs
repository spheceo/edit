use eframe::egui::{
    self, scroll_area::ScrollBarVisibility, Align, Align2, Color32, CornerRadius, FontId, Frame,
    Layout, Margin, Pos2, Rect, Sense, Stroke, StrokeKind, Vec2,
};

use crate::{
    app::VideoEditor,
    sequence::{EditTool, SequenceClip},
    theme,
    waveform::Waveform,
};

const LABEL_WIDTH: f32 = 54.0;
const RULER_HEIGHT: f32 = 30.0;
const VIDEO_HEIGHT: f32 = 48.0;
const AUDIO_HEIGHT: f32 = 42.0;
const EDGE_HIT_WIDTH: f32 = 12.0;
const SCROLLBAR_RESERVE: f32 = 12.0;

pub fn show(ctx: &egui::Context, app: &mut VideoEditor) {
    egui::TopBottomPanel::bottom("timeline")
        .exact_height(210.0)
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::symmetric(14, 10))
                .stroke(Stroke::new(1.0, theme::BORDER)),
        )
        .show(ctx, |ui| {
            let available = ui.available_size();
            let scrollable = timeline_is_scrollable(app.timeline_zoom);
            // Keep the strip reserved at every zoom level so the timeline never jumps
            // vertically when the scrollbar appears or disappears.
            let canvas_height = (available.y - SCROLLBAR_RESERVE).max(1.0);
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.horizontal_top(|ui| {
                let (labels, _) =
                    ui.allocate_exact_size(Vec2::new(LABEL_WIDTH, canvas_height), Sense::hover());
                draw_labels(ui, labels, app);

                let viewport_width = ui.available_width().max(1.0);
                egui::ScrollArea::horizontal()
                    .id_salt("timeline-canvas-scroll")
                    .auto_shrink([false, false])
                    .animated(false)
                    .scroll_bar_visibility(if scrollable {
                        ScrollBarVisibility::AlwaysVisible
                    } else {
                        ScrollBarVisibility::AlwaysHidden
                    })
                    .show_viewport(ui, |ui, viewport| {
                        let canvas_width = timeline_canvas_width(viewport_width, app.timeline_zoom);
                        let (rect, timeline_response) = ui.allocate_exact_size(
                            Vec2::new(canvas_width, canvas_height),
                            Sense::click_and_drag(),
                        );
                        draw(ui, rect, app);
                        interact(ui, ctx, rect, timeline_response, app);
                        if app.playing && app.timeline_zoom > 1.001 {
                            let duration = app.duration().max(0.001);
                            let playhead_x =
                                time_to_x(app.current_time, timeline_content(rect), duration);
                            if playhead_needs_follow(viewport, playhead_x) {
                                ui.scroll_to_rect(
                                    Rect::from_center_size(
                                        Pos2::new(playhead_x.round(), rect.center().y),
                                        Vec2::new(2.0, rect.height()),
                                    ),
                                    Some(Align::Center),
                                );
                            }
                        }
                    });
            });
        });
}

pub fn zoom_controls(ui: &mut egui::Ui, app: &mut VideoEditor) {
    ui.allocate_ui_with_layout(
        Vec2::new(265.0, 34.0),
        Layout::left_to_right(Align::Center),
        |ui| {
            let can_zoom = app.video.is_some() && app.sequence.is_some();
            if !can_zoom {
                app.timeline_zoom = 1.0;
            }
            ui.add_enabled_ui(can_zoom, |ui| {
                if zoom_button(ui, "−", "Zoom out").clicked() {
                    app.timeline_zoom = (app.timeline_zoom / 1.35).clamp(1.0, 32.0);
                }
                let mut zoom = app.timeline_zoom;
                let response = ui.scope(|ui| {
                    ui.spacing_mut().slider_width = 122.0;
                    ui.spacing_mut().slider_rail_height = 4.0;
                    ui.visuals_mut().slider_trailing_fill = true;
                    ui.visuals_mut().widgets.inactive.bg_fill = Color32::from_rgb(48, 48, 52);
                    ui.visuals_mut().widgets.inactive.fg_stroke =
                        Stroke::new(1.5, Color32::from_rgb(210, 210, 215));
                    ui.visuals_mut().widgets.hovered.bg_fill = Color32::from_rgb(66, 66, 70);
                    ui.visuals_mut().widgets.hovered.fg_stroke = Stroke::new(2.0, theme::TEXT);
                    ui.visuals_mut().widgets.active.bg_fill = theme::ACCENT;
                    ui.add(
                        egui::Slider::new(&mut zoom, 1.0..=32.0)
                            .logarithmic(true)
                            .show_value(false)
                            .max_decimals(1)
                            .trailing_fill(true),
                    )
                });
                if response.inner.changed() {
                    app.timeline_zoom = zoom.clamp(1.0, 32.0);
                }
                if zoom_button(ui, "+", "Zoom in").clicked() {
                    app.timeline_zoom = (app.timeline_zoom * 1.35).clamp(1.0, 32.0);
                }
                ui.label(
                    egui::RichText::new(format!("{:.0}%", app.timeline_zoom * 100.0))
                        .monospace()
                        .small()
                        .color(theme::MUTED),
                );
            });
        },
    );
}

fn zoom_button(ui: &mut egui::Ui, label: &str, tooltip: &str) -> egui::Response {
    ui.add(
        egui::Button::new(egui::RichText::new(label).size(16.0).strong())
            .min_size(Vec2::splat(28.0))
            .fill(theme::SURFACE)
            .stroke(Stroke::new(1.0, theme::BORDER))
            .corner_radius(CornerRadius::same(8)),
    )
    .on_hover_cursor(egui::CursorIcon::PointingHand)
    .on_hover_text_at_pointer(tooltip)
}

fn timeline_canvas_width(viewport_width: f32, zoom: f32) -> f32 {
    viewport_width.max(1.0) * zoom.clamp(1.0, 32.0)
}

fn timeline_is_scrollable(zoom: f32) -> bool {
    zoom > 1.001
}

fn playhead_needs_follow(viewport: Rect, playhead_x: f32) -> bool {
    let follow_left = viewport.left() + viewport.width() * 0.28;
    let follow_right = viewport.left() + viewport.width() * 0.72;
    playhead_x < follow_left || playhead_x > follow_right
}

fn interact(
    ui: &mut egui::Ui,
    ctx: &egui::Context,
    rect: Rect,
    timeline_response: egui::Response,
    app: &mut VideoEditor,
) {
    let Some(sequence) = &app.sequence else {
        return;
    };
    let clips = sequence.clips.clone();
    let selected = sequence.selected;
    let duration = sequence.duration.max(0.001);
    let content = timeline_content(rect);
    let (video_lane, audio_lane) = lane_rects(content);
    let pointer = ui.input(|input| input.pointer.interact_pos());
    let mut pointer_over_clip = false;
    let mut edge_active = false;

    if timeline_response.hovered() {
        let zoom_delta = ctx.input(|input| input.zoom_delta());
        if (zoom_delta - 1.0).abs() > 0.001 {
            app.timeline_zoom = (app.timeline_zoom * zoom_delta).clamp(1.0, 32.0);
        }
    }

    #[derive(Clone, Copy)]
    enum ContextAction {
        Delete(crate::sequence::ClipId),
        Info(crate::sequence::ClipId),
    }
    let mut context_action = None;

    for clip in &clips {
        let (video_rect, audio_rect) = clip_rects(clip, video_lane, audio_lane, duration);
        let body_rect = video_rect.union(audio_rect);
        pointer_over_clip |= pointer.is_some_and(|position| body_rect.contains(position));

        if app.tool == EditTool::Select {
            let left_handle = Rect::from_center_size(
                Pos2::new(video_rect.left(), body_rect.center().y),
                Vec2::new(EDGE_HIT_WIDTH, body_rect.height()),
            );
            let right_handle = Rect::from_center_size(
                Pos2::new(video_rect.right(), body_rect.center().y),
                Vec2::new(EDGE_HIT_WIDTH, body_rect.height()),
            );
            let left = ui
                .interact(
                    left_handle,
                    ui.id().with(("trim-left", clip.id)),
                    Sense::drag(),
                )
                .on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
            let right = ui
                .interact(
                    right_handle,
                    ui.id().with(("trim-right", clip.id)),
                    Sense::drag(),
                )
                .on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
            edge_active |= left.hovered() || left.dragged() || right.hovered() || right.dragged();
            if left.drag_started() || right.drag_started() {
                app.begin_history_transaction();
            }
            if left.dragged() {
                if let Some(position) = left.interact_pointer_pos() {
                    app.trim_left(clip.id, x_to_time(position.x, content, duration), ctx);
                }
            } else if right.dragged() {
                if let Some(position) = right.interact_pointer_pos() {
                    app.trim_right(clip.id, x_to_time(position.x, content, duration), ctx);
                }
            }
            if left.drag_stopped() || right.drag_stopped() {
                app.commit_history_transaction();
            }
        }

        let body = ui.interact(
            body_rect.shrink2(Vec2::new(EDGE_HIT_WIDTH * 0.5, 0.0)),
            ui.id().with(("clip-body", clip.id)),
            Sense::click(),
        );
        let body = if app.tool == EditTool::Razor {
            body.on_hover_cursor(egui::CursorIcon::Crosshair)
        } else {
            body.on_hover_cursor(egui::CursorIcon::PointingHand)
        };
        if body.secondary_clicked() {
            app.select_clip(Some(clip.id));
        }
        body.context_menu(|ui| {
            if ui.button("Clip info").clicked() {
                context_action = Some(ContextAction::Info(clip.id));
                ui.close_menu();
            }
            if ui.button("Delete clip").clicked() {
                context_action = Some(ContextAction::Delete(clip.id));
                ui.close_menu();
            }
        });
        if body.clicked() && !edge_active {
            match app.tool {
                EditTool::Select => app.select_clip(Some(clip.id)),
                EditTool::Razor => {
                    if let Some(position) = body.interact_pointer_pos() {
                        app.razor_cut(x_to_time(position.x, content, duration), ctx);
                    }
                }
            }
        }
    }

    if (timeline_response.clicked() || timeline_response.dragged())
        && !pointer_over_clip
        && !edge_active
    {
        if let Some(position) = timeline_response.interact_pointer_pos() {
            if selected.is_some() && timeline_response.clicked() {
                app.select_clip(None);
            }
            app.seek(x_to_time(position.x, content, duration), ctx);
        }
    }

    if let Some(action) = context_action {
        match action {
            ContextAction::Delete(id) => app.delete_clip(id, ctx),
            ContextAction::Info(id) => app.media_info_clip = Some(id),
        }
    }

    if app.tool == EditTool::Razor {
        if pointer.is_some_and(|position| content.contains(position)) {
            ctx.set_cursor_icon(egui::CursorIcon::Crosshair);
        }
    }
}

fn draw(ui: &egui::Ui, rect: Rect, app: &VideoEditor) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(4), theme::SURFACE);
    painter.rect_stroke(
        rect,
        CornerRadius::same(4),
        Stroke::new(1.0, theme::BORDER),
        StrokeKind::Inside,
    );

    let content = timeline_content(rect);
    painter.line_segment(
        [
            Pos2::new(rect.left(), content.top()),
            Pos2::new(rect.right(), content.top()),
        ],
        Stroke::new(1.0, theme::BORDER),
    );

    let Some(sequence) = &app.sequence else {
        painter.text(
            content.center(),
            Align2::CENTER_CENTER,
            "No media",
            FontId::proportional(12.0),
            theme::MUTED,
        );
        return;
    };
    let duration = sequence.duration.max(0.001);
    let (video_lane, audio_lane) = lane_rects(content);
    painter.line_segment(
        [video_lane.left_bottom(), video_lane.right_bottom()],
        Stroke::new(1.0, theme::BORDER),
    );
    painter.line_segment(
        [audio_lane.left_bottom(), audio_lane.right_bottom()],
        Stroke::new(1.0, theme::BORDER),
    );
    draw_ruler(painter, rect, content, duration);

    for clip in &sequence.clips {
        let (video_rect, audio_rect) = clip_rects(clip, video_lane, audio_lane, duration);
        let is_selected = sequence.selected == Some(clip.id);
        draw_video_clip(
            painter,
            video_rect,
            app.video.as_ref().map_or("Video", |video| &video.name),
            is_selected,
        );
        if app.video.as_ref().is_some_and(|video| video.has_audio) {
            draw_audio_clip(
                painter,
                audio_rect,
                clip,
                app.waveform.as_ref(),
                is_selected,
            );
        }
    }

    if app.current_time >= 0.0 && app.current_time <= duration {
        let x = time_to_x(app.current_time, content, duration);
        painter.line_segment(
            [Pos2::new(x, rect.top()), Pos2::new(x, rect.bottom())],
            Stroke::new(2.0, theme::PLAYHEAD),
        );
        painter.add(egui::Shape::convex_polygon(
            vec![
                Pos2::new(x - 6.0, rect.top()),
                Pos2::new(x + 6.0, rect.top()),
                Pos2::new(x, rect.top() + 8.0),
            ],
            theme::PLAYHEAD,
            Stroke::NONE,
        ));
    }
}

fn draw_labels(ui: &egui::Ui, rect: Rect, app: &VideoEditor) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(4), theme::SURFACE);
    painter.rect_stroke(
        rect,
        CornerRadius::same(4),
        Stroke::new(1.0, theme::BORDER),
        StrokeKind::Inside,
    );
    let content = timeline_content(rect);
    painter.line_segment(
        [
            Pos2::new(rect.left(), content.top()),
            Pos2::new(rect.right(), content.top()),
        ],
        Stroke::new(1.0, theme::BORDER),
    );
    if app.sequence.is_some() {
        let (video_lane, audio_lane) = lane_rects(content);
        draw_lane_label(painter, rect, video_lane, "V1");
        draw_lane_label(painter, rect, audio_lane, "A1");
    }
}

fn timeline_content(rect: Rect) -> Rect {
    Rect::from_min_max(Pos2::new(rect.left(), rect.top() + RULER_HEIGHT), rect.max)
}

fn lane_rects(content: Rect) -> (Rect, Rect) {
    let video = Rect::from_min_size(content.min, Vec2::new(content.width(), VIDEO_HEIGHT));
    let audio = Rect::from_min_size(
        Pos2::new(content.left(), video.bottom()),
        Vec2::new(content.width(), AUDIO_HEIGHT),
    );
    (video, audio)
}

fn clip_rects(
    clip: &SequenceClip,
    video_lane: Rect,
    audio_lane: Rect,
    duration: f64,
) -> (Rect, Rect) {
    let left = time_to_x(clip.timeline_start, video_lane, duration)
        .clamp(video_lane.left(), video_lane.right());
    let right = time_to_x(clip.timeline_end, video_lane, duration)
        .clamp(video_lane.left(), video_lane.right());
    let video = Rect::from_min_max(
        Pos2::new(left, video_lane.top()),
        Pos2::new(right, video_lane.bottom()),
    )
    .shrink2(Vec2::new(2.0, 5.0));
    let audio = Rect::from_min_max(
        Pos2::new(left, audio_lane.top()),
        Pos2::new(right, audio_lane.bottom()),
    )
    .shrink2(Vec2::new(2.0, 5.0));
    (video, audio)
}

fn time_to_x(time: f64, content: Rect, duration: f64) -> f32 {
    egui::lerp(
        content.left()..=content.right(),
        (time / duration.max(0.001)) as f32,
    )
}

fn x_to_time(x: f32, content: Rect, duration: f64) -> f64 {
    let fraction = ((x - content.left()) / content.width().max(1.0)).clamp(0.0, 1.0);
    duration * fraction as f64
}

fn draw_lane_label(painter: &egui::Painter, labels: Rect, lane: Rect, label: &str) {
    let label_rect = Rect::from_min_max(
        Pos2::new(labels.left(), lane.top()),
        Pos2::new(labels.right(), lane.bottom()),
    );
    painter.rect_filled(label_rect, CornerRadius::ZERO, theme::BLACK);
    painter.text(
        label_rect.center(),
        Align2::CENTER_CENTER,
        label,
        FontId::proportional(11.0),
        theme::MUTED,
    );
}

fn draw_ruler(painter: &egui::Painter, rect: Rect, content: Rect, duration: f64) {
    let pixels_per_second = content.width() as f64 / duration.max(0.001);
    let step = [0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0]
        .into_iter()
        .find(|step| step * pixels_per_second >= 72.0)
        .unwrap_or(300.0);
    let first_index = 0;
    let last_index = (duration / step).floor() as usize;
    for index in first_index..=last_index {
        let second = index as f64 * step;
        let x = time_to_x(second, content, duration);
        let is_final = (second - duration).abs() < 0.000_001;
        painter.line_segment(
            [
                Pos2::new(x, content.top() - 9.0),
                Pos2::new(x, content.top()),
            ],
            Stroke::new(1.0, theme::MUTED),
        );
        painter.text(
            Pos2::new(if is_final { x - 4.0 } else { x + 4.0 }, rect.top() + 6.0),
            if is_final {
                Align2::RIGHT_TOP
            } else {
                Align2::LEFT_TOP
            },
            short_time(second),
            FontId::monospace(10.0),
            theme::MUTED,
        );
    }
    if ((duration / step).round() * step - duration).abs() > 0.000_001 {
        let x = content.right();
        painter.line_segment(
            [
                Pos2::new(x, content.top() - 9.0),
                Pos2::new(x, content.top()),
            ],
            Stroke::new(1.0, theme::MUTED),
        );
        painter.text(
            Pos2::new(x - 4.0, rect.top() + 6.0),
            Align2::RIGHT_TOP,
            short_time(duration),
            FontId::monospace(10.0),
            theme::MUTED,
        );
    }
}

fn draw_video_clip(painter: &egui::Painter, rect: Rect, title: &str, selected: bool) {
    painter.rect_filled(rect, CornerRadius::same(3), theme::CLIP);
    if rect.width() > 34.0 {
        painter.text(
            rect.left_top() + Vec2::new(7.0, 7.0),
            Align2::LEFT_TOP,
            title,
            FontId::proportional(11.0),
            Color32::WHITE,
        );
    }
    draw_selection(painter, rect, selected);
}

fn draw_audio_clip(
    painter: &egui::Painter,
    rect: Rect,
    clip: &SequenceClip,
    waveform: Option<&Waveform>,
    selected: bool,
) {
    painter.rect_filled(rect, CornerRadius::same(3), theme::AUDIO);
    if let Some(waveform) = waveform {
        let points = (rect.width() / 3.0).ceil().max(1.0) as usize;
        for index in 0..points {
            let fraction = index as f64 / points.max(1) as f64;
            let source_time = clip.source_in + fraction * (clip.source_out - clip.source_in);
            let amplitude = waveform.peak_at(source_time).sqrt();
            let half_height = 1.0 + amplitude * (rect.height() * 0.42);
            let x = rect.left() + fraction as f32 * rect.width();
            painter.line_segment(
                [
                    Pos2::new(x, rect.center().y - half_height),
                    Pos2::new(x, rect.center().y + half_height),
                ],
                Stroke::new(1.0, Color32::from_white_alpha(180)),
            );
        }
    } else {
        painter.line_segment(
            [rect.left_center(), rect.right_center()],
            Stroke::new(1.0, Color32::from_white_alpha(90)),
        );
    }
    draw_selection(painter, rect, selected);
}

fn draw_selection(painter: &egui::Painter, rect: Rect, selected: bool) {
    if selected {
        painter.rect_stroke(
            rect,
            CornerRadius::same(3),
            Stroke::new(2.0, theme::SELECTION),
            StrokeKind::Inside,
        );
    }
}

fn short_time(seconds: f64) -> String {
    let seconds = seconds.round() as u64;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use eframe::egui::{pos2, Rect};

    use super::{playhead_needs_follow, timeline_canvas_width, timeline_is_scrollable};

    #[test]
    fn zoom_scales_the_full_timeline_canvas_width() {
        assert_eq!(timeline_canvas_width(800.0, 1.0), 800.0);
        assert_eq!(timeline_canvas_width(800.0, 4.0), 3_200.0);
        assert_eq!(timeline_canvas_width(800.0, 32.0), 25_600.0);
    }

    #[test]
    fn scrollbar_only_appears_when_the_timeline_is_zoomed() {
        assert!(!timeline_is_scrollable(1.0));
        assert!(timeline_is_scrollable(1.01));
        assert!(timeline_is_scrollable(32.0));
    }

    #[test]
    fn playhead_follow_uses_a_stable_middle_zone() {
        let viewport = Rect::from_min_max(pos2(100.0, 0.0), pos2(1_100.0, 100.0));
        assert!(playhead_needs_follow(viewport, 300.0));
        assert!(!playhead_needs_follow(viewport, 500.0));
        assert!(!playhead_needs_follow(viewport, 800.0));
        assert!(playhead_needs_follow(viewport, 900.0));
    }
}
