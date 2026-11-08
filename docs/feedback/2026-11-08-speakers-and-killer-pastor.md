# Wrong speakers, detective numbering, short texts and early risers: JJ's notes, Nov 7–8

The notes are JJ's reviews of Female Police Captain (v1–v3), Police Hunt Down Their Own Colleague (v1) and Killer Pastor (v1, 35 notes). Sphe, Nov 8: "subject detection is kinda fucked in some areas on these projects so we'll need that solved". The three projects were copied into dev (`just copy-to-dev`) and run on mandalorian (Linux) against the dev relay.

## Speakers

**Why.** Most of the footage is YouTube, heard from YouTube's captions. Captions have no voices, so every caption line was its own `caption_turn_N`, named one by one. Scribe heard whole also drifts on a long file: on the 84-minute Kimberly interrogation it made Kimberly and the detective one voice from 48:40 to 54:30, and the same 13 minutes heard alone came out right.

**Fix.** The words come from Scribe and the voices from pyannote Precision-3 (relay `/v1/diarize/jobs`, server `voices.ts`), behind the relay's `DIARIZE` flag. The flag is on for dev and off for the live relay. A cloud recording is heard whole once, by its R2 key, and each excerpt takes its stretch. So one voice id is one person across every excerpt of a recording.

**Then a second cause.** On the first dev run, the voices were right: every word of Kimberly's was on `speaker_1`. But in one excerpt that voice was subtitled "Investigator". In one window, the watcher had given Kimberly's voice the investigator's description (blue shirt, short hair). The cast groups by look first, so that excerpt's voice went to the investigator. That's JJ's "in between the two women, where we have essentially swapped their roles". Fix: with pyannote's voices, `cast.ts byVoice` treats one voice of one recording as one person, decided by most of its windows.

## Numbering per case

JJ: "it makes no sense that we call this detective 'Detective 4'". The cast numbered people across the whole project. Now each file's case comes from its blocks' "Case N:" notes. No person is grouped across cases, and the numbering starts again in each case. The subtitles skills also say never to use ordinals ("Second Detective") and never to rename a detective partway through a case.

## Texts, risers, B-roll

- `text_short`: a red quote or a big line held under 1.5 s plus three words a second (4 s at least), or with a B-roll cut under it. On Killer Pastor it flags every quote JJ pointed at. The interrogation notes now say words on screen are few, at most one a bridge.
- `riser_off_cut`: a riser whose climax is more than 0.2 s off its transition. Killer Pastor's risers ended 0.3–1.7 s early, because the cuts moved after the risers were placed. `placeSound` now puts a riser's climax (its hit, when that's late in the file) on the cut.
- An interrogation's room under a narration holds its shot, as a courtroom's does. `long_broll_shot` no longer asks interrogation for a new shot every 3–4 s, and `broll_recut` covers interrogation.

## Run (Nov 8, dev on mandalorian, then prod)

Each project went through Edit in dev: the agent got JJ's notes, re-watched with the new voices, redid the subtitles and exported. Then each was committed to prod as its next revision and shared on its existing link.

Speakers, measured against pyannote's voices (subtitle lines whose label isn't their voice's):

| Project | Version JJ reviewed | Now |
|---|---|---|
| Female Police Captain | 468 of 2,156 (21.7%) | 17 of 2,232 (0.8%) |
| Police Hunt | 372 of 1,231 (30.2%) | 11 of 1,423 (0.8%) |
| Killer Pastor | 148 of 1,910 (7.7%) | 10 of 2,129 (0.5%) |

Killer Pastor's audits: `riser_off_cut` went from 7 to 0, and `text_short` from 30 to 0. JJ's word notes are in ("bit", "You went over", "Amanda?", "He didn't die."). Each case's labels start at "Detective" and "Officer".

Links:
- Police Hunt: https://feedback.spheceo.com/r/rQddCHqZza5-uzBs1UeXMg (v2 replaced)
- Female Police Captain: https://feedback.spheceo.com/r/ria0huFRqGapbrsO9Ig34Q (v4 replaced)
- Killer Pastor: https://feedback.spheceo.com/r/JHG0RA9H5WigwJMVvfdx4g (v2)

Fixed along the way:
- `copy-to-dev` now copies a pieced proxy's folder.
- A re-hearing far shorter than the transcript it replaces is refused.
- A pieced proxy is heard, and its watch frames are cut, from its original. Read through the proxy, every piece of Killer Pastor's 1 h 52 min tape was made at once, and Edit went past 23 GB and Bun aborted.
- A recording pyannote can't load (1.8 GB) falls back to each excerpt's own audio.
- Excerpts of one recording share one pyannote job.
- Two voices in one window are two people.

Still open:
- Killer Pastor's 35 v1 notes are still open on the review. They were fixed in dev, where the review doesn't exist.
- Dev reviews can't open on feedback.spheceo.com (see Nov 4).
