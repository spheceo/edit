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

## Run

See the end of this file for the dev runs, exports and review links.
