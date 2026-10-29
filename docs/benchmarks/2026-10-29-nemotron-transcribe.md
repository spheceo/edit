# Nemotron 3.5 Transcribe vs our transcripts, Oct 29

Plan: `docs/plans/2026-10-29-nemotron-transcribe.md`. Scripts: `app/scripts/nemotron-bench.py` (Modal, one H100, BF16, vLLM 0.32.0, NeMo Speech `743beaf427`, the model card's serve command) and `app/scripts/nemotron-score.py`.

**Verdict: Scribe stays.** Nemotron is worse at who speaks on both videos. It gets the team's Killer Couple feedback stretch wrong, and it can't hear more than 8 people. Its word times are as good as Scribe's pieces, and its words are no clear gain.

## Videos

- **Killer Couple** (`p1792351482180-138`, 52.7 min interrogation, 13 people). The team's note: "the exact same person speaking, is picked up as different colors" (`docs/feedback/2026-10-19-killer-couple.md`). Mike's speech at 13:24–14:30 was corrected by hand.
- **Concerned Sergeant** (`p1793003918016-1`, 53.1 min, 10 people).

The reference is each project's finished transcript (Scribe, then the watch and the team's fixes, each voice named as a person). It started from Scribe, so it leans towards Scribe. That's why "one-to-one" (each tag or voice stands for one person; a split person loses all but one tag's words) is the fair speaker number, and why Scribe's many-to-one is 100% by construction.

Two prompts per video: the card's (speaker tags `<spk:0>`…`<spk:3>`) and ours (the card's multi-speaker "etc." wording plus the case's names as context terms). They scored within 1% of each other; the numbers below are ours.

## Speakers

| | Killer Couple | Concerned Sergeant |
|---|---|---|
| People in the reference | 13 | 9–10 |
| Nemotron tags / Scribe voices | 8 / 18 | 8 / 11 |
| One-to-one: Nemotron | **76.3%** | **87.6%** |
| One-to-one: Scribe's raw voices | 84.4% | 98.4% |
| Many-to-one: Nemotron (how pure its tags are) | 78.0% | 90.7% |

- **It stops at 8 speakers** (its training limit), so smaller voices are merged into bigger ones. In Killer Couple the second suspect (Phazion Whyte), three witnesses and an officer come out 0% right.
- **The feedback stretch (13:24–14:30, Mike):** 9 of 151 words right. Nemotron gives it to two other tags (77 words to the officer's tag, 61 to Jeff's). Scribe and the watch get it right after the fix. Mike is split across 3 tags overall (74% right); Scribe keeps him on 1 voice above 10%.
- **Sergeant:** the suspect (96%) and the narrator (100%) are fine; Detective 3 is 0% and Cabarrus 67%.

## Words and timing

- About 20% of words differ from ours on both videos (Killer Couple: 574 missing, 719 extra, 515 different of 9,050; Sergeant similar). Much of that is style ("seventh" vs "7th", "uh huh" vs "mmhmm", "cause" vs "'cause") or quiet back-and-forth where neither is sure. Some is Nemotron wrong ("buccal swabs" → "books bubbles"), and it leaves out several runs Scribe has (48 words at 5:51 in Killer Couple, 47 at 16:19 in Sergeant). Without listening, no clear win either way.
- Timing: median 0.03 s from Scribe's pieces, p90 0.10 s, under 1% more than a second off. As good as the pieces, from one whole-file pass.

## Speed and cost

- Each hour-long file took 74–88 s on one H100 (four heard at once in 93 s).
- Starting the server took 11 min (85 s of weights, the rest compiling and warming up). One cold start plus four files: 786 s of H100, about $0.85 on Modal. Run warm, about $0.10 per hour of audio; with a cold start per video it's more than Scribe's ~$0.22.
- The 67.5 GB weights sit in the Modal volume `nemotron-bench`.

## When to look again

If a release raises the speaker limit past 8 or is shown to beat Scribe on distant, overlapping speech. The scripts re-run as they are: `nemotron-bench.py` with the WAVs, then `nemotron-score.py` with `--window` for feedback stretches.
