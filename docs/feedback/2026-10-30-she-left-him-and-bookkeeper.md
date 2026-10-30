# She Left Him and the Bookkeeper — the team's notes, 29–30 October 2026

She Left Him `p1793273198608-28` (54 notes over v1–v4; v5 shared 02:36,
[review](https://feedback.spheceo.com/r/QWbSaNJyYW0Y_v798Hn5pw)) and the
Bookkeeper `p1793223687041-1039` (18 notes on v1; v2 shared 01:46 in place of
the v2 before it, [review](https://feedback.spheceo.com/r/gXRSyVs4kI96cNGaRalLfQ)).
Both were fixed by the in-app agent through Ready for changes. The user said
the agent "had a really hard time actually showing the correct intro clips. I
had to reinstruct it several times, and I'm still not sure it's 100% right".

Anchors on the review are frames, not seconds (frame 282 is 9.4 s).

## Patterns

| Pattern and the team's words | Cause | Teaching | Code and audit |
|---|---|---|---|
| **The script not followed, the intro above all** (She Left Him ×5, Bookkeeper ×2): "we need to ensure that the script is followed 100%"; "the clips in the entire intro are not correct according to the script - check the script again... we are missing clips of jessica in the interview room"; "We need to ensure that our intro clips 100% match with what we see inside of the script"; "we hallucinate and leave parts of the script out - fatal mistake!!!"; "According to the script, the intro stops after this. Please ensure that we never hallucinate with the edit, but please follow the script strictly." | The intro skill said the opposite: "Calm room shots… cut them from the script's teasers, and if what's left is thin, add the footage's strongest lines" (from JJ's Oct 22 notes on Mom & Teen, whose script was thin on the suspects). The audits pushed the same way: `intro_long` said "cut calm lines… from the teasers", `intro_no_arrest` wanted the intro to end on the arrest. And `off_script` skipped any range whose clip was gone or had no first/last words, so the interview-room teasers it cut never showed up. | `intro.md`: with a script, its teaser ranges exactly, every one, in its order, from its own recording, ending where the script's intro ends; never cut, swap or add one; only a reviewer's note changes them. Without a script, the old rule. `edit-workflow.md` stage 2 likewise. | `intro_long` and `intro_no_arrest` off when the edit's footage comes from a script. `off_script` now checks a range whose clip is gone (what of it plays anywhere on the footage track counts) and one without words (its own times); a call (audio only) counts its sound clips. New `script_order`: each range first plays after the one before it. Both in the follow-up's fixable kinds. |
| **Footage shown before the video reaches it** (She Left Him ×5): "we cant show this footage here - this is something we only see later in the video"; "It is a complete no-go to show this footage right here"; "Throughout the entire video, we need to ensure that we don't show footage that obviously is something we haven't seen yet". | Taught already (cut-ins ORDER: "never show something the video hasn't reached"), but nothing checked it, and B-roll picked by find_in_footage looks for what the words say, wherever it is. | ORDER rule names its audit and quotes the team. | New `footage_ahead`: a picture over a cut-in after the intro from a script range that first plays more than 45 s later. On v5 it finds **9 more** (e.g. 7:20, the ambulance scene that plays at 10:20; checked by eye). Bookkeeper v2: 3. |
| **Narration over the footage's own sound** (Bookkeeper ×3, She Left Him ×1): "VO starts here where we are still inside the footage - critical mistake throughout the entire video"; "we start the real sound before we are out of the cut in. Small mistakes like these may not happen anywhere in the video"; "it seems like we start the voiceover before we have actually had our visual transition". | Nothing taught or checked it. | cut-ins VOICE-OVERS: the narration starts once we're out of the footage, the footage's sound comes back once it ends; the team's words. | New `voiceover_in_footage` (either way round, past a fade and 0.2 s). None left on either video. |
| **Desktop screens: the windows move, the wallpaper stays still** (She Left Him ×3): "it is the camera moving around in the photo viewers and file viewers, rather than the file and photo viewers moving around on the screen and the Windows screen staying static … throughout the entire video". | `desktop.ts` keys each window's move and leaves the wallpaper without keyframes. | Already taught (one camera move). | Fixed by hand in both videos (She Left Him 10, Bookkeeper 3). Still to do in code: one camera move over the whole screen, each window only its own open/close (plan 1b). |
| **Restarts during a fix** (Bookkeeper): the agent couldn't mark notes (shortened ids, replies), the follow-through to the share was lost, the cut turn ran on beside the resumed one. | In-memory follow-through; no clean-up of the old run's processes; note ids matched exactly. | — | 533b9804: leftovers ended at start, taken fixes followed again after a restart, notes matched by the start of their id, a reply resolves to its note. |
| **Which version** (user): "unless there is a comment on v2 as soon as there is a comment it goes as v3 and fixes those comments as well". | The share was picked by hand. | — | Still to do: the fixing flow picks replace or append by this rule (plan 1b). |

## One-offs

Music changes (She Left Him ×6, Bookkeeper ×2), black borders round the
Windows screen (×3), subtitles late in places and one line given to the wrong
speaker (Bookkeeper "Call Patrick"), Notepad text, image choices and pop-ups,
a map's route, labels ("suspect's cousin", "Danielle - EMS"): fixed by the
agent note by note.

## Left open

- She Left Him's first note ("the script is followed 100%") and the
  Bookkeeper's overlay note are still open on the review: the work is done,
  but a reply on each was marked instead of its note. Resolve on the page.
- She Left Him v5 has the 9 `footage_ahead` places above; the Bookkeeper v2
  has 3 and two `off_script` ranges (6:49–6:51 and a 15 s gap inside
  7:13–11:16). Not fixed: no one has commented since, and a new version is the
  user's call.
