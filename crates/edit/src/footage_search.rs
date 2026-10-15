//! `find_in_footage`: where things are said across all of a project's
//! footage, from the transcripts already made. Picking B-roll for a cut-in is
//! finding the moments its narration talks about; one search for every
//! phrase of every cut-in replaces reading transcript after transcript (a
//! full edit once spent 61 calls on media_transcript doing that by hand).

use edit_core::{MediaKind, Project};
use serde_json::{json, Value};

use crate::server::App;
use crate::transcribe::Transcript;

/// A word as it's compared: lower case, letters and digits only.
fn norm(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric() || *c == '\'')
        .flat_map(char::to_lowercase)
        .filter(|c| *c != '\'')
        .collect()
}

/// Words that say nothing on their own: a phrase is matched by the rest.
const SMALL: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "is", "it", "was", "i", "you",
    "he", "she", "they", "we", "that", "this", "for", "with", "be", "are", "were", "do", "did",
];

pub struct Hit {
    pub media: String,
    pub start: f64,
    pub end: f64,
    pub score: f64,
    pub index: usize,
}

/// The best places in `words` for `phrase`: windows a little longer than the
/// phrase, scored by the share of its meaningful words they hold (exact runs
/// score highest). Overlapping windows keep only their best.
pub fn search(words: &[String], phrase: &str) -> Vec<(usize, usize, f64)> {
    let wanted: Vec<String> = phrase
        .split_whitespace()
        .map(norm)
        .filter(|w| !w.is_empty())
        .collect();
    if wanted.is_empty() || words.is_empty() {
        return Vec::new();
    }
    let key: Vec<&String> = {
        let big: Vec<&String> = wanted
            .iter()
            .filter(|w| !SMALL.contains(&w.as_str()))
            .collect();
        if big.is_empty() {
            wanted.iter().collect()
        } else {
            big
        }
    };
    let span = (wanted.len() + 3).min(words.len());
    let mut found: Vec<(usize, usize, f64)> = Vec::new();
    let matches =
        |own: &String, w: &String| own == w || (w.len() > 4 && own.starts_with(w.as_str()));
    for start in 0..=words.len() - span {
        let window = &words[start..start + span];
        let held = key
            .iter()
            .filter(|w| window.iter().any(|own| matches(own, w)))
            .count();
        let mut score = held as f64 / key.len() as f64;
        if score < 0.6 {
            continue;
        }
        // An exact run of the whole phrase beats words scattered around.
        if window
            .windows(wanted.len())
            .any(|run| run.iter().zip(&wanted).all(|(a, b)| a == b))
        {
            score += 1.0;
        }
        // The hit runs from the first matching word to the last.
        let hit = |own: &String| key.iter().any(|w| matches(own, w));
        let (Some(first), Some(last)) = (window.iter().position(hit), window.iter().rposition(hit))
        else {
            continue;
        };
        let (first, last) = (start + first, start + last + 1);
        match found.last_mut() {
            Some(previous) if first < previous.1 => {
                if score > previous.2 {
                    *previous = (first, last, score);
                }
            }
            _ => found.push((first, last, score)),
        }
    }
    found.sort_by(|a, b| b.2.total_cmp(&a.2));
    found
}

pub fn find(
    app: &App,
    project: &Project,
    phrases: &[String],
    limit: usize,
    context: usize,
) -> Value {
    // Each video's cached transcript (nothing is transcribed here).
    let mut sources: Vec<(String, String, Transcript, Vec<String>)> = Vec::new();
    let mut missing = Vec::new();
    for media in project
        .media
        .iter()
        .filter(|media| media.kind == MediaKind::Video && media.has_audio)
    {
        let path = app
            .media
            .paths(std::path::Path::new(&media.path))
            .transcript;
        match std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Transcript>(&bytes).ok())
        {
            Some(transcript) => {
                let words = transcript
                    .words
                    .iter()
                    .map(|word| norm(&word.text))
                    .collect();
                sources.push((media.id.clone(), media.name.clone(), transcript, words));
            }
            None => missing.push(media.id.clone()),
        }
    }
    let results: Vec<Value> = phrases
        .iter()
        .map(|phrase| {
            let mut hits: Vec<Hit> = Vec::new();
            for (media, _, transcript, words) in &sources {
                for (from, to, score) in search(words, phrase) {
                    hits.push(Hit {
                        media: media.clone(),
                        start: transcript.words[from].start,
                        end: transcript.words[to - 1].end,
                        score,
                        index: from,
                    });
                }
            }
            hits.sort_by(|a, b| b.score.total_cmp(&a.score));
            hits.truncate(limit);
            let shown: Vec<Value> = hits
                .iter()
                .filter_map(|hit| {
                    let (_, name, transcript, _) =
                        sources.iter().find(|source| source.0 == hit.media)?;
                    let from = hit.index.saturating_sub(context);
                    let to = (hit.index + context + 6).min(transcript.words.len());
                    let said: Vec<&str> = transcript.words[from..to]
                        .iter()
                        .map(|word| word.text.trim())
                        .collect();
                    let voice = transcript.words[hit.index].speaker.as_ref().map(|voice| {
                        transcript
                            .speakers
                            .get(voice)
                            .cloned()
                            .unwrap_or_else(|| voice.clone())
                    });
                    Some(json!({
                        "media": hit.media,
                        "name": name,
                        "at": (hit.start * 100.0).round() / 100.0,
                        "end": (hit.end * 100.0).round() / 100.0,
                        "speaker": voice,
                        "exact": hit.score >= 1.0,
                        "said": said.join(" "),
                    }))
                })
                .collect();
            json!({ "phrase": phrase, "hits": shown })
        })
        .collect();
    json!({ "results": results, "untranscribed_media": missing })
}

#[cfg(test)]
mod tests {
    use super::{norm, search};

    #[test]
    fn exact_runs_beat_scattered_words_and_small_words_dont_count() {
        let words: Vec<String> =
            "officers found the baby in a bucket in the trunk of the car later the baby was"
                .split(' ')
                .map(norm)
                .collect();
        let hits = search(&words, "baby in a bucket");
        assert_eq!(&words[hits[0].0..hits[0].1], ["baby", "in", "a", "bucket"]);
        assert!(hits[0].2 >= 1.0);
        assert!(search(&words, "the a of").len() <= words.len());
        assert!(search(&words, "helicopter").is_empty());
    }
}
