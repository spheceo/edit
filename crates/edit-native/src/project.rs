//! edit-core for the TS server: loading, validating and committing project
//! JSON exactly as the Rust store does (`serde_json::to_vec_pretty`, so files
//! stay byte-identical), ripple edits, sections and keyframe sampling.
//!
//! Projects cross as JSON. `projectCommit` keeps the parsed project per
//! (id, rev) (the last 2 revs of at most 16 projects), so renders, checks
//! and plans can pass `{ ref: { id, rev } }` instead of the whole JSON; a
//! miss is "stale project", and the caller sends `{ json }` instead.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use edit_core::{ClipContent, Keyframe, Project};
use napi_derive::napi;
use parking_lot::Mutex;

/// Projects kept for `ref`s.
const PROJECTS: usize = 16;
/// Revs kept per project.
const REVS: usize = 2;

#[napi(object)]
pub struct ProjectRef {
    pub id: String,
    pub rev: i64,
}

/// `{ ref: { id, rev } }` (a project `projectCommit` saw) or `{ json }`;
/// typed as the header's `ProjectInput` union wherever it's taken.
#[napi(object, js_name = "ProjectArg")]
pub struct ProjectInput {
    #[napi(js_name = "ref")]
    pub reference: Option<ProjectRef>,
    pub json: Option<String>,
}

#[derive(Default)]
struct Kept {
    /// Ids, least recently used first.
    order: VecDeque<String>,
    revs: HashMap<String, VecDeque<(i64, Arc<Project>)>>,
}

static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

fn keep(id: &str, rev: i64, project: Arc<Project>) {
    let mut kept = KEPT.lock();
    let kept = kept.get_or_insert_with(Kept::default);
    kept.order.retain(|other| other != id);
    kept.order.push_back(id.to_owned());
    let revs = kept.revs.entry(id.to_owned()).or_default();
    revs.retain(|(other, _)| *other != rev);
    revs.push_back((rev, project));
    while revs.len() > REVS {
        revs.pop_front();
    }
    while kept.order.len() > PROJECTS {
        if let Some(oldest) = kept.order.pop_front() {
            kept.revs.remove(&oldest);
        }
    }
}

fn kept(id: &str, rev: i64) -> Option<Arc<Project>> {
    let mut kept = KEPT.lock();
    let kept = kept.as_mut()?;
    let found = kept
        .revs
        .get(id)?
        .iter()
        .find(|(other, _)| *other == rev)
        .map(|(_, project)| Arc::clone(project))?;
    kept.order.retain(|other| other != id);
    kept.order.push_back(id.to_owned());
    Some(found)
}

pub(crate) fn parse(json: &str) -> Result<Project, String> {
    match serde_json::from_str(json) {
        Ok(project) => Ok(project),
        // The TS server writes JS's negative zero as `-0` (JSON.stringify would
        // drop the sign the Rust server's f32/f64 math keeps), which serde
        // reads as a float: an integer field refuses it. Then all of them are 0.
        Err(error) => match zero_negative_zeros(json) {
            Some(zeroed) => serde_json::from_str(&zeroed).map_err(|_| error.to_string()),
            None => Err(error.to_string()),
        },
    }
}

/// `json` with each `-0` number (outside strings) written as `0`, if it has any.
fn zero_negative_zeros(json: &str) -> Option<String> {
    let bytes = json.as_bytes();
    let mut out = String::with_capacity(json.len());
    let (mut last, mut at, mut changed) = (0, 0, false);
    while let Some(&byte) = bytes.get(at) {
        match byte {
            b'"' => {
                at += 1;
                while let Some(&inner) = bytes.get(at) {
                    if inner == b'"' {
                        break;
                    }
                    at += if inner == b'\\' { 2 } else { 1 };
                }
                at += 1;
            }
            b'-' if bytes.get(at + 1) == Some(&b'0')
                && !matches!(bytes.get(at + 2), Some(b'0'..=b'9' | b'.' | b'e' | b'E')) =>
            {
                out.push_str(json.get(last..at)?);
                out.push('0');
                at += 2;
                last = at;
                changed = true;
            }
            _ => at += 1,
        }
    }
    if !changed {
        return None;
    }
    out.push_str(json.get(last..)?);
    Some(out)
}

/// The project `input` names.
pub(crate) fn project_of(input: &ProjectInput) -> Result<Arc<Project>, String> {
    match (&input.reference, &input.json) {
        (_, Some(json)) => parse(json).map(Arc::new),
        (Some(reference), None) => {
            kept(&reference.id, reference.rev).ok_or_else(|| "stale project".to_owned())
        }
        (None, None) => Err("a project needs ref or json".to_owned()),
    }
}

fn compact(project: &Project) -> Result<String, String> {
    serde_json::to_string(project).map_err(|error| error.to_string())
}

#[napi(object)]
pub struct Loaded {
    /// The project as serde reads it (defaults filled), compact.
    pub json: String,
    /// Why the file can't be used ("it can't be read: …", "it doesn't
    /// validate: …"); `json` is then the text as given.
    pub problem: Option<String>,
}

/// A project file's text as the store loads it: parsed (serde defaults
/// filled in) and validated.
#[napi]
pub fn project_load(json: String) -> napi::Result<Loaded> {
    crate::sync("loading a project", || {
        let project = match parse(&json) {
            Ok(project) => project,
            Err(error) => {
                return Ok(Loaded {
                    json,
                    problem: Some(format!("it can't be read: {error}")),
                })
            }
        };
        if let Err(error) = project.validate() {
            return Ok(Loaded {
                json,
                problem: Some(format!("it doesn't validate: {error}")),
            });
        }
        Ok(Loaded {
            json: compact(&project)?,
            problem: None,
        })
    })
}

/// Why `json` isn't a valid project (it doesn't parse, or `Project::validate`
/// refuses it), or null.
#[napi]
pub fn project_validate(json: String) -> Option<String> {
    let checked = crate::sync("validating a project", || {
        parse(&json)?.validate()?;
        Ok(())
    });
    checked.err().map(|error| error.reason)
}

#[napi(object)]
pub struct Committed {
    /// The file's bytes, as the Rust store writes them.
    pub pretty: String,
    /// The same project, compact (what to parse back).
    pub json: String,
}

/// Validates `json` as project `id` (its id set to `id`) and serializes it
/// as the store writes it; kept as (`id`, `rev`) for `ref`s, `rev` being the
/// rev it has once saved.
#[napi]
pub fn project_commit(id: String, rev: i64, json: String) -> napi::Result<Committed> {
    crate::sync("committing a project", || {
        let mut project = parse(&json)?;
        project.id.clone_from(&id);
        project.validate()?;
        let pretty = serde_json::to_vec_pretty(&project).map_err(|error| error.to_string())?;
        let pretty = String::from_utf8(pretty).map_err(|error| error.to_string())?;
        let json = compact(&project)?;
        keep(&id, rev, Arc::new(project));
        Ok(Committed { pretty, json })
    })
}

#[napi(object)]
pub struct RippleResult {
    pub json: String,
    #[napi(ts_type = "Rippled")]
    pub rippled: serde_json::Value,
}

fn rippled(project: &Project, rippled: &edit_core::Rippled) -> Result<RippleResult, String> {
    Ok(RippleResult {
        json: compact(project)?,
        rippled: serde_json::to_value(rippled).map_err(|error| error.to_string())?,
    })
}

/// Takes frames `[start, end)` out of the timeline on every track
/// (`edit_core::remove_time`).
#[napi]
pub fn remove_time(
    #[napi(ts_arg_type = "ProjectInput")] project: ProjectInput,
    start: i64,
    end: i64,
) -> napi::Result<RippleResult> {
    crate::sync("removing time", || {
        let mut project = (*project_of(&project)?).clone();
        let done = edit_core::remove_time(&mut project, start, end);
        rippled(&project, &done)
    })
}

/// Plays frames `[start, end)` `speed` times faster, the clips in `hold`
/// keeping their speed (`edit_core::speed_span_holding`).
#[napi]
pub fn speed_span_holding(
    #[napi(ts_arg_type = "ProjectInput")] project: ProjectInput,
    start: i64,
    end: i64,
    speed: f64,
    hold: Vec<String>,
) -> napi::Result<RippleResult> {
    crate::sync("speeding up time", || {
        let mut project = (*project_of(&project)?).clone();
        let hold: HashSet<String> = hold.into_iter().collect();
        let done = edit_core::speed_span_holding(&mut project, start, end, speed, &hold);
        rippled(&project, &done)
    })
}

/// The edit's intro, cut-ins, story and outro (`edit_core::sections`).
#[napi(ts_return_type = "Sections")]
pub fn sections(
    #[napi(ts_arg_type = "ProjectInput")] project: ProjectInput,
) -> napi::Result<serde_json::Value> {
    crate::sync("finding sections", || {
        let project = project_of(&project)?;
        serde_json::to_value(edit_core::sections(&project)).map_err(|error| error.to_string())
    })
}

/// The parameter paths that take keyframes, per clip type ("video", "audio",
/// "text", "adjustment", "solid", "waveform").
#[napi(ts_return_type = "Record<string, string[]>")]
pub fn animatable_params() -> napi::Result<HashMap<String, Vec<String>>> {
    crate::sync("listing animatable params", || {
        let mut out = HashMap::new();
        for (kind, content) in [
            ("video", r#"{"type":"video","media":""}"#),
            ("audio", r#"{"type":"audio","media":""}"#),
            ("text", r#"{"type":"text","text":""}"#),
            ("adjustment", r#"{"type":"adjustment"}"#),
            ("solid", r#"{"type":"solid"}"#),
            ("waveform", r#"{"type":"waveform"}"#),
        ] {
            let parsed: ClipContent =
                serde_json::from_str(content).map_err(|error| error.to_string())?;
            let kind = kind.to_owned();
            let params = edit_core::animatable_params(&parsed)
                .iter()
                .map(|param| (*param).to_owned())
                .collect();
            out.insert(kind, params);
        }
        Ok(out)
    })
}

/// A keyframe track's value at each of `frames` (`edit_core::sample`), for
/// parity tests of the TS port.
#[napi(
    ts_args_type = "keys: Keyframe[], frames: number[]",
    ts_return_type = "(number | null)[]"
)]
pub fn sample_keyframes(
    keys: serde_json::Value,
    frames: Vec<f64>,
) -> napi::Result<Vec<Option<f64>>> {
    crate::sync("sampling keyframes", || {
        let keys: Vec<Keyframe> =
            serde_json::from_value(keys).map_err(|error| error.to_string())?;
        Ok(frames
            .into_iter()
            .map(|frame| edit_core::sample(&keys, frame as f32).map(f64::from))
            .collect())
    })
}
