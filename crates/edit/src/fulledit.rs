//! "Run full edit": the steps of a whole edit, as the team runs them by hand
//! (research, intro, cut-ins, subtitles, outro, music and sound, a final
//! pass), sent to the agent one after another in a fresh conversation. Each
//! is its own turn, so a step that fails or gets cut off doesn't take the rest
//! with it, the agent keeps what earlier steps found, and every step is timed.
//!
//! Where the time went in a 2½-hour run: model round trips (each one slower
//! the more the conversation holds), the agent polling slow tools a second at
//! a time, and checking the same work again and again (57 contact sheets, 64
//! single frames, 45 loudness measurements). The prompts below ask for one
//! read, one plan and one look per step; slow work (watching the footage)
//! starts in the background when the run does.

pub struct Step {
    pub name: &'static str,
    /// Reasoning effort: medium where the step is judgement (facts, shots),
    /// low where it's applying the house style.
    pub effort: &'static str,
    /// What the step asks for. The house style the agent already has says
    /// how; these say what, and where each step stops.
    pub ask: &'static str,
}

pub const STEPS: &[Step] = &[
    Step {
        name: "Research",
        effort: "medium",
        ask: "RESEARCH (house style RESEARCH, FACTS). If the project has voice-over recordings that aren't on their cut-ins yet, place them (place_voiceovers). If case_articles already lists articles about this case and the found images are already weighed, don't search again: read what's saved (one call) and go to the summary. Otherwise start from the script and the transcripts, find and check the news articles about the case and save every matching one (add_article), and collect images: the people arrested (mugshots, by name), the place as reported, and anything the narration names; weed them with look_at_found / reject_found. Don't touch the timeline otherwise. Finish with a short brief the later steps will use: the date and place (street, city, state) for the map, who was arrested, their exact charges (as the articles word them, with the source), and which found image is each person's mugshot (its id), or that none was found.",
    },
    Step {
        name: "Intro",
        effort: "medium",
        ask: "THE INTRO (house style INTRO, SCOPE): edit the intro section fully: the opening reverse dip, speaker captions (caption_speakers), punch-ins and witness zooms, B-roll over its cut-ins (cover_cut_in operations, then what's particular to each), transitions with their sound. Nothing after the intro. get_edit_context with section \"intro\" and include_transcript gives you everything to plan it.",
    },
    Step {
        name: "Cut-ins",
        effort: "medium",
        ask: "THE CUT-INS: cover every cut-in between the intro and the outro with B-roll, following the house style: THE DATE CUT-IN opens on map_view with the date and place label (the place from the research brief); B-ROLL IN CUT-INS from the source footage timed to the narration's words, shots changing on its phrases; EMPHASIS IN THE NARRATION runs where the footage really shows what the words name; INTRODUCING A PERSON callouts and vignettes where the narration introduces someone; QUOTE CALLOUTS on the lines that carry the story; TRANSITIONS varied (a glitch at most once or twice in the whole video) and every transition heard. Leave the outro's cut-ins for the outro step. get_edit_context with section \"story\" has every cut-in's narration with word timings; find shots in the footage with media_transcript (several in one batch) and look_at_media only where the words don't settle it. Then lay out all the cut-ins and their extras in one apply_edit_plan (cover_cut_in operations for the B-roll), with review_frames on each cut-in's first shot and its callouts, and the transition sounds in one batch. Then list what each cut-in got.",
    },
    Step {
        name: "Subtitles",
        effort: "low",
        ask: "SUBTITLES (house style AFTER THE INTRO, SPEAKERS, HOUSE WORDS ON SCREEN): watch_footage (it started in the background when this run began, so it usually answers at once from its cache), then add_subtitles for everything after the intro (neglect: true for a child abuse or neglect case). Give each person one short label and one colour, all in one update_clips or apply_edit_plan. Run review_edit once: fix only the uncovered stretches it reports and lines that read oddly. Don't read whole transcripts or render frames to check speakers; the watcher already looked.",
    },
    Step {
        name: "Outro",
        effort: "low",
        ask: "THE OUTRO (house style THE OUTRO): build the charges screens over the outro's cut-ins from the research brief: per person arrested, in order, their picture on the left (the mugshot with use_found, else a clear still_frame of them from late in the footage), the black gradient, and their exact charges in red glowing left-aligned text, held while the voice-over talks about them; people charged together share one screen. Remove the outro's cards and words as the screens replace them, and end the video on the outro's last word (get_edit_context with section \"outro\" has its word timings). Build it all in one apply_edit_plan with review_frames on each screen, then say which charges you used and where they came from.",
    },
    Step {
        name: "Music and sound",
        effort: "low",
        ask: "MUSIC AND SOUND (house style MUSIC AND SOUND EFFECTS, EVERY TRANSITION IS HEARD): decide this case's tone from the script and footage, read list_library once, and choose the beds deliberately (say which and why); lay them scene by scene, changing only at scene changes; make sure every transition and reveal has its sound, risers into scene changes, no whoosh after whoosh. Place everything in one batch of add_from_library calls with under_speech (LU under the speech: music 12, low-volume notes 16, music with nothing said over it 6, risers 8, hits 0, whooshes and shutters 3, clicks 8): it sets each level against the edit's measured speech, so there is nothing to measure before or after.",
    },
    Step {
        name: "Final pass",
        effort: "low",
        ask: "FINAL PASS: one review_edit with frames across the whole edit (one per section and each place an earlier step flagged; at most 24): it reports gaps, slivers, floating clips, misaligned sound and uncovered speech. Look for: redactions covered, captions or subtitles on the wrong person, transitions that repeat. Fix what you find in one apply_edit_plan (tidy_tracks included), then run mute_house_words over the whole timeline last. Don't re-review sections earlier steps already checked unless you changed them. Finish with a short summary of the finished edit: its length, the sections, and everything you weren't sure about that the user should look at.",
    },
];

/// The message for step `index` (0-based): where it sits in the whole plan,
/// how to work fast, then the step itself and the user's notes (sent with the
/// first step only; the conversation keeps them).
pub fn prompt(index: usize, notes: &str) -> Option<String> {
    let step = STEPS.get(index)?;
    let plan: Vec<String> = STEPS
        .iter()
        .enumerate()
        .map(|(at, step)| format!("{}. {}", at + 1, step.name))
        .collect();
    let notes = notes.trim();
    Some(format!(
        "(Edit, running the full edit) Step {} of {}: {}. The whole plan: {}. You're working through it on your own: Edit sends the next step when you finish this one. So do this step completely and stop there (don't start the next one), and don't ask the user anything (decide yourself and keep a note of what you weren't sure about for the final summary).\n\nThe whole edit should take about ten minutes, so a step is a handful of tool calls, not dozens: read get_edit_context once (narrowed to the step's section), decide everything the step needs, apply the timeline changes in one apply_edit_plan (base_rev from the context) and the tools that place sounds, images or text in one batch, then look once (review_frames on the plan, or one contact_sheet) and fix only concrete defects in one more call. Never re-read the project, a transcript or a frame you've already seen, and never check unchanged work again. When a tool is still running, wait for it in long blocks (yield_time_ms 30000 or more), not second by second.{}\n\n{}",
        index + 1,
        STEPS.len(),
        step.name,
        plan.join(", "),
        if notes.is_empty() || index > 0 {
            String::new()
        } else {
            format!("\n\nThe user's notes for this edit (they hold for every step): {notes}")
        },
        step.ask,
    ))
}

#[cfg(test)]
mod tests {
    use super::{prompt, STEPS};

    #[test]
    fn each_step_says_where_it_is_and_the_first_carries_the_notes() {
        let first = prompt(0, "  a neglect case  ").unwrap();
        assert!(first.contains("Step 1 of 7: Research"));
        assert!(first
            .contains("The user's notes for this edit (they hold for every step): a neglect case"));
        assert!(!prompt(1, "a neglect case")
            .unwrap()
            .contains("a neglect case"));
        assert!(!prompt(6, "").unwrap().contains("notes"));
        assert!(prompt(STEPS.len(), "").is_none());
    }
}
