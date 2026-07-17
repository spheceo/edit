use serde::{Deserialize, Serialize};

pub type ClipId = u64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EditTool {
    Select,
    Razor,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SequenceClip {
    pub id: ClipId,
    pub timeline_start: f64,
    pub timeline_end: f64,
    pub source_in: f64,
    pub source_out: f64,
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
    pub selected: Option<ClipId>,
    pub(crate) next_id: ClipId,
}

impl Sequence {
    pub fn new(duration: f64) -> Self {
        let duration = duration.max(0.0);
        Self {
            clips: vec![SequenceClip {
                id: 1,
                timeline_start: 0.0,
                timeline_end: duration,
                source_in: 0.0,
                source_out: duration,
            }],
            duration,
            selected: None,
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
            timeline_start: time,
            timeline_end: clip.timeline_end,
            source_in: source_split,
            source_out: clip.source_out,
        };
        self.next_id += 1;
        clip.timeline_end = time;
        clip.source_out = source_split;
        let right_id = right.id;
        self.clips.insert(index + 1, right);
        self.selected = Some(right_id);
        Some(right_id)
    }

    pub fn delete_selected(&mut self) -> bool {
        let Some(selected) = self.selected.take() else {
            return false;
        };
        let before = self.clips.len();
        self.clips.retain(|clip| clip.id != selected);
        before != self.clips.len()
    }

    pub fn delete(&mut self, id: ClipId) -> bool {
        let before = self.clips.len();
        self.clips.retain(|clip| clip.id != id);
        if self.selected == Some(id) {
            self.selected = None;
        }
        before != self.clips.len()
    }

    pub fn select(&mut self, selected: Option<ClipId>) {
        self.selected = selected.filter(|id| self.clip(*id).is_some());
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

    pub fn trim_right(&mut self, id: ClipId, requested: f64, fps: f64) -> Option<f64> {
        let index = self.clips.iter().position(|clip| clip.id == id)?;
        let clip = &self.clips[index];
        let min_duration = frame_duration(fps);
        let next_start = self
            .clips
            .get(index + 1)
            .map_or(self.duration, |next| next.timeline_start);
        let latest_from_source = clip.timeline_end + (self.duration - clip.source_out);
        let minimum = clip.timeline_start + min_duration;
        let maximum = next_start.min(latest_from_source).min(self.duration);
        let new_end = snap_to_frame(requested, fps).clamp(minimum, maximum);
        let delta = new_end - clip.timeline_end;
        let clip = &mut self.clips[index];
        clip.timeline_end = new_end;
        clip.source_out += delta;
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
    use super::Sequence;

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
        sequence.trim_right(left, 6.0, 25.0);
        assert_eq!(sequence.clip(left).expect("left clip").timeline_end, 6.0);
        assert_eq!(sequence.clip(left).expect("left clip").source_out, 6.0);
    }
}
