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
        Some(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_u64())
            .collect(),
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

    pub fn clip_at(&self, time: f64) -> Option<&SequenceClip> {
        self.clips.iter().find(|clip| clip.contains(time))
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
        if self.overlaps(None, start, start + clip_duration) {
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.clips.push(SequenceClip {
            id,
            media_id,
            color: ClipColor::default(),
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
        (start, !self.overlaps(None, start, start + duration))
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
        let clip = self.clip(id)?.clone();
        let duration = clip.timeline_end - clip.timeline_start;
        let start = self.snapped_start(
            Some(id),
            requested_start.max(0.0),
            duration,
            fps,
            snap_threshold,
        );
        if self.overlaps(Some(id), start, start + duration) {
            return None;
        }
        let clip = self.clips.iter_mut().find(|clip| clip.id == id)?;
        clip.timeline_start = start;
        clip.timeline_end = start + duration;
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

    fn overlaps(&self, excluded: Option<ClipId>, start: f64, end: f64) -> bool {
        self.clips.iter().any(|clip| {
            Some(clip.id) != excluded
                && start < clip.timeline_end - 0.000_001
                && end > clip.timeline_start + 0.000_001
        })
    }

    pub fn has_overlaps(&self) -> bool {
        self.clips
            .windows(2)
            .any(|pair| pair[0].timeline_end > pair[1].timeline_start + 0.000_001)
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

    pub fn trim_left(&mut self, id: ClipId, requested: f64, fps: f64) -> Option<f64> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        let clip = &self.clips[index];
        let min_duration = frame_duration(fps);
        let previous_end = index
            .checked_sub(1)
            .and_then(|previous| self.clips.get(previous))
            .map_or(0.0, |previous| previous.timeline_end);
        let earliest_from_source = clip.timeline_start - clip.source_in;
        let minimum = previous_end.max(earliest_from_source).max(0.0);
        let maximum = clip.timeline_end - min_duration;
        let new_start = snap_to_frame(requested, fps).clamp(minimum, maximum);
        let delta = new_start - clip.timeline_start;
        let clip = &mut self.clips[index];
        clip.timeline_start = new_start;
        clip.source_in += delta;
        Some(new_start)
    }

    pub fn trim_right(
        &mut self,
        id: ClipId,
        requested: f64,
        fps: f64,
        source_duration: f64,
    ) -> Option<f64> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        let clip = &self.clips[index];
        let min_duration = frame_duration(fps);
        let next_start = self
            .clips
            .get(index + 1)
            .map_or(f64::INFINITY, |next| next.timeline_start);
        let latest_from_source = clip.timeline_end + (source_duration - clip.source_out).max(0.0);
        let minimum = clip.timeline_start + min_duration;
        let maximum = next_start.min(latest_from_source);
        let new_end = snap_to_frame(requested, fps).clamp(minimum, maximum);
        let delta = new_end - clip.timeline_end;
        let clip = &mut self.clips[index];
        clip.timeline_end = new_end;
        clip.source_out += delta;
        self.recompute_duration();
        Some(new_end)
    }
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
    use super::{ClipColor, Sequence};

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
        let (overlap_start, overlap_valid) = sequence.preview_media_placement(0.5, 1.0, 30.0, 0.05);
        assert_eq!(overlap_start, 0.5);
        assert!(!overlap_valid);
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
    fn duration_always_tracks_the_end_of_the_last_clip() {
        let mut sequence = Sequence::empty();
        let first = sequence.insert_media(1, 0.0, 2.0, 30.0, 0.0).unwrap();
        let second = sequence.insert_media(2, 2.0, 3.0, 30.0, 0.0).unwrap();
        assert_eq!(sequence.duration, 5.0);

        sequence.delete(second);
        assert_eq!(sequence.duration, 2.0);

        sequence.trim_right(first, 1.0, 30.0, 2.0);
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
        sequence.trim_right(left, 6.0, 25.0, 10.0);
        assert_eq!(sequence.clip(left).expect("left clip").timeline_end, 6.0);
        assert_eq!(sequence.clip(left).expect("left clip").source_out, 6.0);
    }
}
