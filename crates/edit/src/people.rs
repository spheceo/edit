//! One colour per person across the whole video, by construction.
//!
//! Subtitles take their colours from each file's transcript, and each
//! transcript colours its own voices: the same person came out in three
//! colours across files, and different people in different files shared one
//! (an edit had "Officer:" in four teals, and one orange on a child, a
//! neighbour, a sister and a social worker). The agent was asked to reconcile
//! them by hand and didn't reliably. So after anything that places or
//! relabels people's words (add_subtitles, caption_speakers, update_clips,
//! a plan), `one_colour_per_person` gives every person (a subtitle label:
//! "Officer:", "Tabitha:") one colour everywhere: their subtitles' labels,
//! their intro captions and their quotes; no two people share a colour or a
//! near shade while the palette lasts. A person keeps the colour they have
//! when it still stands apart (re-runs, and a colour chosen on purpose, stay
//! put); the agent's part is only who is who (one label per person).

use std::collections::{BTreeMap, HashMap};

use edit_core::{ClipContent, Project, Rgba};
use serde_json::{json, Value};

/// The house palette for people, light enough to read on black, each at
/// least ~30 ΔE from every other. The first six are the editors' role
/// colours (officer teal, leader blue, suspect yellow, victim and family
/// orange, medic and social worker magenta, bystander sage); the rest were
/// picked farthest-first, so the first ones used are the most different.
/// Never white: a white label reads as nobody's (the subtitle's words are
/// white).
pub const PALETTE: [&str; 20] = [
    "#00e5c7", "#0090e5", "#ffff00", "#e57e00", "#f33bff", "#66aa66", "#ff6694", "#1aff47",
    "#c7ff8f", "#f0b2ff", "#ffb08f", "#3dd8ff", "#e7ca55", "#3dff9e", "#b1ff3d", "#ff66d1",
    "#fff0b2", "#b2c9ff", "#9a8fff", "#ff7566",
];

/// How far apart (CIE76 ΔE) two people's colours must be: two teals or two
/// lavenders 20 apart still read as one person on a 26 px label.
pub const APART: f64 = 28.0;

/// Clip names that mark words said by a person, so they take that person's colour.
const SUBTITLE_PREFIX: &str = "Subtitle · ";
/// A quote or claim list of someone's words: "Quote · Tabitha".
pub const QUOTE_PREFIX: &str = "Quote · ";

/// The palette colour a role starts from.
fn role_colour(role: &str) -> Option<&'static str> {
    Some(match role {
        "officer" => PALETTE[0],
        "leader" => PALETTE[1],
        "suspect" => PALETTE[2],
        "victim" | "witness" => PALETTE[3],
        "medic" => PALETTE[4],
        "bystander" => PALETTE[5],
        _ => return None,
    })
}

/// "Officer:" → "officer": who a label is, whatever its case or colon.
fn person_key(label: &str) -> String {
    label.trim().trim_end_matches(':').trim().to_lowercase()
}

fn to_hex(color: Rgba) -> String {
    let [r, g, b, _] = color.0;
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

fn from_hex(hex: &str, alpha: f32) -> Rgba {
    let mut color = crate::captions::hex(hex).unwrap_or(Rgba::WHITE);
    color.0[3] = alpha;
    color
}

/// Everything known about one person on screen.
#[derive(Default)]
struct Person {
    /// The label as shown ("Officer:"), the most used spelling.
    shown: BTreeMap<String, usize>,
    /// Lines (subtitles and captions).
    lines: usize,
    /// Their colours now, by how many lines use each.
    colours: BTreeMap<String, usize>,
    /// The transcript names their lines came from ("Tabitha (Mother)").
    names: BTreeMap<String, usize>,
    /// When they're on screen (frames).
    spans: Vec<(i64, i64)>,
}

/// What a clip says of whose words it is.
enum Words {
    /// A subtitle: its person and the transcript name it came from.
    Subtitle(String, Option<String>),
    /// An intro caption, by the transcript name of its speaker.
    Caption(String),
    /// A quote or claim list, named for its person.
    Quote(String),
}

fn words_of(clip: &edit_core::Clip) -> Option<Words> {
    let ClipContent::Text { style, .. } = &clip.content else {
        return None;
    };
    let name = clip.name.as_deref().unwrap_or_default();
    if let Some(label) = &style.label {
        let from = name.strip_prefix(SUBTITLE_PREFIX).map(str::to_owned);
        return Some(Words::Subtitle(person_key(&label.text), from));
    }
    if let Some(who) = name.strip_prefix(crate::captions::CAPTION_PREFIX) {
        return Some(Words::Caption(who.trim().to_owned()));
    }
    name.strip_prefix(QUOTE_PREFIX)
        .map(|who| Words::Quote(person_key(who)))
        .filter(|words| matches!(words, Words::Quote(key) if !key.is_empty()))
}

/// The most used key of a tally.
fn most(tally: &BTreeMap<String, usize>) -> Option<&String> {
    tally
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(key, _)| key)
}

/// The person an intro caption's speaker is: the label their subtitles carry
/// (the same transcript name), else their first name or role.
fn caption_person(who: &str, subtitled: &HashMap<String, BTreeMap<String, usize>>) -> String {
    subtitled
        .get(who)
        .and_then(most)
        .cloned()
        .unwrap_or_else(|| person_key(crate::captions::subtitle_name(who)))
}

/// Gives every person one colour across the video (see the module notes).
/// Returns each person with their colour and how many clips changed. A
/// subtitled (Repack-style) video's subtitles carry no labels, so it has
/// nobody here and is left alone.
pub fn one_colour_per_person(project: &mut Project) -> Value {
    // Which person each transcript name's subtitles are under.
    let mut subtitled: HashMap<String, BTreeMap<String, usize>> = HashMap::new();
    for clip in &project.clips {
        if let Some(Words::Subtitle(key, Some(from))) = words_of(clip) {
            *subtitled.entry(from).or_default().entry(key).or_default() += 1;
        }
    }
    let mut people: BTreeMap<String, Person> = BTreeMap::new();
    for clip in &project.clips {
        let ClipContent::Text { style, .. } = &clip.content else {
            continue;
        };
        let (key, colour, from) = match words_of(clip) {
            Some(Words::Subtitle(key, from)) => (
                key,
                style
                    .label
                    .as_ref()
                    .map_or(style.color, |label| label.color),
                from,
            ),
            Some(Words::Caption(who)) => (caption_person(&who, &subtitled), style.color, Some(who)),
            Some(Words::Quote(_)) | None => continue,
        };
        if key.is_empty() {
            continue;
        }
        let person = people.entry(key).or_default();
        if let Some(label) = &style.label {
            *person.shown.entry(label.text.clone()).or_default() += 1;
        }
        person.lines += 1;
        *person.colours.entry(to_hex(colour)).or_default() += 1;
        if let Some(from) = from {
            *person.names.entry(from).or_default() += 1;
        }
        person.spans.push((clip.start, clip.end()));
    }
    if people.is_empty() {
        return json!([]);
    }
    let colours = assign(&people);
    // Every line of theirs in it.
    let mut changed: BTreeMap<String, usize> = BTreeMap::new();
    for clip in &mut project.clips {
        let words = words_of(clip);
        let ClipContent::Text { style, .. } = &mut clip.content else {
            continue;
        };
        let (key, on_label) = match words {
            Some(Words::Subtitle(key, _)) => (key, true),
            Some(Words::Caption(who)) => (caption_person(&who, &subtitled), false),
            Some(Words::Quote(key)) => (key, false),
            None => continue,
        };
        let Some(hex) = colours.get(&key) else {
            continue;
        };
        let target = if on_label {
            style.label.as_mut().map(|label| &mut label.color)
        } else {
            Some(&mut style.color)
        };
        if let Some(colour) = target {
            if to_hex(*colour) != *hex {
                *colour = from_hex(hex, colour.0[3]);
                *changed.entry(key).or_default() += 1;
            }
        }
    }
    let mut order: Vec<(&String, &Person)> = people.iter().collect();
    order.sort_by(|a, b| b.1.lines.cmp(&a.1.lines).then(a.0.cmp(b.0)));
    json!(order
        .into_iter()
        .map(|(key, person)| {
            let label = most(&person.shown).cloned().unwrap_or_else(|| key.clone());
            let merged = merged_into(key, person);
            let mut entry = json!({"label": label, "colour": colours.get(key), "lines": person.lines,
                "recoloured": changed.get(key).copied().unwrap_or(0)});
            if !merged.is_empty() {
                if let Some(entry) = entry.as_object_mut() {
                    entry.insert("other_voices_under_this_label".into(), json!(merged));
                }
            }
            entry
        })
        .collect::<Vec<_>>())
}

/// The role a person's names point to ("Tabitha (Mother)" → witness), for
/// the colour they start from.
fn role_of(key: &str, person: &Person) -> &'static str {
    let mut roles: BTreeMap<&'static str, usize> = BTreeMap::new();
    for (name, count) in &person.names {
        let role = crate::speakers::role_from_label(name);
        if role != "other" {
            *roles.entry(role).or_default() += count;
        }
    }
    roles
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)))
        .map(|(role, _)| role)
        .unwrap_or_else(|| crate::speakers::role_from_label(key))
}

/// Colours for `people`, most lines first: each keeps the colour most of
/// their lines have while it stands APART from every colour taken (and,
/// for an officer, leader or dispatch, isn't pink: `speakers::allowed`), else
/// takes their role's, else the palette's next that stands apart. Past
/// the palette, someone (the fewest lines come last) shares the colour of
/// whoever is on screen furthest away in time from them.
fn assign(people: &BTreeMap<String, Person>) -> BTreeMap<String, String> {
    let mut order: Vec<(&String, &Person)> = people.iter().collect();
    order.sort_by(|a, b| b.1.lines.cmp(&a.1.lines).then(a.0.cmp(b.0)));
    let mut taken: Vec<(String, &Person)> = Vec::new();
    let mut out = BTreeMap::new();
    for (key, person) in order {
        let role = role_of(key, person);
        // Apart from everyone's, and never pink for an official.
        let free = |colour: &str| {
            crate::speakers::allowed(role, colour)
                && taken
                    .iter()
                    .all(|(other, _)| crate::speakers::apart(colour, other) >= APART)
        };
        let mut own: Vec<(&String, &usize)> = person.colours.iter().collect();
        own.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let kept = own
            .first()
            .map(|(colour, _)| colour.as_str())
            .filter(|colour| free(colour) && !whitish(colour));
        let colour = kept
            .or_else(|| role_colour(role).filter(|colour| free(colour)))
            .or_else(|| PALETTE.iter().copied().find(|colour| free(colour)))
            .map(str::to_owned)
            .unwrap_or_else(|| furthest_in_time(person, &taken));
        taken.push((colour.clone(), person));
        out.insert(key.clone(), colour);
    }
    out
}

/// The transcript voices under `key`'s label that are by their names someone
/// else ("Kevin (Father)" or "Sister 3" under "Tabitha:"; a bare role like
/// "Mother" or "Officer" may be anyone): never merged silently, the report
/// lists them so the agent confirms who is who.
fn merged_into(key: &str, person: &Person) -> Vec<String> {
    person
        .names
        .keys()
        .filter(|name| {
            let named = name.contains(" (") || name.chars().any(|ch| ch.is_ascii_digit());
            named && person_key(crate::captions::subtitle_name(name)) != key
        })
        .cloned()
        .collect()
}

/// White or a near-white grey: never a person's colour (their words are white).
fn whitish(hex: &str) -> bool {
    let [l, a, b] = crate::speakers::lab(hex);
    l > 85.0 && (a * a + b * b).sqrt() < 15.0
}

/// More people than colours: the palette colour whose people are on screen
/// furthest (in time) from `person`, so a shared colour is never seen twice
/// in the same scene.
fn furthest_in_time(person: &Person, taken: &[(String, &Person)]) -> String {
    let gap = |a: &[(i64, i64)], b: &[(i64, i64)]| -> i64 {
        a.iter()
            .flat_map(|(s1, e1)| b.iter().map(move |(s2, e2)| (s2 - e1).max(s1 - e2).max(0)))
            .min()
            .unwrap_or(i64::MAX)
    };
    PALETTE
        .iter()
        .map(|colour| {
            let holders: Vec<&Person> = taken
                .iter()
                .filter(|(own, _)| own == colour)
                .map(|(_, holder)| *holder)
                .collect();
            let nearest = holders
                .iter()
                .map(|holder| gap(&person.spans, &holder.spans))
                .min()
                .unwrap_or(i64::MAX);
            let lines: usize = holders.iter().map(|holder| holder.lines).sum();
            (colour, nearest, lines)
        })
        .max_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)))
        .map_or_else(
            || PALETTE[0].to_owned(),
            |(colour, ..)| (*colour).to_owned(),
        )
}

/// Each person's line count, colour and the transcript names their lines
/// came from, for get_edit_context: "Tabitha: 257 lines #ff4d59 (from
/// Mother, Tabitha (Mother))".
pub fn summary(project: &Project) -> BTreeMap<String, String> {
    // Per label: lines, colours used, transcript voices.
    type Tally = BTreeMap<String, usize>;
    let mut out: BTreeMap<String, (usize, Tally, Tally)> = BTreeMap::new();
    for clip in &project.clips {
        let ClipContent::Text { style, .. } = &clip.content else {
            continue;
        };
        let Some(label) = &style.label else {
            continue;
        };
        let entry = out.entry(label.text.clone()).or_default();
        entry.0 += 1;
        *entry.1.entry(to_hex(label.color)).or_default() += 1;
        if let Some(from) = clip
            .name
            .as_deref()
            .and_then(|name| name.strip_prefix(SUBTITLE_PREFIX))
        {
            *entry.2.entry(from.to_owned()).or_default() += 1;
        }
    }
    out.into_iter()
        .map(|(label, (lines, colours, names))| {
            let colours: Vec<&str> = colours.keys().map(String::as_str).collect();
            let names: Vec<&str> = names.keys().map(String::as_str).collect();
            (
                label,
                format!(
                    "{lines} lines {} (from {})",
                    colours.join(" + "),
                    names.join(", ")
                ),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::{Clip, ClipColor, TextLabel, TextStyle, Transform};

    fn subtitle(id: &str, start: i64, from: &str, label: &str, colour: &str) -> Clip {
        Clip {
            id: id.into(),
            track: "v9".into(),
            start,
            duration: 30,
            color: ClipColor::Cyan,
            name: Some(format!("{SUBTITLE_PREFIX}{from}")),
            link: None,
            fade_in: 0,
            fade_out: 0,
            keyframes: Default::default(),
            person: None,
            content: ClipContent::Text {
                text: "words".into(),
                style: TextStyle {
                    label: Some(TextLabel {
                        text: label.into(),
                        color: from_hex(colour, 1.0),
                        size: 26.0,
                    }),
                    ..TextStyle::default()
                },
                transform: Transform::default(),
                animation: Default::default(),
                opacity: 1.0,
                word_times: Vec::new(),
            },
        }
    }

    fn text(id: &str, name: &str, colour: &str) -> Clip {
        let mut clip = subtitle(id, 0, "x", "x", colour);
        clip.name = Some(name.into());
        if let ClipContent::Text { style, .. } = &mut clip.content {
            style.label = None;
            style.color = from_hex(colour, 1.0);
        }
        clip
    }

    fn label_colour(project: &Project, id: &str) -> String {
        match &project.clip(id).unwrap().content {
            ClipContent::Text { style, .. } => style
                .label
                .as_ref()
                .map_or_else(|| to_hex(style.color), |label| to_hex(label.color)),
            _ => panic!("{id} isn't text"),
        }
    }

    fn project(clips: Vec<Clip>) -> Project {
        let mut project = Project::new("p".into(), "t".into(), edit_core::Settings::default());
        project.clips = clips;
        project
    }

    #[test]
    fn one_person_one_colour_and_no_two_people_alike() {
        // The bodycam edit's mess: one officer in three teals, a child in two
        // colours, and one orange on a child and a neighbour.
        let mut clips = Vec::new();
        for i in 0..6 {
            clips.push(subtitle(
                &format!("o{i}"),
                i * 40,
                "Officer",
                "Officer:",
                "#00e5c7",
            ));
        }
        clips.push(subtitle(
            "o6",
            300,
            "Sinclair (Officer)",
            "Officer:",
            "#b5f8ee",
        ));
        clips.push(subtitle("o7", 340, "Officer", "Officer:", "#009e8c"));
        clips.push(subtitle("c1", 400, "Child 2", "Child:", "#e57e00"));
        clips.push(subtitle("c2", 440, "Child", "Child:", "#3ddc84"));
        clips.push(subtitle("c3", 480, "Child 2", "Child:", "#e57e00"));
        clips.push(subtitle("n1", 520, "Neighbor", "Neighbor:", "#e57e00"));
        clips.push(subtitle("n2", 560, "Neighbor", "Neighbor:", "#e57e00"));
        clips.push(subtitle("n3", 600, "Neighbor", "Neighbor:", "#e57e00"));
        clips.push(subtitle("n4", 640, "Neighbor", "Neighbor:", "#e57e00"));
        // A doctor in a teal too near the officer's.
        clips.push(subtitle("d1", 700, "Como (Doctor)", "Doctor:", "#4dffbf"));
        // The intro caption of the named officer, and a quote of the child's.
        clips.push(text("cap", "Caption · Sinclair (Officer)", "#b5f8ee"));
        clips.push(text("q", "Quote · Child", "#ffffff"));
        let mut project = project(clips);
        let report = one_colour_per_person(&mut project);
        let officer = label_colour(&project, "o0");
        for id in ["o1", "o6", "o7", "cap"] {
            assert_eq!(label_colour(&project, id), officer, "{id}");
        }
        assert_eq!(officer, "#00e5c7");
        let child = label_colour(&project, "c1");
        assert_eq!(label_colour(&project, "c2"), child);
        assert_eq!(label_colour(&project, "q"), child);
        let neighbour = label_colour(&project, "n1");
        let doctor = label_colour(&project, "d1");
        // The neighbour (more lines) keeps the orange; the child moves off it.
        assert_eq!(neighbour, "#e57e00");
        let people = [officer, child, neighbour, doctor];
        for (i, a) in people.iter().enumerate() {
            for b in people.iter().skip(i + 1) {
                assert!(crate::speakers::apart(a, b) >= APART, "{a} vs {b}");
            }
        }
        assert_eq!(report.as_array().map(Vec::len), Some(4));
        // A second run changes nothing.
        let before = project.clone();
        one_colour_per_person(&mut project);
        assert_eq!(project, before);
    }

    #[test]
    fn an_officer_in_pink_is_moved_off_it() {
        // Mom & Teen's Officer Schweickart came out in hot pink.
        let mut project = project(vec![
            subtitle("o1", 0, "Schweickart (Officer)", "Schweickart:", "#ff66d1"),
            subtitle("o2", 40, "Schweickart (Officer)", "Schweickart:", "#ff66d1"),
            subtitle("m1", 80, "Mother", "Mom:", "#ff66d1"),
        ]);
        one_colour_per_person(&mut project);
        let officer = label_colour(&project, "o1");
        assert!(!crate::speakers::pinkish(&officer), "{officer}");
        assert_eq!(label_colour(&project, "m1"), "#ff66d1");
    }

    #[test]
    fn never_white_and_merged_voices_are_named() {
        let mut project = project(vec![
            subtitle("s1", 0, "Sister 2", "Sister 2:", "#ffffff"),
            subtitle("s2", 40, "Sister 2", "Sister 2:", "#ffffff"),
            subtitle("m1", 80, "Mother", "Tabitha:", "#ff4d59"),
            subtitle("m2", 120, "Tabitha (Mother)", "Tabitha:", "#ff4d59"),
            subtitle("k1", 160, "Kevin (Father)", "Tabitha:", "#ff4d59"),
        ]);
        let report = one_colour_per_person(&mut project);
        assert!(!whitish(&label_colour(&project, "s1")));
        let tabitha = report
            .as_array()
            .unwrap()
            .iter()
            .find(|person| person["label"] == "Tabitha:")
            .unwrap();
        assert_eq!(
            tabitha["other_voices_under_this_label"],
            json!(["Kevin (Father)"])
        );
        assert!(PALETTE.iter().all(|colour| !whitish(colour)));
    }

    #[test]
    fn the_palette_stands_apart_and_more_people_share_far_apart_in_time() {
        for (i, a) in PALETTE.iter().enumerate() {
            for b in PALETTE.iter().skip(i + 1) {
                assert!(crate::speakers::apart(a, b) >= APART, "{a} vs {b}");
            }
        }
        // 22 people, each in their own minute, all in white to start with.
        let mut clips = Vec::new();
        for person in 0..22_i64 {
            for line in 0..(30 - person) {
                clips.push(subtitle(
                    &format!("p{person}-{line}"),
                    person * 1800 + line * 31,
                    &format!("Person {person}"),
                    &format!("Person {person}:"),
                    "#ffffff",
                ));
            }
        }
        let mut project = project(clips);
        one_colour_per_person(&mut project);
        let colour = |person: i64| label_colour(&project, &format!("p{person}-0"));
        let mut seen: Vec<String> = (0..20).map(colour).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 20, "the first 20 people all differ");
        // The two with the fewest lines share with whoever is furthest away: the first people.
        for late in [20, 21] {
            let shared = colour(late);
            let with = (0..20).find(|person| colour(*person) == shared).unwrap();
            assert!(late - with >= 10, "person {late} shares with {with}");
        }
    }
}
