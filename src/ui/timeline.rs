use eframe::egui::{
    self, scroll_area::ScrollBarVisibility, Align, Align2, Color32, CornerRadius, FontId, Frame,
    Layout, Margin, Pos2, Rect, Sense, Stroke, StrokeKind, Vec2,
};

use crate::{
    app::{MarqueeSelection, TimelineDropPreview, TimelineDropSource, VideoEditor},
    media::waveform::Waveform,
    project::{
        sequence::{ClipColor, ClipLane, MediaId, SequenceClip},
        EditTool, MAX_TIMELINE_HEIGHT, MIN_TIMELINE_HEIGHT,
    },
};

use super::{
    icons::{self, Icon},
    theme,
};

const LABEL_WIDTH: f32 = 54.0;
const RULER_HEIGHT: f32 = 30.0;
const VIDEO_HEIGHT: f32 = 48.0;
const AUDIO_HEIGHT: f32 = 42.0;
const EDGE_HIT_WIDTH: f32 = 8.0;
const SCROLLBAR_RESERVE: f32 = 12.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Copy, Debug)]
struct TrackRow {
    kind: TrackKind,
    index: u8,
    rect: Rect,
}

#[derive(Clone, Debug)]
struct TrackLayout {
    rows: Vec<TrackRow>,
}

impl TrackLayout {
    fn new(content: Rect) -> Self {
        let mut video_count = 1_u8;
        let mut audio_count = 1_u8;
        let mut used = VIDEO_HEIGHT + AUDIO_HEIGHT;
        let mut next_video = true;
        loop {
            let row_height = if next_video {
                VIDEO_HEIGHT
            } else {
                AUDIO_HEIGHT
            };
            if used + row_height > content.height() + 0.5 {
                if next_video && used + AUDIO_HEIGHT <= content.height() + 0.5 {
                    audio_count = audio_count.saturating_add(1);
                    used += AUDIO_HEIGHT;
                    next_video = true;
                    continue;
                }
                break;
            }
            if next_video {
                video_count = video_count.saturating_add(1);
            } else {
                audio_count = audio_count.saturating_add(1);
            }
            used += row_height;
            next_video = !next_video;
        }

        let top = content.top() + ((content.height() - used).max(0.0) * 0.5);
        let mut y = top;
        let mut rows = Vec::with_capacity(video_count as usize + audio_count as usize);
        for index in (1..=video_count).rev() {
            let rect = Rect::from_min_size(
                Pos2::new(content.left(), y),
                Vec2::new(content.width(), VIDEO_HEIGHT),
            );
            rows.push(TrackRow {
                kind: TrackKind::Video,
                index,
                rect,
            });
            y += VIDEO_HEIGHT;
        }
        for index in 1..=audio_count {
            let rect = Rect::from_min_size(
                Pos2::new(content.left(), y),
                Vec2::new(content.width(), AUDIO_HEIGHT),
            );
            rows.push(TrackRow {
                kind: TrackKind::Audio,
                index,
                rect,
            });
            y += AUDIO_HEIGHT;
        }
        Self { rows }
    }

    fn row(&self, kind: TrackKind, index: u8) -> Option<Rect> {
        self.rows
            .iter()
            .find(|row| row.kind == kind && row.index == index.max(1))
            .map(|row| row.rect)
    }

    fn track_at(&self, y: f32, lane: ClipLane) -> Option<u8> {
        self.rows
            .iter()
            .find(|row| {
                row.rect.contains(Pos2::new(row.rect.center().x, y))
                    && match lane {
                        ClipLane::Video => row.kind == TrackKind::Video,
                        ClipLane::Audio => row.kind == TrackKind::Audio,
                        ClipLane::Both => row.index == 1,
                    }
            })
            .map(|row| row.index)
    }
}

pub fn show(ctx: &egui::Context, app: &mut VideoEditor) {
    let response = egui::TopBottomPanel::bottom("timeline")
        .resizable(true)
        .default_height(app.timeline_height)
        .min_height(MIN_TIMELINE_HEIGHT)
        .max_height(MAX_TIMELINE_HEIGHT)
        .frame(
            Frame::new()
                .fill(theme::BLACK)
                .inner_margin(Margin::symmetric(14, 10)),
        )
        .show(ctx, |ui| {
            let available = ui.available_size();
            // Keep the strip reserved at every zoom level so the timeline never jumps
            // vertically when the scrollbar appears or disappears.
            let canvas_height = (available.y - SCROLLBAR_RESERVE).max(1.0);
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.horizontal_top(|ui| {
                let (labels, _) =
                    ui.allocate_exact_size(Vec2::new(LABEL_WIDTH, canvas_height), Sense::hover());
                draw_labels(ui, labels, app);

                let viewport_width = ui.available_width().max(1.0);
                let view_duration =
                    timeline_view_duration(app.timeline_interaction_duration().max(0.0));
                let canvas_width =
                    timeline_canvas_width(viewport_width, app.timeline_zoom, view_duration);
                let scrollable = timeline_is_scrollable(canvas_width, viewport_width);
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
                        let (rect, timeline_response) = ui.allocate_exact_size(
                            Vec2::new(canvas_width, canvas_height),
                            Sense::click_and_drag(),
                        );
                        draw(ui, rect, app);
                        interact(ui, ctx, rect, timeline_response, app);
                        if app.playing && scrollable {
                            let playhead_x =
                                time_to_x(app.current_time, timeline_content(rect), view_duration);
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
    app.timeline_height = response
        .response
        .rect
        .height()
        .clamp(MIN_TIMELINE_HEIGHT, MAX_TIMELINE_HEIGHT);
}

pub fn zoom_controls(ui: &mut egui::Ui, app: &mut VideoEditor) {
    ui.allocate_ui_with_layout(
        Vec2::new(265.0, 34.0),
        Layout::left_to_right(Align::Center),
        |ui| {
            let can_zoom = app
                .sequence
                .as_ref()
                .is_some_and(|sequence| !sequence.clips.is_empty());
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

/// Seconds shown across the viewport at 100% zoom. Short sequences stay on this
/// fixed scale (Premiere-style) instead of stretching to fill the strip.
const BASE_VIEW_DURATION: f64 = 30.0;
/// Empty runway kept after the last clip once content grows past the base view.
const TIMELINE_RUNWAY: f64 = 8.0;

fn timeline_canvas_width(viewport_width: f32, zoom: f32, view_duration: f64) -> f32 {
    let zoom = zoom.clamp(1.0, 32.0);
    let scale = (view_duration / BASE_VIEW_DURATION).max(1.0) as f32;
    viewport_width.max(1.0) * zoom * scale
}

pub fn timeline_view_duration(content_duration: f64) -> f64 {
    // Fixed time scale until the sequence (+ runway) needs more room.
    let needed = if content_duration <= 0.0 {
        BASE_VIEW_DURATION
    } else {
        content_duration + TIMELINE_RUNWAY
    };
    needed.max(BASE_VIEW_DURATION)
}

fn timeline_is_scrollable(canvas_width: f32, viewport_width: f32) -> bool {
    canvas_width > viewport_width + 1.0
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
    let clips = app
        .sequence
        .as_ref()
        .map(|sequence| sequence.clips.clone())
        .unwrap_or_default();
    let has_selection = app
        .sequence
        .as_ref()
        .is_some_and(|sequence| !sequence.selected.is_empty());
    let content_duration = app.timeline_interaction_duration().max(0.001);
    let duration = timeline_view_duration(content_duration);
    let content = timeline_content(rect);
    let tracks = TrackLayout::new(content);
    let pointer = ui.input(|input| input.pointer.hover_pos().or(input.pointer.interact_pos()));
    let shift = ctx.input(|input| input.modifiers.shift);
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
        Delete(crate::project::sequence::ClipId),
        Info(crate::project::sequence::ClipId),
        Duplicate(crate::project::sequence::ClipId),
        Link,
        Unlink(crate::project::sequence::ClipId),
        Color(crate::project::sequence::ClipId, ClipColor),
    }
    let mut context_action = None;

    let internal_drop = egui::DragAndDrop::payload::<MediaId>(ctx);
    let hovered_external = ctx.input(|input| {
        input
            .raw
            .hovered_files
            .iter()
            .find_map(|file| file.path.clone())
    });
    if let Some(path) = &hovered_external {
        app.prepare_external_media_hover(path, ctx);
    }

    let active_drop = internal_drop
        .as_ref()
        .and_then(|id| {
            app.media_asset(**id).map(|asset| {
                (
                    TimelineDropSource::Library(**id),
                    asset.name.clone(),
                    asset.duration,
                )
            })
        })
        .or_else(|| {
            hovered_external.as_ref().and_then(|path| {
                app.external_media_preview(path).map(|(name, duration)| {
                    (TimelineDropSource::External(path.clone()), name, duration)
                })
            })
        });
    if let Some((source, name, source_duration)) = active_drop {
        let previous = app
            .timeline_drop_preview
            .as_ref()
            .filter(|preview| preview.source == source)
            .cloned();
        let placement = match pointer {
            Some(position) if rect.contains(position) => {
                // Allow drops on the empty runway past the last clip (view duration).
                Some(x_to_time(position.x, content, duration).max(0.0))
            }
            Some(_) => None,
            None => previous
                .as_ref()
                .map(|preview| preview.timeline_start)
                .or_else(|| {
                    matches!(source, TimelineDropSource::External(_)).then(|| app.duration())
                }),
        };
        if let Some(requested) = placement {
            let snap = 9.0 / (content.width() as f64 / duration);
            let (start, valid) = app.placement_preview(source_duration, requested, snap);
            app.timeline_drop_preview = Some(TimelineDropPreview {
                source,
                name,
                source_duration,
                timeline_start: start,
                valid,
            });
        } else if app
            .timeline_drop_preview
            .as_ref()
            .is_some_and(|preview| preview.source == source)
        {
            app.timeline_drop_preview = None;
        }
    }
    if let Some(preview) = &app.timeline_drop_preview {
        let ghost_track = app
            .sequence
            .as_ref()
            .and_then(|sequence| {
                sequence.free_track_for(
                    preview.timeline_start,
                    preview.timeline_start + preview.source_duration,
                    ClipLane::Both,
                )
            })
            .unwrap_or(1);
        draw_drop_ghost(
            ui.painter(),
            content,
            &tracks,
            duration,
            preview.timeline_start,
            preview.source_duration,
            &preview.name,
            preview.valid,
            ghost_track,
        );
    }

    for clip in &clips {
        let has_audio = app
            .media_asset(clip.media_id)
            .is_some_and(|media| media.has_audio);
        let (video_rect, audio_rect) = visible_clip_rects(clip, &tracks, duration, has_audio);
        let Some(body_rect) = clip_hit_rect(video_rect, audio_rect) else {
            continue;
        };
        let handle_lane = video_rect.or(audio_rect).unwrap_or(body_rect);
        pointer_over_clip |= pointer.is_some_and(|position| body_rect.contains(position));

        if app.tool == EditTool::Select {
            let (left_handle, right_handle) = trim_handle_rects(handle_lane, body_rect);
            let left = ui
                .interact(
                    left_handle,
                    ui.id().with(("trim-left", clip.id)),
                    Sense::click_and_drag(),
                )
                .on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
            let right = ui
                .interact(
                    right_handle,
                    ui.id().with(("trim-right", clip.id)),
                    Sense::click_and_drag(),
                )
                .on_hover_cursor(egui::CursorIcon::ResizeHorizontal);
            edge_active |= left.hovered() || left.dragged() || right.hovered() || right.dragged();
            if left.clicked() || right.clicked() {
                app.select_clip_only(clip.id);
            }
            if left.drag_started() || right.drag_started() {
                app.select_clip_only(clip.id);
                app.begin_history_transaction();
            }
            if left.dragged() {
                if let Some(position) = left.interact_pointer_pos() {
                    let snap = 9.0 / (content.width() as f64 / duration);
                    app.trim_left(clip.id, x_to_time(position.x, content, duration), snap, ctx);
                }
            } else if right.dragged() {
                if let Some(position) = right.interact_pointer_pos() {
                    let snap = 9.0 / (content.width() as f64 / duration);
                    app.trim_right(clip.id, x_to_time(position.x, content, duration), snap, ctx);
                }
            }
            if left.drag_stopped() || right.drag_stopped() {
                app.commit_history_transaction();
            }
        }

        let body_hit_rect = Rect::from_min_max(
            Pos2::new(
                (body_rect.left() + EDGE_HIT_WIDTH).min(body_rect.center().x - 0.5),
                body_rect.top(),
            ),
            Pos2::new(
                (body_rect.right() - EDGE_HIT_WIDTH).max(body_rect.center().x + 0.5),
                body_rect.bottom(),
            ),
        );
        let body = ui.interact(
            body_hit_rect,
            ui.id().with(("clip-body", clip.id)),
            Sense::click_and_drag(),
        );
        let body = if app.tool == EditTool::Razor {
            body.on_hover_cursor(egui::CursorIcon::Crosshair)
        } else {
            body.on_hover_cursor(egui::CursorIcon::PointingHand)
        };
        if body.secondary_clicked() {
            if !app
                .sequence
                .as_ref()
                .is_some_and(|sequence| sequence.is_selected(clip.id))
            {
                app.select_clip_only(clip.id);
            }
        }
        let can_link_selection = app
            .sequence
            .as_ref()
            .is_some_and(|sequence| sequence.can_link_selected());
        body.context_menu(|ui| {
            ui.visuals_mut().panel_fill = theme::BLACK;
            ui.visuals_mut().window_fill = theme::BLACK;
            ui.set_min_width(158.0);
            ui.set_max_width(180.0);
            ui.spacing_mut().item_spacing.y = 2.0;
            ui.spacing_mut().button_padding = Vec2::new(7.0, 5.0);
            if icons::menu_item(ui, Icon::Info, "Clip info").clicked() {
                context_action = Some(ContextAction::Info(clip.id));
                ui.close_menu();
            }
            if icons::menu_item(ui, Icon::Duplicate, "Duplicate clip").clicked() {
                context_action = Some(ContextAction::Duplicate(clip.id));
                ui.close_menu();
            }
            if clip.lane == ClipLane::Both && has_audio {
                if icons::menu_item(ui, Icon::Unlink, "Unlink").clicked() {
                    context_action = Some(ContextAction::Unlink(clip.id));
                    ui.close_menu();
                }
            }
            if can_link_selection {
                if icons::menu_item(ui, Icon::Link, "Link").clicked() {
                    context_action = Some(ContextAction::Link);
                    ui.close_menu();
                }
            }
            if icons::menu_item(ui, Icon::Delete, "Delete clip").clicked() {
                context_action = Some(ContextAction::Delete(clip.id));
                ui.close_menu();
            }
            ui.separator();
            ui.menu_button("Label", |ui| {
                ui.visuals_mut().panel_fill = theme::BLACK;
                ui.visuals_mut().window_fill = theme::BLACK;
                ui.set_min_width(132.0);
                ui.set_max_width(148.0);
                ui.spacing_mut().item_spacing.y = 2.0;
                for color in ClipColor::ALL {
                    if color_submenu_item(ui, color, clip.color == color).clicked() {
                        context_action = Some(ContextAction::Color(clip.id, color));
                        ui.close_menu();
                    }
                }
            });
        });
        // Don't steal an in-progress marquee when the pointer crosses a clip.
        let marquee_active = app.marquee.is_some();
        if app.tool == EditTool::Select && body.drag_started() && !edge_active && !marquee_active {
            if let Some(position) = body.interact_pointer_pos() {
                if !app
                    .sequence
                    .as_ref()
                    .is_some_and(|sequence| sequence.is_selected(clip.id))
                {
                    app.select_clip_only(clip.id);
                }
                let duplicate = ctx.input(|input| input.modifiers.alt);
                app.begin_clip_drag(clip.id, x_to_time(position.x, content, duration), duplicate);
            }
        }
        if body.dragged() && !edge_active && !marquee_active {
            if let Some(position) = body.interact_pointer_pos() {
                let snap = 9.0 / (content.width() as f64 / duration);
                let target_track = tracks.track_at(position.y, clip.lane);
                app.update_clip_drag(
                    x_to_time(position.x, content, duration),
                    target_track,
                    snap,
                    ctx,
                );
            }
        }
        if body.drag_stopped() && !marquee_active {
            app.finish_clip_drag();
        }
        if body.clicked() && !edge_active && !marquee_active {
            match app.tool {
                EditTool::Select => {
                    if shift {
                        app.toggle_clip_selection(clip.id);
                    } else {
                        app.select_clip_only(clip.id);
                    }
                }
                EditTool::Razor => {
                    if let Some(position) = body.interact_pointer_pos() {
                        app.razor_cut(x_to_time(position.x, content, duration), ctx);
                    }
                }
            }
        }
    }

    // Timestamp ruler: click/drag scrubs the playhead (never a marquee).
    let ruler = Rect::from_min_max(
        Pos2::new(rect.left(), rect.top()),
        Pos2::new(rect.right(), content.top()),
    );
    let pointer_in_ruler = pointer.is_some_and(|position| ruler.contains(position));
    let primary_down = ctx.input(|input| input.pointer.primary_down());
    let primary_released = ctx.input(|input| input.pointer.primary_released());

    if pointer_in_ruler {
        ctx.set_cursor_icon(egui::CursorIcon::ResizeHorizontal);
    }

    if app.clip_drag.is_none() {
        if !app.ruler_scrubbing && timeline_response.drag_started() && pointer_in_ruler {
            app.ruler_scrubbing = true;
            app.marquee = None;
        }
        if app.ruler_scrubbing {
            if primary_down {
                if let Some(position) = pointer {
                    app.seek(x_to_time(position.x, content, duration), ctx);
                }
            }
            if primary_released {
                app.ruler_scrubbing = false;
            }
        }
    }

    // Marquee selection: start on empty track space (not the ruler).
    // Selection updates live as the box covers clips; tiny releases still seek.
    const MARQUEE_MIN_PX: f32 = 6.0;
    let mut seek_empty_at = None;

    if app.tool == EditTool::Select && app.clip_drag.is_none() && !app.ruler_scrubbing {
        // Start only from empty lane space below the ruler.
        if app.marquee.is_none()
            && !pointer_over_clip
            && !edge_active
            && !pointer_in_ruler
            && timeline_response.drag_started()
        {
            if let Some(position) = timeline_response
                .interact_pointer_pos()
                .or(pointer)
                .filter(|position| content.contains(*position))
            {
                let baseline = app
                    .sequence
                    .as_ref()
                    .map(|sequence| sequence.selected.clone())
                    .unwrap_or_default();
                app.marquee = Some(MarqueeSelection {
                    start: position,
                    end: position,
                    baseline,
                });
            }
        }

        // Follow the pointer and select covered clips immediately.
        if primary_down {
            if let (Some(marquee), Some(position)) = (app.marquee.as_mut(), pointer) {
                marquee.end = position;
            }
            if let Some(marquee) = app.marquee.clone() {
                let box_rect = marquee.rect();
                if box_rect.width() > MARQUEE_MIN_PX || box_rect.height() > MARQUEE_MIN_PX {
                    let covered = clips
                        .iter()
                        .filter(|clip| {
                            let has_audio = app
                                .media_asset(clip.media_id)
                                .is_some_and(|media| media.has_audio);
                            let (video_rect, audio_rect) =
                                visible_clip_rects(clip, &tracks, duration, has_audio);
                            video_rect.is_some_and(|rect| rect.intersects(box_rect))
                                || audio_rect.is_some_and(|rect| rect.intersects(box_rect))
                        })
                        .map(|clip| clip.id)
                        .collect::<Vec<_>>();
                    if shift {
                        let mut ids = marquee.baseline;
                        for id in covered {
                            if !ids.contains(&id) {
                                ids.push(id);
                            }
                        }
                        app.select_clips(ids);
                    } else {
                        app.select_clips(covered);
                    }
                }
            }
        }

        if primary_released {
            if let Some(marquee) = app.marquee.take() {
                let box_rect = marquee.rect();
                let is_real_marquee =
                    box_rect.width() > MARQUEE_MIN_PX || box_rect.height() > MARQUEE_MIN_PX;
                // Tiny drag on empty track: deselect only — playhead stays put.
                if !is_real_marquee && !pointer_over_clip && !pointer_in_ruler && has_selection {
                    app.clear_clip_selection();
                }
            }
        }
    } else if app.tool != EditTool::Select {
        app.marquee = None;
    }

    // Click empty track: deselect only. Click/drag the ruler: move playhead.
    if seek_empty_at.is_none()
        && timeline_response.clicked()
        && !pointer_over_clip
        && !edge_active
        && !app.ruler_scrubbing
        && app.marquee.is_none()
    {
        if let Some(position) = timeline_response.interact_pointer_pos() {
            if ruler.contains(position) {
                seek_empty_at = Some(position);
            } else if has_selection {
                app.clear_clip_selection();
            }
        }
    }

    if let Some(position) = seek_empty_at {
        app.seek(x_to_time(position.x, content, duration), ctx);
    }

    if let Some(marquee) = &app.marquee {
        let box_rect = marquee.rect();
        ui.painter().rect_filled(
            box_rect,
            CornerRadius::same(2),
            Color32::from_white_alpha(28),
        );
        ui.painter().rect_stroke(
            box_rect,
            CornerRadius::same(2),
            Stroke::new(1.0, Color32::from_white_alpha(210)),
            StrokeKind::Inside,
        );
    }

    if let Some(action) = context_action {
        match action {
            ContextAction::Delete(id) => {
                let multi = app.sequence.as_ref().is_some_and(|sequence| {
                    sequence.selected.len() > 1 && sequence.is_selected(id)
                });
                if multi {
                    app.delete_selected(ctx);
                } else {
                    app.delete_clip(id, ctx);
                }
            }
            ContextAction::Info(id) => app.media_info_clip = Some(id),
            ContextAction::Duplicate(id) => {
                app.duplicate_clip(id, ctx);
            }
            ContextAction::Link => app.link_selected_clips(ctx),
            ContextAction::Unlink(id) => app.unlink_clip(id, ctx),
            ContextAction::Color(id, color) => app.set_clip_color(id, color),
        }
    }

    let dropped_external = ctx.input(|input| {
        input
            .raw
            .dropped_files
            .iter()
            .find_map(|file| file.path.clone())
    });
    let external_was_dropped = dropped_external.is_some();
    if let Some(path) = dropped_external {
        let preview = app
            .timeline_drop_preview
            .clone()
            .filter(|preview| preview.source == TimelineDropSource::External(path.clone()))
            .or_else(|| {
                app.external_media_preview(&path)
                    .map(|(name, source_duration)| {
                        let requested = pointer
                            .filter(|position| rect.contains(*position))
                            .map_or_else(
                                || app.duration(),
                                |position| x_to_time(position.x, content, duration).max(0.0),
                            );
                        let snap = 9.0 / (content.width() as f64 / duration);
                        let (timeline_start, valid) =
                            app.placement_preview(source_duration, requested, snap);
                        TimelineDropPreview {
                            source: TimelineDropSource::External(path.clone()),
                            name,
                            source_duration,
                            timeline_start,
                            valid,
                        }
                    })
            });
        if let Some(preview) = preview {
            if preview.valid {
                app.place_external_media(path, preview.timeline_start, 0.0, ctx);
            } else {
                app.status = Some("That clip would overlap another clip.".to_owned());
            }
        }
        app.timeline_drop_preview = None;
    }

    if !external_was_dropped && ctx.input(|input| input.pointer.any_released()) {
        if let (Some(payload), Some(preview)) =
            (internal_drop.as_ref(), app.timeline_drop_preview.clone())
        {
            if preview.source == TimelineDropSource::Library(**payload) {
                if preview.valid {
                    app.insert_media_at(**payload, preview.timeline_start, 0.0, ctx);
                } else {
                    app.status = Some("That clip would overlap another clip.".to_owned());
                }
            }
        }
        egui::DragAndDrop::clear_payload(ctx);
        app.timeline_drop_preview = None;
    }

    if internal_drop.is_none()
        && hovered_external.is_none()
        && !ctx.input(|input| input.pointer.any_released())
    {
        app.timeline_drop_preview = None;
    }

    if app.tool == EditTool::Razor && pointer.is_some_and(|position| content.contains(position)) {
        ctx.set_cursor_icon(egui::CursorIcon::Crosshair);
    }
}

fn trim_handle_rects(video_rect: Rect, body_rect: Rect) -> (Rect, Rect) {
    let handle_width = EDGE_HIT_WIDTH.min((video_rect.width() * 0.5).max(0.0));
    let cut_inset = (handle_width * 0.1).min(0.5);
    (
        Rect::from_min_max(
            Pos2::new(video_rect.left() + cut_inset, body_rect.top()),
            Pos2::new(video_rect.left() + handle_width, body_rect.bottom()),
        ),
        Rect::from_min_max(
            Pos2::new(video_rect.right() - handle_width, body_rect.top()),
            Pos2::new(video_rect.right() - cut_inset, body_rect.bottom()),
        ),
    )
}

#[allow(clippy::too_many_arguments)]
fn draw_drop_ghost(
    painter: &egui::Painter,
    content: Rect,
    tracks: &TrackLayout,
    timeline_duration: f64,
    start: f64,
    source_duration: f64,
    title: &str,
    valid: bool,
    track: u8,
) {
    let pixels_per_second =
        content.width() as f64 / timeline_duration.max(source_duration).max(0.001);
    let width = (source_duration * pixels_per_second) as f32;
    let width = width.clamp(30.0, content.width());
    let requested_left = time_to_x(start, content, timeline_duration);
    let left = requested_left
        .min(content.right() - width)
        .max(content.left());
    let track = track.max(1);
    let Some(video_lane) = tracks
        .row(TrackKind::Video, track)
        .or_else(|| tracks.row(TrackKind::Video, 1))
    else {
        return;
    };
    let Some(audio_lane) = tracks
        .row(TrackKind::Audio, track)
        .or_else(|| tracks.row(TrackKind::Audio, 1))
    else {
        return;
    };
    let video = Rect::from_min_size(
        Pos2::new(left, video_lane.top() + 5.0),
        Vec2::new(width, (video_lane.height() - 10.0).max(1.0)),
    );
    let audio = Rect::from_min_size(
        Pos2::new(left, audio_lane.top() + 5.0),
        Vec2::new(width, (audio_lane.height() - 10.0).max(1.0)),
    );
    let color = if valid {
        Color32::from_rgba_unmultiplied(52, 120, 246, 105)
    } else {
        Color32::from_rgba_unmultiplied(210, 55, 65, 105)
    };
    let stroke = Stroke::new(
        1.5,
        if valid {
            Color32::from_rgb(115, 164, 255)
        } else {
            Color32::from_rgb(255, 105, 115)
        },
    );
    for rect in [video, audio] {
        painter.rect_filled(rect, CornerRadius::same(4), color);
        painter.rect_stroke(rect, CornerRadius::same(4), stroke, StrokeKind::Inside);
    }
    if video.width() > 45.0 {
        painter.text(
            video.left_top() + Vec2::new(7.0, 7.0),
            Align2::LEFT_TOP,
            title,
            FontId::proportional(11.0),
            Color32::WHITE,
        );
    }
}

fn color_submenu_item(ui: &mut egui::Ui, color: ClipColor, selected: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width().max(124.0), 27.0),
        Sense::click(),
    );
    if response.hovered() {
        ui.painter()
            .rect_filled(rect, CornerRadius::same(5), theme::SURFACE_HOVER);
    }
    let center = Pos2::new(rect.left() + 13.0, rect.center().y);
    ui.painter().circle_filled(center, 6.0, clip_color(color));
    if selected {
        ui.painter()
            .circle_stroke(center, 9.0, Stroke::new(1.5, theme::TEXT));
    }
    ui.painter().text(
        Pos2::new(rect.left() + 28.0, rect.center().y),
        Align2::LEFT_CENTER,
        color.label(),
        FontId::proportional(12.0),
        theme::TEXT,
    );
    response.on_hover_cursor(egui::CursorIcon::PointingHand)
}

fn draw(ui: &egui::Ui, rect: Rect, app: &VideoEditor) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(6), theme::SURFACE);

    let content = timeline_content(rect);
    let tracks = TrackLayout::new(content);
    draw_lane_lines(painter, &tracks);

    if let Some(drag) = app.clip_drag.as_ref().filter(|drag| drag.valid_target) {
        if let Some(clip) = app
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip(drag.clip_id))
        {
            let kinds: &[TrackKind] = match clip.lane {
                ClipLane::Both => &[TrackKind::Video, TrackKind::Audio],
                ClipLane::Video => &[TrackKind::Video],
                ClipLane::Audio => &[TrackKind::Audio],
            };
            for kind in kinds {
                if let Some(row) = tracks.row(*kind, drag.target_track) {
                    painter.rect_filled(
                        row,
                        CornerRadius::ZERO,
                        Color32::from_rgba_unmultiplied(52, 120, 246, 28),
                    );
                }
            }
        }
    }

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
    let content_duration = sequence.duration.max(0.001);
    let duration = timeline_view_duration(app.timeline_interaction_duration().max(0.001));
    draw_ruler(painter, rect, content, duration, content_duration);

    for clip in &sequence.clips {
        let has_audio = app
            .media_asset(clip.media_id)
            .is_some_and(|video| video.has_audio);
        let (video_rect, audio_rect) = visible_clip_rects(clip, &tracks, duration, has_audio);
        let is_selected = sequence.is_selected(clip.id);
        let source_duration = app
            .media_asset(clip.media_id)
            .map(|asset| asset.duration)
            .unwrap_or(clip.source_out);
        let media_bounds = media_bound_flags(clip, source_duration);
        if let Some(video_rect) = video_rect {
            draw_video_clip(
                painter,
                video_rect,
                app.media_asset(clip.media_id)
                    .map_or("Offline media", |video| &video.name),
                app.media_thumbnail(clip.media_id),
                clip.color,
                is_selected,
                media_bounds,
            );
        }
        if let Some(audio_rect) = audio_rect {
            draw_audio_clip(
                painter,
                audio_rect,
                clip,
                app.media_waveform(clip.media_id),
                clip.color,
                is_selected,
                media_bounds,
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
    painter.rect_filled(rect, CornerRadius::same(6), theme::SURFACE);
    let content = timeline_content(rect);
    let tracks = TrackLayout::new(content);
    draw_lane_lines(painter, &tracks);
    if app.sequence.is_some() {
        for row in &tracks.rows {
            let prefix = match row.kind {
                TrackKind::Video => 'V',
                TrackKind::Audio => 'A',
            };
            draw_lane_label(painter, rect, row.rect, &format!("{prefix}{}", row.index));
        }
    }
}

fn timeline_content(rect: Rect) -> Rect {
    Rect::from_min_max(Pos2::new(rect.left(), rect.top() + RULER_HEIGHT), rect.max)
}

fn draw_lane_lines(painter: &egui::Painter, tracks: &TrackLayout) {
    let stroke = Stroke::new(1.0, theme::BORDER);
    for row in &tracks.rows {
        painter.line_segment(
            [
                Pos2::new(row.rect.left(), row.rect.top()),
                Pos2::new(row.rect.right(), row.rect.top()),
            ],
            stroke,
        );
    }
    if let Some(last) = tracks.rows.last() {
        painter.line_segment(
            [
                Pos2::new(last.rect.left(), last.rect.bottom()),
                Pos2::new(last.rect.right(), last.rect.bottom()),
            ],
            stroke,
        );
    }
}

fn clip_rects(
    clip: &SequenceClip,
    tracks: &TrackLayout,
    duration: f64,
) -> (Option<Rect>, Option<Rect>) {
    let video_lane = tracks.row(TrackKind::Video, clip.track());
    let audio_lane = tracks.row(TrackKind::Audio, clip.track());
    let left = time_to_x(clip.timeline_start, tracks.rows[0].rect, duration)
        .clamp(tracks.rows[0].rect.left(), tracks.rows[0].rect.right());
    let right = time_to_x(clip.timeline_end, tracks.rows[0].rect, duration)
        .clamp(tracks.rows[0].rect.left(), tracks.rows[0].rect.right());
    // 1px inset each side restores a hairline dark gap between abutting clips.
    let video = video_lane.map(|lane| {
        Rect::from_min_max(Pos2::new(left, lane.top()), Pos2::new(right, lane.bottom()))
            .shrink2(Vec2::new(1.0, 5.0))
    });
    let audio = audio_lane.map(|lane| {
        Rect::from_min_max(Pos2::new(left, lane.top()), Pos2::new(right, lane.bottom()))
            .shrink2(Vec2::new(1.0, 5.0))
    });
    (video, audio)
}

fn visible_clip_rects(
    clip: &SequenceClip,
    tracks: &TrackLayout,
    duration: f64,
    has_audio: bool,
) -> (Option<Rect>, Option<Rect>) {
    let (video, audio) = clip_rects(clip, tracks, duration);
    (
        clip.lane.shows_video().then_some(video).flatten(),
        (clip.lane.shows_audio() && has_audio)
            .then_some(audio)
            .flatten(),
    )
}

fn clip_hit_rect(video: Option<Rect>, audio: Option<Rect>) -> Option<Rect> {
    match (video, audio) {
        (Some(video), Some(audio)) => Some(video.union(audio)),
        (Some(video), None) => Some(video),
        (None, Some(audio)) => Some(audio),
        (None, None) => None,
    }
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

fn draw_ruler(
    painter: &egui::Painter,
    rect: Rect,
    content: Rect,
    view_duration: f64,
    _content_duration: f64,
) {
    let pixels_per_second = content.width() as f64 / view_duration.max(0.001);
    let step = [0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0]
        .into_iter()
        .find(|step| step * pixels_per_second >= 72.0)
        .unwrap_or(300.0);
    let last_index = (view_duration / step).floor() as usize;
    for index in 0..=last_index {
        let second = index as f64 * step;
        if second > view_duration + 0.000_001 {
            break;
        }
        let x = time_to_x(second, content, view_duration);
        let near_end = x > content.right() - 36.0;
        painter.line_segment(
            [
                Pos2::new(x, content.top() - 9.0),
                Pos2::new(x, content.top()),
            ],
            Stroke::new(1.0, theme::MUTED),
        );
        painter.text(
            Pos2::new(if near_end { x - 4.0 } else { x + 4.0 }, rect.top() + 6.0),
            if near_end {
                Align2::RIGHT_TOP
            } else {
                Align2::LEFT_TOP
            },
            short_time(second),
            FontId::monospace(10.0),
            theme::MUTED,
        );
    }
}

#[derive(Clone, Copy)]
struct MediaBoundFlags {
    at_start: bool,
    at_end: bool,
}

fn media_bound_flags(clip: &SequenceClip, source_duration: f64) -> MediaBoundFlags {
    let epsilon = 0.001;
    MediaBoundFlags {
        at_start: clip.source_in <= epsilon,
        at_end: clip.source_out >= source_duration - epsilon,
    }
}

fn draw_video_clip(
    painter: &egui::Painter,
    rect: Rect,
    title: &str,
    thumbnail: Option<&egui::TextureHandle>,
    color: ClipColor,
    selected: bool,
    media_bounds: MediaBoundFlags,
) {
    let fill = clip_color(color);
    painter.rect_filled(rect, CornerRadius::same(3), fill);
    draw_clip_edge_tint(painter, rect, fill);
    if rect.width() > 34.0 {
        let font = FontId::proportional(11.0);
        let title = truncate_clip_title(painter, title, &font, (rect.width() - 14.0).max(1.0));
        painter.text(
            rect.left_top() + Vec2::new(7.0, 7.0),
            Align2::LEFT_TOP,
            title,
            font,
            Color32::WHITE,
        );
    }
    // Small poster box under the title — not a full-bleed fill of the clip body.
    if let Some(thumbnail) = thumbnail.filter(|_| rect.width() > 48.0 && rect.height() > 36.0) {
        let thumb_h = 20.0_f32.min((rect.height() - 26.0).max(12.0));
        let thumb_w = (thumb_h * 16.0 / 9.0).min(rect.width() - 14.0);
        let image_bounds = Rect::from_min_size(
            rect.left_top() + Vec2::new(7.0, 22.0),
            Vec2::new(thumb_w, thumb_h),
        );
        let source_size = thumbnail.size_vec2();
        let scale = (image_bounds.width() / source_size.x.max(1.0))
            .max(image_bounds.height() / source_size.y.max(1.0));
        let image_size = source_size * scale;
        let image_rect = Rect::from_center_size(image_bounds.center(), image_size);
        painter.rect_filled(
            image_bounds,
            CornerRadius::same(2),
            Color32::from_black_alpha(60),
        );
        painter.with_clip_rect(image_bounds).image(
            thumbnail.id(),
            image_rect,
            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            Color32::WHITE,
        );
    }
    draw_media_bound_markers(painter, rect, media_bounds);
    draw_selection(painter, rect, selected);
}

fn truncate_clip_title(
    painter: &egui::Painter,
    title: &str,
    font: &FontId,
    max_width: f32,
) -> String {
    if painter
        .layout_no_wrap(title.to_owned(), font.clone(), Color32::WHITE)
        .size()
        .x
        <= max_width
    {
        return title.to_owned();
    }

    let characters = title.chars().collect::<Vec<_>>();
    let mut low = 0;
    let mut high = characters.len();
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = characters[..middle]
            .iter()
            .chain(std::iter::once(&'…'))
            .collect::<String>();
        if painter
            .layout_no_wrap(candidate, font.clone(), Color32::WHITE)
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

fn draw_audio_clip(
    painter: &egui::Painter,
    rect: Rect,
    clip: &SequenceClip,
    waveform: Option<&Waveform>,
    color: ClipColor,
    selected: bool,
    media_bounds: MediaBoundFlags,
) {
    let fill = lighten(clip_color(color));
    painter.rect_filled(rect, CornerRadius::same(3), fill);
    draw_clip_edge_tint(painter, rect, fill);
    if let Some(waveform) = waveform {
        // Premiere-style rectified waveform: a continuous amplitude graph grows
        // upward from a fixed floor, so silence remains an unmistakably flat line.
        // Only sample the visible slice for long, highly-zoomed sequences.
        let visible = rect.intersect(painter.clip_rect());
        let baseline = rect.bottom() - 2.0;
        let graph_height = (rect.height() - 4.0).max(1.0);
        let source_peak = waveform.max_peak().max(f32::EPSILON);
        let columns = (visible.width() / 1.5).ceil().max(1.0) as usize;
        let mut envelope = Vec::with_capacity(columns + 1);
        for index in 0..=columns {
            let x = visible.left() + index as f32 / columns.max(1) as f32 * visible.width();
            let fraction = ((x - rect.left()) / rect.width().max(1.0)).clamp(0.0, 1.0) as f64;
            let source_time = clip.source_in + fraction * (clip.source_out - clip.source_in);
            // Normalize once against the source peak instead of applying a fixed
            // gain that clips mastered music into a solid block. The contrast
            // curve expands the small peak differences common in dense mixes.
            // Clip gain (Properties dB) scales the drawn envelope live.
            let gain = clip.audio.linear_gain();
            let normalized = (waveform.peak_at(source_time) / source_peak * gain).clamp(0.0, 1.0);
            let amplitude = normalized.powf(2.4) * 0.97;
            let top = baseline - amplitude * graph_height;
            envelope.push(Pos2::new(x, top));
            painter.line_segment(
                [Pos2::new(x, baseline), Pos2::new(x, top)],
                Stroke::new(2.0, Color32::from_white_alpha(112)),
            );
        }
        painter.add(egui::Shape::line(
            envelope,
            Stroke::new(1.2, Color32::from_white_alpha(225)),
        ));
        painter.line_segment(
            [
                Pos2::new(visible.left(), baseline),
                Pos2::new(visible.right(), baseline),
            ],
            Stroke::new(1.0, Color32::from_white_alpha(95)),
        );
    } else {
        painter.line_segment(
            [
                Pos2::new(rect.left(), rect.bottom() - 3.0),
                Pos2::new(rect.right(), rect.bottom() - 3.0),
            ],
            Stroke::new(1.0, Color32::from_white_alpha(90)),
        );
    }
    draw_media_bound_markers(painter, rect, media_bounds);
    draw_selection(painter, rect, selected);
}

fn draw_media_bound_markers(painter: &egui::Painter, rect: Rect, bounds: MediaBoundFlags) {
    // Premiere-style corner ticks: visible when the clip edge has reached
    // the start or end of the underlying media.
    if rect.width() < 10.0 || rect.height() < 10.0 {
        return;
    }
    let size = 7.0_f32.min(rect.width() * 0.35).min(rect.height() * 0.45);
    let color = Color32::from_white_alpha(230);
    if bounds.at_start {
        let origin = rect.left_top() + Vec2::new(2.0, 2.0);
        painter.add(egui::Shape::convex_polygon(
            vec![
                origin,
                origin + Vec2::new(size, 0.0),
                origin + Vec2::new(0.0, size),
            ],
            color,
            Stroke::NONE,
        ));
    }
    if bounds.at_end {
        let origin = rect.right_top() + Vec2::new(-2.0, 2.0);
        painter.add(egui::Shape::convex_polygon(
            vec![
                origin,
                origin + Vec2::new(-size, 0.0),
                origin + Vec2::new(0.0, size),
            ],
            color,
            Stroke::NONE,
        ));
    }
}

fn clip_color(color: ClipColor) -> Color32 {
    match color {
        ClipColor::Blue => Color32::from_rgb(20, 112, 214),
        ClipColor::Cyan => Color32::from_rgb(0, 145, 166),
        ClipColor::Green => Color32::from_rgb(32, 137, 82),
        ClipColor::Yellow => Color32::from_rgb(170, 133, 20),
        ClipColor::Orange => Color32::from_rgb(196, 91, 24),
        ClipColor::Red => Color32::from_rgb(183, 49, 57),
        ClipColor::Purple => Color32::from_rgb(126, 71, 186),
        ClipColor::Pink => Color32::from_rgb(184, 58, 129),
    }
}

fn lighten(color: Color32) -> Color32 {
    Color32::from_rgb(
        color.r().saturating_add(26),
        color.g().saturating_add(26),
        color.b().saturating_add(26),
    )
}

fn mix_toward_white(color: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    Color32::from_rgb(
        (color.r() as f32 + (255.0 - color.r() as f32) * t).round() as u8,
        (color.g() as f32 + (255.0 - color.g() as f32) * t).round() as u8,
        (color.b() as f32 + (255.0 - color.b() as f32) * t).round() as u8,
    )
}

fn draw_clip_edge_tint(painter: &egui::Painter, rect: Rect, fill: Color32) {
    // Soft lighter-blue leading edge reinforces the hairline gap between cuts.
    if rect.width() < 4.0 {
        return;
    }
    let edge = Rect::from_min_max(
        Pos2::new(rect.left(), rect.top() + 2.0),
        Pos2::new((rect.left() + 2.0).min(rect.right()), rect.bottom() - 2.0),
    );
    if edge.width() <= 0.0 || edge.height() <= 0.0 {
        return;
    }
    painter.rect_filled(edge, CornerRadius::ZERO, mix_toward_white(fill, 0.55));
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

    use super::{
        playhead_needs_follow, timeline_canvas_width, timeline_is_scrollable,
        timeline_view_duration, trim_handle_rects, TrackKind, TrackLayout, AUDIO_HEIGHT,
        VIDEO_HEIGHT,
    };

    #[test]
    fn fixed_track_layout_uses_premiere_order_and_adds_outer_rows() {
        let core = TrackLayout::new(Rect::from_min_max(pos2(0.0, 0.0), pos2(800.0, 270.0)));
        let labels = core
            .rows
            .iter()
            .map(|row| (row.kind, row.index))
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                (TrackKind::Video, 3),
                (TrackKind::Video, 2),
                (TrackKind::Video, 1),
                (TrackKind::Audio, 1),
                (TrackKind::Audio, 2),
                (TrackKind::Audio, 3),
            ]
        );
        assert!(core
            .rows
            .iter()
            .filter(|row| row.kind == TrackKind::Video)
            .all(|row| row.rect.height() == VIDEO_HEIGHT));
        assert!(core
            .rows
            .iter()
            .filter(|row| row.kind == TrackKind::Audio)
            .all(|row| row.rect.height() == AUDIO_HEIGHT));

        let taller = TrackLayout::new(Rect::from_min_max(pos2(0.0, 0.0), pos2(800.0, 360.0)));
        assert!(taller.row(TrackKind::Video, 4).is_some());
        assert!(taller.row(TrackKind::Audio, 4).is_some());

        let shorter = TrackLayout::new(Rect::from_min_max(pos2(0.0, 0.0), pos2(800.0, 150.0)));
        assert!(shorter.row(TrackKind::Video, 1).is_some());
        assert!(shorter.row(TrackKind::Audio, 1).is_some());
        assert!(shorter.rows.len() < core.rows.len());
    }

    #[test]
    fn timeline_view_stays_fixed_until_content_needs_more_room() {
        assert_eq!(timeline_view_duration(0.0), 30.0);
        assert_eq!(timeline_view_duration(7.0), 30.0);
        assert_eq!(timeline_view_duration(20.0), 30.0);
        // 25s content + 8s runway exceeds the 30s base → extend.
        assert_eq!(timeline_view_duration(25.0), 33.0);
        assert_eq!(timeline_view_duration(40.0), 48.0);
    }

    #[test]
    fn adjacent_trim_handles_occupy_opposite_sides_of_the_cut() {
        let first = Rect::from_min_max(pos2(0.0, 10.0), pos2(100.0, 90.0));
        let second = Rect::from_min_max(pos2(100.0, 10.0), pos2(200.0, 90.0));
        let (_, first_right) = trim_handle_rects(first, first);
        let (second_left, _) = trim_handle_rects(second, second);
        assert!(first_right.contains(pos2(99.0, 50.0)));
        assert!(!second_left.contains(pos2(99.0, 50.0)));
        assert!(second_left.contains(pos2(101.0, 50.0)));
        assert!(!first_right.contains(pos2(101.0, 50.0)));
        assert!(!first_right.contains(pos2(100.0, 50.0)));
        assert!(!second_left.contains(pos2(100.0, 50.0)));
    }

    #[test]
    fn zoom_scales_the_full_timeline_canvas_width() {
        assert_eq!(timeline_canvas_width(800.0, 1.0, 30.0), 800.0);
        assert_eq!(timeline_canvas_width(800.0, 4.0, 30.0), 3_200.0);
        assert_eq!(timeline_canvas_width(800.0, 32.0, 30.0), 25_600.0);
        // Longer sequences widen the canvas at the same zoom (fixed px/s).
        assert_eq!(timeline_canvas_width(800.0, 1.0, 60.0), 1_600.0);
    }

    #[test]
    fn scrollbar_appears_when_canvas_exceeds_viewport() {
        assert!(!timeline_is_scrollable(800.0, 800.0));
        assert!(timeline_is_scrollable(801.5, 800.0));
        assert!(timeline_is_scrollable(1_600.0, 800.0));
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
