use serde::{Deserialize, Deserializer, Serialize};

pub type ClipId = u64;
pub type MediaId = u64;

fn deserialize_selected<'de, D>(deserializer: D) -> Result<Vec<ClipId>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Number(n)) => n.as_u64().into_iter().collect(),
        Some(serde_json::Value::Array(items)) => {
            items.into_iter().filter_map(|item| item.as_u64()).collect()
        }
        _ => Vec::new(),
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EditTool {
    Select,
    Razor,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum ClipColor {
    #[default]
    Blue,
    Cyan,
    Green,
    Yellow,
    Orange,
    Red,
    Purple,
    Pink,
}

impl ClipColor {
    pub const ALL: [Self; 8] = [
        Self::Blue,
        Self::Cyan,
        Self::Green,
        Self::Yellow,
        Self::Orange,
        Self::Red,
        Self::Purple,
        Self::Pink,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Blue => "Blue",
            Self::Cyan => "Cyan",
            Self::Green => "Green",
            Self::Yellow => "Yellow",
            Self::Orange => "Orange",
            Self::Red => "Red",
            Self::Purple => "Purple",
            Self::Pink => "Pink",
        }
    }
}

fn legacy_media_id() -> MediaId {
    1
}

fn default_track() -> u8 {
    1
}

/// Which timeline lane(s) a clip occupies.
/// Linked clips use [`ClipLane::Both`]; Unlink splits them into Video + Audio.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipLane {
    #[default]
    Both,
    Video,
    Audio,
}

impl ClipLane {
    pub fn shows_video(self) -> bool {
        matches!(self, Self::Both | Self::Video)
    }

    pub fn shows_audio(self) -> bool {
        matches!(self, Self::Both | Self::Audio)
    }

    pub fn conflicts_with(self, other: Self) -> bool {
        (self.shows_video() && other.shows_video()) || (self.shows_audio() && other.shows_audio())
    }
}

fn default_scale() -> f32 {
    100.0
}

/// Motion properties for a clip, Premiere-style (origin at frame center).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct ClipMotion {
    #[serde(default)]
    pub position_x: f32,
    #[serde(default)]
    pub position_y: f32,
    #[serde(default = "default_scale")]
    pub scale: f32,
    #[serde(default)]
    pub rotation: f32,
}

impl Default for ClipMotion {
    fn default() -> Self {
        Self {
            position_x: 0.0,
            position_y: 0.0,
            scale: 100.0,
            rotation: 0.0,
        }
    }
}

/// Audio properties for a clip.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct ClipAudio {
    /// Gain in dB. `0.0` is unity.
    #[serde(default)]
    pub volume_db: f32,
}

impl ClipAudio {
    pub fn linear_gain(self) -> f32 {
        10f32.powf(self.volume_db / 20.0)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SequenceClip {
    pub id: ClipId,
    #[serde(default = "legacy_media_id")]
    pub media_id: MediaId,
    #[serde(default)]
    pub color: ClipColor,
    #[serde(default)]
    pub lane: ClipLane,
    /// One-based Premiere-style track number. Linked clips occupy matching Vn/An.
    #[serde(default = "default_track")]
    pub track: u8,
    pub timeline_start: f64,
    pub timeline_end: f64,
    pub source_in: f64,
    pub source_out: f64,
    #[serde(default)]
    pub motion: ClipMotion,
    #[serde(default)]
    pub audio: ClipAudio,
}

impl SequenceClip {
    pub fn track(&self) -> u8 {
        self.track.max(1)
    }

    pub fn contains(&self, time: f64) -> bool {
        time >= self.timeline_start && time < self.timeline_end
    }

    pub fn source_time(&self, timeline_time: f64) -> f64 {
        self.source_in + (timeline_time - self.timeline_start)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Sequence {
    pub clips: Vec<SequenceClip>,
    pub duration: f64,
    #[serde(default, deserialize_with = "deserialize_selected")]
    pub selected: Vec<ClipId>,
    pub(crate) next_id: ClipId,
}

impl Sequence {
    #[cfg(test)]
    pub fn new(duration: f64) -> Self {
        Self::from_media(1, duration)
    }

    pub fn empty() -> Self {
        Self {
            clips: Vec::new(),
            duration: 0.0,
            selected: Vec::new(),
            next_id: 1,
        }
    }

    #[cfg(test)]
    pub fn from_media(media_id: MediaId, duration: f64) -> Self {
        let duration = duration.max(0.0);
        Self {
            clips: vec![SequenceClip {
                id: 1,
                media_id,
                color: ClipColor::default(),
                lane: ClipLane::Both,
                track: 1,
                timeline_start: 0.0,
                timeline_end: duration,
                source_in: 0.0,
                source_out: duration,
                motion: ClipMotion::default(),
                audio: ClipAudio::default(),
            }],
            duration,
            selected: Vec::new(),
            next_id: 2,
        }
    }

    /// Returns the clip that supplies picture at `time`.
    /// Audio-only clips deliberately do not qualify.
    pub fn clip_at(&self, time: f64) -> Option<&SequenceClip> {
        self.clips
            .iter()
            .filter(|clip| clip.contains(time) && clip.lane.shows_video())
            .max_by_key(|clip| clip.track())
    }

    pub fn clip(&self, id: ClipId) -> Option<&SequenceClip> {
        self.clips.iter().find(|clip| clip.id == id)
    }

    pub fn source_time_at(&self, time: f64) -> Option<f64> {
        self.clip_at(time).map(|clip| clip.source_time(time))
    }

    pub fn media_source_at(&self, time: f64) -> Option<(MediaId, f64)> {
        self.clip_at(time)
            .map(|clip| (clip.media_id, clip.source_time(time)))
    }

    pub fn insert_media(
        &mut self,
        media_id: MediaId,
        requested_start: f64,
        source_duration: f64,
        fps: f64,
        snap_threshold: f64,
    ) -> Option<ClipId> {
        let clip_duration = snap_to_frame(source_duration.max(frame_duration(fps)), fps);
        let start = self.snapped_start(
            None,
            requested_start.max(0.0),
            clip_duration,
            fps,
            snap_threshold,
        );
        let track = self.free_track_for(start, start + clip_duration, ClipLane::Both)?;
        let id = self.next_id;
        self.next_id += 1;
        self.clips.push(SequenceClip {
            id,
            media_id,
            color: ClipColor::default(),
            lane: ClipLane::Both,
            track,
            timeline_start: start,
            timeline_end: start + clip_duration,
            source_in: 0.0,
            source_out: clip_duration,
            motion: ClipMotion::default(),
            audio: ClipAudio::default(),
        });
        self.sort_clips();
        self.recompute_duration();
        self.selected = vec![id];
        Some(id)
    }

    /// Lowest 1-based track that can hold `lane` for `[start, end)` without overlap.
    pub fn free_track_for(&self, start: f64, end: f64, lane: ClipLane) -> Option<u8> {
        const MAX_TRACK: u8 = 32;
        (1..=MAX_TRACK).find(|&track| !self.overlaps_on_track(None, start, end, lane, track))
    }

    /// Split a linked AV clip into independent video and audio clips.
    pub fn unlink(&mut self, id: ClipId) -> Option<ClipId> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        if self.clips[index].lane != ClipLane::Both {
            return None;
        }
        self.clips[index].lane = ClipLane::Video;
        let video = self.clips[index].clone();
        let audio_id = self.next_id;
        self.next_id += 1;
        self.clips.insert(
            index + 1,
            SequenceClip {
                id: audio_id,
                media_id: video.media_id,
                color: video.color,
                lane: ClipLane::Audio,
                track: video.track(),
                timeline_start: video.timeline_start,
                timeline_end: video.timeline_end,
                source_in: video.source_in,
                source_out: video.source_out,
                motion: ClipMotion::default(),
                audio: video.audio,
            },
        );
        self.selected = vec![id];
        Some(audio_id)
    }

    /// Whether the current selection contains at least one losslessly linkable
    /// video/audio pair.
    pub fn can_link_selected(&self) -> bool {
        !self.selected_link_pairs().is_empty()
    }

    /// Merge every losslessly matched selected Video + Audio pair back into a
    /// single linked AV clip. Pairs must share media, track, timeline range,
    /// and source range so linking never changes either component's timing.
    ///
    /// The video clip keeps its id, motion, and label; audio settings are taken
    /// from the matched audio clip. Unmatched selected clips stay selected.
    pub fn link_selected(&mut self) -> Vec<ClipId> {
        let pairs = self.selected_link_pairs();
        if pairs.is_empty() {
            return Vec::new();
        }

        let mut audio_ids = Vec::with_capacity(pairs.len());
        let mut linked_ids = Vec::with_capacity(pairs.len());
        for (video_id, audio_id) in pairs {
            let Some(audio) = self.clip(audio_id).cloned() else {
                continue;
            };
            let Some(video) = self.clips.iter_mut().find(|clip| clip.id == video_id) else {
                continue;
            };
            video.lane = ClipLane::Both;
            video.audio = audio.audio;
            audio_ids.push(audio_id);
            linked_ids.push(video_id);
        }

        self.clips.retain(|clip| !audio_ids.contains(&clip.id));
        self.selected.retain(|id| !audio_ids.contains(id));
        linked_ids
    }

    fn selected_link_pairs(&self) -> Vec<(ClipId, ClipId)> {
        let videos = self
            .clips
            .iter()
            .filter(|clip| clip.lane == ClipLane::Video && self.selected.contains(&clip.id));
        let audios = self
            .clips
            .iter()
            .filter(|clip| clip.lane == ClipLane::Audio && self.selected.contains(&clip.id))
            .collect::<Vec<_>>();
        let mut used_audio = Vec::new();
        let mut pairs = Vec::new();

        for video in videos {
            if let Some(audio) = audios
                .iter()
                .copied()
                .find(|audio| !used_audio.contains(&audio.id) && clips_are_linkable(video, audio))
            {
                used_audio.push(audio.id);
                pairs.push((video.id, audio.id));
            }
        }
        pairs
    }

    pub fn preview_media_placement(
        &self,
        requested_start: f64,
        source_duration: f64,
        fps: f64,
        snap_threshold: f64,
    ) -> (f64, bool) {
        let duration = snap_to_frame(source_duration.max(frame_duration(fps)), fps);
        let start = self.snapped_start(
            None,
            requested_start.max(0.0),
            duration,
            fps,
            snap_threshold,
        );
        (
            start,
            self.free_track_for(start, start + duration, ClipLane::Both)
                .is_some(),
        )
    }

    pub fn duplicate(&mut self, id: ClipId) -> Option<ClipId> {
        let mut clip = self.clip(id)?.clone();
        clip.id = self.next_id;
        self.next_id += 1;
        let duplicated = clip.id;
        self.clips.push(clip);
        self.selected = vec![duplicated];
        Some(duplicated)
    }

    pub fn move_clip(
        &mut self,
        id: ClipId,
        requested_start: f64,
        fps: f64,
        snap_threshold: f64,
    ) -> Option<f64> {
        let track = self.clip(id)?.track();
        self.move_clip_to_track(id, requested_start, track, fps, snap_threshold)
    }

    pub fn move_clip_to_track(
        &mut self,
        id: ClipId,
        requested_start: f64,
        track: u8,
        fps: f64,
        snap_threshold: f64,
    ) -> Option<f64> {
        let clip = self.clip(id)?.clone();
        let track = track.max(1);
        let duration = clip.timeline_end - clip.timeline_start;
        let start = self.snapped_start(
            Some(id),
            requested_start.max(0.0),
            duration,
            fps,
            snap_threshold,
        );
        if self.overlaps_on_track(Some(id), start, start + duration, clip.lane, track) {
            return None;
        }
        let clip = self.clips.iter_mut().find(|clip| clip.id == id)?;
        clip.timeline_start = start;
        clip.timeline_end = start + duration;
        clip.track = track;
        self.sort_clips();
        self.recompute_duration();
        Some(start)
    }

    pub fn set_color(&mut self, id: ClipId, color: ClipColor) -> bool {
        let Some(clip) = self.clips.iter_mut().find(|clip| clip.id == id) else {
            return false;
        };
        if clip.color == color {
            return false;
        }
        clip.color = color;
        true
    }

    /// Apply a label color to the whole selection when `id` is selected,
    /// otherwise apply it only to `id`.
    pub fn set_color_for_selection(&mut self, id: ClipId, color: ClipColor) -> bool {
        let ids = if self.is_selected(id) {
            self.selected.clone()
        } else {
            vec![id]
        };
        let mut changed = false;
        for id in ids {
            changed |= self.set_color(id, color);
        }
        changed
    }

    fn snapped_start(
        &self,
        moving: Option<ClipId>,
        requested_start: f64,
        duration: f64,
        fps: f64,
        threshold: f64,
    ) -> f64 {
        let requested_start = snap_to_frame(requested_start, fps).max(0.0);
        let requested_end = requested_start + duration;
        let mut best = (requested_start, threshold.max(0.0) + f64::EPSILON);
        for edge in std::iter::once(0.0).chain(
            self.clips
                .iter()
                .filter(|clip| Some(clip.id) != moving)
                .flat_map(|clip| [clip.timeline_start, clip.timeline_end]),
        ) {
            for (candidate, distance) in [
                (edge, (edge - requested_start).abs()),
                (edge - duration, (edge - requested_end).abs()),
            ] {
                if candidate >= 0.0 && distance <= best.1 {
                    best = (candidate, distance);
                }
            }
        }
        snap_to_frame(best.0.max(0.0), fps)
    }

    fn overlaps_on_track(
        &self,
        excluded: Option<ClipId>,
        start: f64,
        end: f64,
        lane: ClipLane,
        track: u8,
    ) -> bool {
        self.clips.iter().any(|clip| {
            Some(clip.id) != excluded
                && lane.conflicts_with(clip.lane)
                && clip.track() == track.max(1)
                && start < clip.timeline_end - 0.000_001
                && end > clip.timeline_start + 0.000_001
        })
    }

    pub fn has_overlaps(&self) -> bool {
        for (index, left) in self.clips.iter().enumerate() {
            for right in &self.clips[index + 1..] {
                if left.lane.conflicts_with(right.lane)
                    && left.track() == right.track()
                    && left.timeline_start < right.timeline_end - 0.000_001
                    && left.timeline_end > right.timeline_start + 0.000_001
                {
                    return true;
                }
            }
        }
        false
    }

    fn sort_clips(&mut self) {
        self.clips.sort_by(|left, right| {
            left.timeline_start
                .partial_cmp(&right.timeline_start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    pub(crate) fn recompute_duration(&mut self) {
        self.duration = self
            .clips
            .iter()
            .map(|clip| clip.timeline_end)
            .fold(0.0, f64::max);
    }

    pub fn split_at(&mut self, time: f64, fps: f64) -> Option<ClipId> {
        let time = snap_to_frame(time, fps).clamp(0.0, self.duration);
        let min_duration = frame_duration(fps);
        let index = self.clips.iter().position(|clip| {
            time >= clip.timeline_start + min_duration && time <= clip.timeline_end - min_duration
        })?;
        let clip = &mut self.clips[index];
        let source_split = clip.source_time(time);
        let right = SequenceClip {
            id: self.next_id,
            media_id: clip.media_id,
            color: clip.color,
            lane: clip.lane,
            track: clip.track(),
            timeline_start: time,
            timeline_end: clip.timeline_end,
            source_in: source_split,
            source_out: clip.source_out,
            motion: clip.motion,
            audio: clip.audio,
        };
        self.next_id += 1;
        clip.timeline_end = time;
        clip.source_out = source_split;
        let right_id = right.id;
        self.clips.insert(index + 1, right);
        self.selected = vec![right_id];
        Some(right_id)
    }

    pub fn delete_selected(&mut self) -> bool {
        if self.selected.is_empty() {
            return false;
        }
        let selected = std::mem::take(&mut self.selected);
        let before = self.clips.len();
        self.clips.retain(|clip| !selected.contains(&clip.id));
        self.recompute_duration();
        before != self.clips.len()
    }

    pub fn delete(&mut self, id: ClipId) -> bool {
        let before = self.clips.len();
        self.clips.retain(|clip| clip.id != id);
        self.selected.retain(|selected| *selected != id);
        self.recompute_duration();
        before != self.clips.len()
    }

    pub fn remove_media(&mut self, media_id: MediaId) -> bool {
        let before = self.clips.len();
        self.clips.retain(|clip| clip.media_id != media_id);
        let remaining = self
            .selected
            .iter()
            .copied()
            .filter(|id| self.clips.iter().any(|clip| clip.id == *id))
            .collect();
        self.selected = remaining;
        self.recompute_duration();
        before != self.clips.len()
    }

    pub fn select(&mut self, selected: Option<ClipId>) {
        self.selected = selected
            .filter(|id| self.clip(*id).is_some())
            .into_iter()
            .collect();
    }

    pub fn select_only(&mut self, id: ClipId) {
        self.selected = if self.clip(id).is_some() {
            vec![id]
        } else {
            Vec::new()
        };
    }

    pub fn toggle_select(&mut self, id: ClipId) {
        if self.clip(id).is_none() {
            return;
        }
        if let Some(index) = self.selected.iter().position(|selected| *selected == id) {
            self.selected.remove(index);
        } else {
            self.selected.push(id);
        }
    }

    pub fn select_many(&mut self, ids: impl IntoIterator<Item = ClipId>) {
        self.selected.clear();
        for id in ids {
            if self.clip(id).is_some() && !self.selected.contains(&id) {
                self.selected.push(id);
            }
        }
    }

    pub fn clear_selection(&mut self) {
        self.selected.clear();
    }

    pub fn is_selected(&self, id: ClipId) -> bool {
        self.selected.contains(&id)
    }

    pub fn primary_selected(&self) -> Option<ClipId> {
        self.selected.first().copied()
    }

    pub fn trim_left_snapped(
        &mut self,
        id: ClipId,
        requested: f64,
        fps: f64,
        snap_threshold: f64,
    ) -> Option<f64> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        let clip = &self.clips[index];
        let min_duration = frame_duration(fps);
        let previous_end = self
            .clips
            .iter()
            .filter(|other| {
                other.id != id
                    && other.lane.conflicts_with(clip.lane)
                    && other.track() == clip.track()
            })
            .filter(|other| other.timeline_end <= clip.timeline_start + 0.000_001)
            .map(|other| other.timeline_end)
            .fold(0.0, f64::max);
        let earliest_from_source = clip.timeline_start - clip.source_in;
        let minimum = previous_end.max(earliest_from_source).max(0.0);
        let maximum = clip.timeline_end - min_duration;
        let requested = snap_to_nearby_edge(
            requested,
            self.clips.iter().filter(|other| other.id != id),
            snap_threshold,
        );
        let new_start = snap_to_frame(requested, fps).clamp(minimum, maximum);
        let delta = new_start - clip.timeline_start;
        let clip = &mut self.clips[index];
        clip.timeline_start = new_start;
        clip.source_in += delta;
        Some(new_start)
    }

    pub fn trim_right_snapped(
        &mut self,
        id: ClipId,
        requested: f64,
        fps: f64,
        source_duration: f64,
        snap_threshold: f64,
    ) -> Option<f64> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        let clip = &self.clips[index];
        let min_duration = frame_duration(fps);
        let next_start = self
            .clips
            .iter()
            .filter(|other| {
                other.id != id
                    && other.lane.conflicts_with(clip.lane)
                    && other.track() == clip.track()
            })
            .filter(|other| other.timeline_start >= clip.timeline_end - 0.000_001)
            .map(|other| other.timeline_start)
            .fold(f64::INFINITY, f64::min);
        let latest_from_source = clip.timeline_end + (source_duration - clip.source_out).max(0.0);
        let minimum = clip.timeline_start + min_duration;
        let maximum = next_start.min(latest_from_source);
        let requested = snap_to_nearby_edge(
            requested,
            self.clips.iter().filter(|other| other.id != id),
            snap_threshold,
        );
        let new_end = snap_to_frame(requested, fps).clamp(minimum, maximum);
        let delta = new_end - clip.timeline_end;
        let clip = &mut self.clips[index];
        clip.timeline_end = new_end;
        clip.source_out += delta;
        self.recompute_duration();
        Some(new_end)
    }
}

fn clips_are_linkable(video: &SequenceClip, audio: &SequenceClip) -> bool {
    const EPSILON: f64 = 0.000_001;
    video.lane == ClipLane::Video
        && audio.lane == ClipLane::Audio
        && video.media_id == audio.media_id
        && video.track() == audio.track()
        && (video.timeline_start - audio.timeline_start).abs() <= EPSILON
        && (video.timeline_end - audio.timeline_end).abs() <= EPSILON
        && (video.source_in - audio.source_in).abs() <= EPSILON
        && (video.source_out - audio.source_out).abs() <= EPSILON
}

fn snap_to_nearby_edge<'a>(
    requested: f64,
    clips: impl Iterator<Item = &'a SequenceClip>,
    threshold: f64,
) -> f64 {
    let threshold = threshold.max(0.0);
    let mut best = (requested, threshold + f64::EPSILON);
    for edge in clips.flat_map(|clip| [clip.timeline_start, clip.timeline_end]) {
        let distance = (edge - requested).abs();
        if distance <= best.1 {
            best = (edge, distance);
        }
    }
    best.0
}

pub fn frame_duration(fps: f64) -> f64 {
    1.0 / fps.clamp(1.0, 240.0)
}

pub fn snap_to_frame(time: f64, fps: f64) -> f64 {
    let fps = fps.clamp(1.0, 240.0);
    (time * fps).round() / fps
}

#[cfg(test)]
mod tests {
    use super::{ClipColor, ClipLane, Sequence};

    #[test]
    fn audio_only_clip_does_not_supply_preview_media() {
        let mut sequence = Sequence::from_media(42, 5.0);
        sequence.clips[0].lane = ClipLane::Audio;

        assert!(sequence.clip_at(2.0).is_none());
        assert!(sequence.source_time_at(2.0).is_none());
        assert!(sequence.media_source_at(2.0).is_none());
    }

    #[test]
    fn legacy_clips_default_to_track_one() {
        let sequence = Sequence::from_media(42, 5.0);
        let mut json = serde_json::to_value(&sequence).expect("sequence should serialize");
        json["clips"][0]
            .as_object_mut()
            .expect("clip should be an object")
            .remove("track");

        let loaded: Sequence = serde_json::from_value(json).expect("legacy sequence should load");
        assert_eq!(loaded.clips[0].track(), 1);
    }

    #[test]
    fn overlaps_are_scoped_to_matching_tracks() {
        let mut sequence = Sequence::from_media(1, 2.0);
        let duplicate = sequence.duplicate(1).expect("duplicate should be created");
        assert!(sequence.has_overlaps());

        sequence
            .move_clip_to_track(duplicate, 0.0, 2, 30.0, 0.0)
            .expect("same-time placement on another track should succeed");
        assert!(!sequence.has_overlaps());
        assert_eq!(sequence.clip(duplicate).unwrap().track(), 2);
        assert_eq!(sequence.clip_at(1.0).unwrap().id, duplicate);
    }

    #[test]
    fn unlink_preserves_matching_video_and_audio_track_numbers() {
        let mut sequence = Sequence::from_media(1, 2.0);
        sequence.clips[0].track = 3;
        let audio = sequence.unlink(1).expect("linked clip should unlink");

        assert_eq!(sequence.clip(1).unwrap().lane, ClipLane::Video);
        assert_eq!(sequence.clip(1).unwrap().track(), 3);
        assert_eq!(sequence.clip(audio).unwrap().lane, ClipLane::Audio);
        assert_eq!(sequence.clip(audio).unwrap().track(), 3);
    }

    #[test]
    fn link_selected_rejoins_every_matching_unlinked_pair() {
        let mut sequence = Sequence::from_media(1, 2.0);
        let second_video = sequence.duplicate(1).expect("duplicate should be created");
        sequence
            .move_clip(second_video, 2.0, 30.0, 0.0)
            .expect("duplicate should move after the original");
        let first_audio = sequence.unlink(1).expect("first clip should unlink");
        let second_audio = sequence
            .unlink(second_video)
            .expect("second clip should unlink");
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == first_audio)
            .unwrap()
            .audio
            .volume_db = -3.0;
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == second_audio)
            .unwrap()
            .audio
            .volume_db = -6.0;
        sequence.select_many([1, first_audio, second_video, second_audio]);

        assert!(sequence.can_link_selected());
        assert_eq!(sequence.link_selected(), vec![1, second_video]);
        assert_eq!(sequence.clips.len(), 2);
        assert_eq!(sequence.clip(1).unwrap().lane, ClipLane::Both);
        assert_eq!(sequence.clip(1).unwrap().audio.volume_db, -3.0);
        assert_eq!(sequence.clip(second_video).unwrap().lane, ClipLane::Both);
        assert_eq!(sequence.clip(second_video).unwrap().audio.volume_db, -6.0);
        assert_eq!(sequence.selected, vec![1, second_video]);
    }

    #[test]
    fn link_selected_refuses_timing_mismatches() {
        let mut sequence = Sequence::from_media(1, 2.0);
        let audio = sequence.unlink(1).expect("clip should unlink");
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == audio)
            .unwrap()
            .timeline_start = 0.25;
        sequence.select_many([1, audio]);

        assert!(!sequence.can_link_selected());
        assert!(sequence.link_selected().is_empty());
        assert_eq!(sequence.clip(1).unwrap().lane, ClipLane::Video);
        assert_eq!(sequence.clip(audio).unwrap().lane, ClipLane::Audio);
    }

    #[test]
    fn trim_edge_snap_engages_and_releases_past_threshold() {
        let mut sequence = Sequence::from_media(1, 2.0);
        let other = sequence.duplicate(1).expect("duplicate should be created");
        sequence
            .move_clip_to_track(other, 3.0, 2, 30.0, 0.0)
            .expect("other-track clip should move");

        let snapped = sequence
            .trim_right_snapped(1, 2.94, 30.0, 10.0, 0.1)
            .expect("trim should succeed");
        assert_eq!(snapped, 3.0);

        let released = sequence
            .trim_right_snapped(1, 3.2, 30.0, 10.0, 0.1)
            .expect("trim should continue after leaving snap range");
        assert_eq!(released, 3.2);
    }

    #[test]
    fn inserts_multiple_media_and_snaps_clip_edges() {
        let mut sequence = Sequence::empty();
        let first = sequence
            .insert_media(10, 0.0, 2.0, 30.0, 0.1)
            .expect("first media should insert");
        let second = sequence
            .insert_media(20, 2.06, 1.0, 30.0, 0.1)
            .expect("second media should snap after the first");
        assert_eq!(sequence.clip(first).unwrap().media_id, 10);
        assert_eq!(sequence.clip(second).unwrap().timeline_start, 2.0);
        assert_eq!(sequence.clip(second).unwrap().media_id, 20);
        // Overlapping V1/A1 still places validly on the next free track.
        let (overlap_start, overlap_valid) = sequence.preview_media_placement(0.5, 1.0, 30.0, 0.05);
        assert_eq!(overlap_start, 0.5);
        assert!(overlap_valid);
        assert_eq!(sequence.free_track_for(0.5, 1.5, ClipLane::Both), Some(2));
        let (snapped_start, snapped_valid) =
            sequence.preview_media_placement(3.04, 1.0, 30.0, 0.05);
        assert_eq!(snapped_start, 3.0);
        assert!(snapped_valid);
    }

    #[test]
    fn duplicates_moves_and_relabels_a_clip() {
        let mut sequence = Sequence::empty();
        let original = sequence.insert_media(4, 0.0, 1.0, 30.0, 0.0).unwrap();
        let duplicate = sequence.duplicate(original).unwrap();
        assert!(sequence.has_overlaps());
        sequence.move_clip(duplicate, 1.03, 30.0, 0.05).unwrap();
        assert!(!sequence.has_overlaps());
        assert_eq!(sequence.clip(duplicate).unwrap().timeline_start, 1.0);
        assert!(sequence.set_color(duplicate, ClipColor::Purple));
        assert_eq!(sequence.clip(duplicate).unwrap().color, ClipColor::Purple);
    }

    #[test]
    fn label_color_applies_to_every_selected_clip() {
        let mut sequence = Sequence::empty();
        let first = sequence.insert_media(4, 0.0, 1.0, 30.0, 0.0).unwrap();
        let second = sequence.duplicate(first).unwrap();
        sequence.move_clip(second, 1.0, 30.0, 0.0).unwrap();
        let third = sequence.duplicate(second).unwrap();
        sequence.move_clip(third, 2.0, 30.0, 0.0).unwrap();
        sequence.select_many([first, third]);

        assert!(sequence.set_color_for_selection(first, ClipColor::Purple));
        assert_eq!(sequence.clip(first).unwrap().color, ClipColor::Purple);
        assert_eq!(sequence.clip(second).unwrap().color, ClipColor::Blue);
        assert_eq!(sequence.clip(third).unwrap().color, ClipColor::Purple);
    }

    #[test]
    fn duration_always_tracks_the_end_of_the_last_clip() {
        let mut sequence = Sequence::empty();
        let first = sequence.insert_media(1, 0.0, 2.0, 30.0, 0.0).unwrap();
        let second = sequence.insert_media(2, 2.0, 3.0, 30.0, 0.0).unwrap();
        assert_eq!(sequence.duration, 5.0);

        sequence.delete(second);
        assert_eq!(sequence.duration, 2.0);

        sequence.trim_right_snapped(first, 1.0, 30.0, 2.0, 0.0);
        assert_eq!(sequence.duration, 1.0);

        sequence.move_clip(first, 3.0, 30.0, 0.0).unwrap();
        assert_eq!(sequence.duration, 4.0);
    }

    #[test]
    fn splits_at_frames_and_preserves_source_mapping() {
        let mut sequence = Sequence::new(10.0);
        let right = sequence.split_at(4.01, 25.0).expect("clip should split");
        assert_eq!(sequence.clips.len(), 2);
        assert_eq!(sequence.clips[0].timeline_end, 4.0);
        assert_eq!(sequence.clip(right).expect("right clip").source_in, 4.0);
    }

    #[test]
    fn deleting_a_cut_leaves_a_gap_instead_of_rippling() {
        let mut sequence = Sequence::new(10.0);
        let right = sequence.split_at(4.0, 25.0).expect("clip should split");
        sequence
            .split_at(7.0, 25.0)
            .expect("right clip should split");
        sequence.select(Some(right));
        assert!(sequence.delete_selected());
        assert_eq!(sequence.clips.len(), 2);
        assert_eq!(sequence.clips[0].timeline_end, 4.0);
        assert_eq!(sequence.clips[1].timeline_start, 7.0);
        assert!(sequence.clip_at(5.0).is_none());
        assert_eq!(sequence.duration, 10.0);
    }

    #[test]
    fn trimming_changes_source_range_without_moving_other_clips() {
        let mut sequence = Sequence::new(10.0);
        let right = sequence.split_at(4.0, 25.0).expect("clip should split");
        sequence.select(Some(right));
        sequence.delete_selected();

        let left = sequence.clips[0].id;
        sequence.trim_right_snapped(left, 6.0, 25.0, 10.0, 0.0);
        assert_eq!(sequence.clip(left).expect("left clip").timeline_end, 6.0);
        assert_eq!(sequence.clip(left).expect("left clip").source_out, 6.0);
    }
}
