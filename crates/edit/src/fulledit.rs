//! "Run full edit": the steps of a whole edit, as the team runs them by hand
//! (research, intro, cut-ins, subtitles, outro, music and sound, a final
//! pass), sent to the agent one after another in the same conversation. Each
//! is its own turn, so a step that fails or gets cut off doesn't take the rest
//! with it, the agent keeps what earlier steps found, and every step is timed.

/// (name, what the step asks for). The house style the agent already has
/// says how; these say what, and where each step stops.
pub const STEPS: &[(&str, &str)] = &[
    (
        "Research",
        "RESEARCH (house style RESEARCH, FACTS). First, if the project has voice-over recordings that aren't on their cut-ins yet, place them (place_voiceovers). Then research this case before we edit: start from the script and the transcripts, find and check the news articles about it and save every matching one (add_article). Collect images: the people arrested (mugshots, by name), the place as reported, and anything the narration names; weed them with look_at_found / reject_found. Don't touch the timeline otherwise. Finish with: who was arrested, their exact charges (as the articles word them), and which found image is each person's mugshot (its id), or that none was found.",
    ),
    (
        "Intro",
        "THE INTRO (house style INTRO, SCOPE): edit the intro section fully: the opening reverse dip, speaker captions, punch-ins and witness zooms, B-roll over its cut-ins (cover_cut_in, then what's particular to each), transitions with their sound. Nothing after the intro. Check it with contact_sheet (and render_frame where a detail needs it).",
    ),
    (
        "Cut-ins",
        "THE CUT-INS: cover every cut-in after the intro with B-roll, following the house style: THE DATE CUT-IN opens on map_view with the date and place label; B-ROLL IN CUT-INS from the source footage timed to the narration's words, shots changing on its phrases (cover_cut_in operations in apply_edit_plan); EMPHASIS IN THE NARRATION runs where the footage really shows what the words name; INTRODUCING A PERSON callouts and vignettes where the narration introduces someone; QUOTE CALLOUTS on the lines that carry the story; TRANSITIONS varied (a glitch at most once or twice in the whole video) and every transition heard. Leave the outro's cut-ins for the outro step. Read get_edit_context with include_transcript once for this stage (it includes all cut-in narration word timings). Pick shots for all cut-ins, then apply them and their extras together in one apply_edit_plan. Use native frame sampling; do not start optical-flow smoothing. Request one review_frames contact sheet spanning the new layouts; fix only concrete defects in one follow-up plan. Then list what each cut-in got.",
    ),
    (
        "Subtitles",
        "SUBTITLES (house style AFTER THE INTRO, SPEAKERS, HOUSE WORDS ON SCREEN): run watch_footage, then add_subtitles for everything after the intro (neglect: true for a child abuse or neglect case); give each person one short label and one colour with update_clips; run review_edit for cached transcript coverage and fix only the uncovered stretches it reports (missing transcripts are reported separately), plus lines that read oddly; check a few frames across the video (bodycam stretches, phone calls).",
    ),
    (
        "Outro",
        "THE OUTRO (house style THE OUTRO): build the charges screens over the outro's cut-ins from what the research found: per person arrested, in order, their picture on the left (the mugshot with use_found, else a clear still_frame of them from late in the footage), the black gradient, and their exact charges in red glowing left-aligned text, held while the voice-over talks about them; people charged together share one screen. Remove the outro's cards and words as the screens replace them, and end the video on the outro's last word. Check the screens together in one contact sheet and say which charges you used and where they came from.",
    ),
    (
        "Music and sound",
        "MUSIC AND SOUND (house style MUSIC AND SOUND EFFECTS, EVERY TRANSITION IS HEARD): decide this case's tone from the script and footage and choose the beds deliberately (say which and why), lay them scene by scene, changing only at scene changes; make sure every transition and reveal has its sound, risers into scene changes, no whoosh after whoosh. Set levels with measure_audio against the speech and check nothing drowns a word.",
    ),
    (
        "Final pass",
        "FINAL PASS: start with review_edit for a structural audit and one contact sheet across the edited sections. Reuse earlier visual reviews for unchanged sections. Look for: gaps or slivers, clips floating with nothing under them (tidy_tracks), redactions covered, captions or subtitles on the wrong person, transitions that repeat, sound levels (measure_audio). Fix what you find, then run mute_house_words over the whole timeline last. Finish with a short summary of the finished edit: its length, the sections, and everything you weren't sure about that the user should look at.",
    ),
];

/// The message for step `index` (0-based): where it sits in the whole plan,
/// that the agent carries on alone, then the step itself and the user's notes.
pub fn prompt(index: usize, notes: &str) -> Option<String> {
    let (name, ask) = STEPS.get(index)?;
    let plan: Vec<String> = STEPS
        .iter()
        .enumerate()
        .map(|(at, (step, _))| format!("{}. {step}", at + 1))
        .collect();
    let notes = notes.trim();
    Some(format!(
        "(Edit, running the full edit) Step {} of {}: {name}. The whole plan: {}. You're working through it on your own: Edit sends the next step when you finish this one. So do this step completely and stop there (don't start the next one), don't ask the user anything (decide yourself and keep a note of what you weren't sure about for the final summary), and work fast: read get_edit_context once, plan the entire stage, apply its known timeline operations in one apply_edit_plan with base_rev and optional review_frames, then make at most one focused correction pass for concrete failures. Use cached narration word timings and source loudness; do not repeat full project reads, transcript reads or visual reviews of unchanged work. Batch any independent source lookups. Optical-flow smoothing is opt-in, never part of a normal edit. The target is ten minutes for the whole edit; report external blockers and uncertain creative choices instead of repeatedly retrying unavailable sources.{}\n\n{ask}",
        index + 1,
        STEPS.len(),
        plan.join(", "),
        if notes.is_empty() {
            String::new()
        } else {
            format!("\n\nThe user's notes for this edit: {notes}")
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::{prompt, STEPS};

    #[test]
    fn each_step_says_where_it_is_and_carries_the_notes() {
        let first = prompt(0, "  a neglect case  ").unwrap();
        assert!(first.contains("Step 1 of 7: Research"));
        assert!(first.contains("The user's notes for this edit: a neglect case"));
        assert!(!prompt(6, "").unwrap().contains("notes"));
        assert!(prompt(STEPS.len(), "").is_none());
    }
}
