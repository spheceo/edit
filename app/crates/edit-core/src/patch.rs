//! Project patches, as the page makes them (apps/web/src/lib/patch.ts): the
//! top-level fields set and removed, and for a list of things with ids the
//! ones put (changed in place, new ones at the end), removed, and the new
//! order when it moved. Edit.app's window and the page's engine both take the
//! edit whole once and then only what changed: a drag on Cops Realize sent
//! its 2.4 MB ten times a second and had it parsed again each time (Nov 8).
//! A patch that changes nothing but clips lands in the parsed project's clips
//! (`patch_clips`), the rest of the edit untouched.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use crate::{Clip, Project};

/// Whether `patch` changes nothing but clips (and the next id handed out).
pub fn only_clips(patch: &Value) -> bool {
    let set_ok = patch
        .get("set")
        .and_then(Value::as_object)
        .is_none_or(|set| set.keys().all(|key| key == "next_id"));
    let unset_ok = patch
        .get("unset")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let lists_ok = patch
        .get("lists")
        .and_then(Value::as_object)
        .is_none_or(|lists| lists.keys().all(|key| key == "clips"));
    set_ok && unset_ok && lists_ok
}

fn strings(change: &Value, field: &str) -> Vec<String> {
    change
        .get(field)
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A clips-only patch (`only_clips`) into the parsed project, as `apply` does
/// to its JSON, and the project checked after. Refused, the project is as it
/// was: a drag passes through states its rules refuse (two clips overlapping
/// for a frame), and the last good picture stays. Only what the patch touched
/// is kept for that (cloning every clip of a 3,000-clip edit for each move of
/// a drag was most of a patch's time).
pub fn patch_clips(project: &mut Project, patch: &Value) -> Result<(), String> {
    let mut undo = Undo::default();
    let patched = patch_clips_in(project, patch, &mut undo).and_then(|()| project.validate());
    if let Err(error) = patched {
        undo.restore(&mut project.clips);
        return Err(error);
    }
    if let Some(next) = patch.pointer("/set/next_id").and_then(Value::as_u64) {
        project.next_id = next;
    }
    Ok(())
}

/// What a clips patch changed, enough to put the clips back as they were.
#[derive(Default)]
struct Undo {
    /// Clips removed, with the index each had (ascending).
    removed: Vec<(usize, Clip)>,
    /// Clips replaced in place, with the index of each.
    replaced: Vec<(usize, Clip)>,
    /// How many clips the patch appended.
    appended: usize,
    /// The ids in their order before the patch reordered them.
    order: Option<Vec<String>>,
}

impl Undo {
    fn restore(self, clips: &mut Vec<Clip>) {
        if let Some(order) = self.order {
            let mut by_id: HashMap<String, Clip> = clips
                .drain(..)
                .map(|clip| (clip.id.clone(), clip))
                .collect();
            *clips = order.iter().filter_map(|id| by_id.remove(id)).collect();
        }
        clips.truncate(clips.len().saturating_sub(self.appended));
        for (index, clip) in self.replaced {
            if let Some(slot) = clips.get_mut(index) {
                *slot = clip;
            }
        }
        for (index, clip) in self.removed {
            clips.insert(index.min(clips.len()), clip);
        }
    }
}

fn patch_clips_in(project: &mut Project, patch: &Value, undo: &mut Undo) -> Result<(), String> {
    let Some(change) = patch.pointer("/lists/clips") else {
        return Ok(());
    };
    let gone: HashSet<String> = strings(change, "remove").into_iter().collect();
    if !gone.is_empty() {
        let mut kept = Vec::with_capacity(project.clips.len());
        for (index, clip) in project.clips.drain(..).enumerate() {
            if gone.contains(&clip.id) {
                undo.removed.push((index, clip));
            } else {
                kept.push(clip);
            }
        }
        project.clips = kept;
    }
    let mut at: HashMap<String, usize> = project
        .clips
        .iter()
        .enumerate()
        .map(|(index, clip)| (clip.id.clone(), index))
        .collect();
    for item in change
        .get("put")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let clip = Clip::deserialize(item).map_err(|error| error.to_string())?;
        match at.get(&clip.id) {
            Some(&index) => {
                if let Some(slot) = project.clips.get_mut(index) {
                    undo.replaced.push((index, std::mem::replace(slot, clip)));
                }
            }
            None => {
                at.insert(clip.id.clone(), project.clips.len());
                project.clips.push(clip);
                undo.appended += 1;
            }
        }
    }
    if change.get("order").is_some() {
        let order = strings(change, "order");
        if order.len() != project.clips.len() || order.iter().any(|one| !at.contains_key(one)) {
            return Err("clips' new order doesn't match its items".to_owned());
        }
        undo.order = Some(project.clips.iter().map(|clip| clip.id.clone()).collect());
        let mut clips: HashMap<String, Clip> = project
            .clips
            .drain(..)
            .map(|clip| (clip.id.clone(), clip))
            .collect();
        project.clips = order.iter().filter_map(|one| clips.remove(one)).collect();
    }
    Ok(())
}

/// `base` with `patch` applied, as the page's lib/patch.ts `apply`.
pub fn apply(base: &mut Value, patch: &Value) -> Result<(), String> {
    let object = base.as_object_mut().ok_or("the project isn't an object")?;
    if let Some(set) = patch.get("set").and_then(Value::as_object) {
        for (key, value) in set {
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(unset) = patch.get("unset").and_then(Value::as_array) {
        for key in unset.iter().filter_map(Value::as_str) {
            object.remove(key);
        }
    }
    let Some(lists) = patch.get("lists").and_then(Value::as_object) else {
        return Ok(());
    };
    let id = |item: &Value| item.get("id").and_then(Value::as_str).map(str::to_owned);
    for (key, change) in lists {
        let list = object
            .entry(key.clone())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("{key} isn't a list of things with ids"))?;
        let gone: HashSet<String> = strings(change, "remove").into_iter().collect();
        list.retain(|item| id(item).is_none_or(|one| !gone.contains(&one)));
        let mut at: HashMap<String, usize> = HashMap::new();
        for (index, item) in list.iter().enumerate() {
            let one = id(item).ok_or_else(|| format!("a {key} item has no id"))?;
            at.insert(one, index);
        }
        for item in change
            .get("put")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let one = id(item).ok_or_else(|| format!("a changed {key} item has no id"))?;
            match at.get(&one) {
                Some(&index) => {
                    if let Some(slot) = list.get_mut(index) {
                        *slot = item.clone();
                    }
                }
                None => {
                    at.insert(one, list.len());
                    list.push(item.clone());
                }
            }
        }
        if change.get("order").is_some() {
            let order = strings(change, "order");
            if order.len() != list.len() || order.iter().any(|one| !at.contains_key(one)) {
                return Err(format!("{key}'s new order doesn't match its items"));
            }
            let mut items: HashMap<String, Value> = list
                .drain(..)
                .filter_map(|item| id(&item).map(|one| (one, item)))
                .collect();
            *list = order.iter().filter_map(|one| items.remove(one)).collect();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_patch_applies_as_the_pages_does() {
        let mut project = json!({
            "name": "a", "next_id": 3, "gone": true,
            "clips": [{"id": "c1", "start": 0}, {"id": "c2", "start": 5}, {"id": "c3", "start": 9}],
        });
        apply(
            &mut project,
            &json!({
                "set": {"name": "b"}, "unset": ["gone"],
                "lists": {"clips": {"put": [{"id": "c2", "start": 6}, {"id": "c4", "start": 1}], "remove": ["c3"]}},
            }),
        )
        .unwrap();
        assert_eq!(
            project,
            json!({"name": "b", "next_id": 3,
                "clips": [{"id": "c1", "start": 0}, {"id": "c2", "start": 6}, {"id": "c4", "start": 1}]})
        );
        apply(
            &mut project,
            &json!({"set": {}, "unset": [], "lists": {"clips": {"put": [], "remove": [], "order": ["c4", "c1", "c2"]}}}),
        )
        .unwrap();
        let ids: Vec<&str> = project["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|clip| clip["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["c4", "c1", "c2"]);
        // An order naming what isn't there doesn't fit.
        assert!(apply(
            &mut project,
            &json!({"set": {}, "unset": [], "lists": {"clips": {"put": [], "remove": [], "order": ["c1"]}}}),
        )
        .is_err());
    }

    fn base() -> Value {
        json!({
            "version": 1, "id": "p", "name": "t", "settings": {"width": 320, "height": 180, "fps": 30},
            "tracks": [{"id": "v", "kind": "video"}],
            "clips": [
                {"id": "a", "track": "v", "type": "solid", "start": 0, "duration": 10, "fill": [1, 0, 0, 1]},
                {"id": "b", "track": "v", "type": "solid", "start": 10, "duration": 10, "fill": [0, 1, 0, 1]},
            ],
        })
    }

    #[test]
    fn a_clips_only_patch_lands_in_the_parsed_project() {
        let change = json!({"set": {"next_id": 9}, "unset": [], "lists": {"clips": {
            "put": [{"id": "b", "track": "v", "type": "solid", "start": 12, "duration": 8, "fill": [0, 1, 0, 1]},
                    {"id": "c", "track": "v", "type": "solid", "start": 30, "duration": 5, "fill": [0, 0, 1, 1]}],
            "remove": ["a"], "order": ["c", "b"]}}});
        assert!(only_clips(&change));
        let mut parsed = Project::deserialize(&base()).unwrap();
        patch_clips(&mut parsed, &change).unwrap();
        assert_eq!(parsed.next_id, 9);
        let mut value = base();
        apply(&mut value, &change).unwrap();
        let whole = Project::deserialize(&value).unwrap();
        assert_eq!(
            serde_json::to_value(&parsed.clips).unwrap(),
            serde_json::to_value(&whole.clips).unwrap()
        );
        assert!(!only_clips(
            &json!({"set": {"name": "x"}, "unset": [], "lists": {}})
        ));
    }

    /// A patch the project's rules refuse (two clips overlapping on a track) leaves it as it was.
    #[test]
    fn a_refused_patch_leaves_the_project_as_it_was() {
        let mut parsed = Project::deserialize(&base()).unwrap();
        let overlap = json!({"set": {}, "unset": [], "lists": {"clips": {
            "put": [{"id": "b", "track": "v", "type": "solid", "start": 5, "duration": 10, "fill": [0, 1, 0, 1]}],
            "remove": []}}});
        assert!(patch_clips(&mut parsed, &overlap).is_err());
        assert_eq!(parsed.clips[1].start, 10);
        assert_eq!(parsed.clips.len(), 2);
        // Removed, replaced, appended and reordered at once, then refused: every clip back where it was.
        let before = serde_json::to_value(&parsed.clips).unwrap();
        let mixed = json!({"set": {}, "unset": [], "lists": {"clips": {
            "put": [{"id": "b", "track": "v", "type": "solid", "start": 12, "duration": 8, "fill": [0, 1, 0, 1]},
                    {"id": "c", "track": "v", "type": "solid", "start": 15, "duration": 5, "fill": [0, 0, 1, 1]}],
            "remove": ["a"], "order": ["c", "b"]}}});
        assert!(patch_clips(&mut parsed, &mixed).is_err());
        assert_eq!(serde_json::to_value(&parsed.clips).unwrap(), before);
    }
}
