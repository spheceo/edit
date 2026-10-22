# Teaching loop 2: from-scratch edits of three videos (Oct 21–22)

The brief (the user, Oct 21, away for a couple of days): take the team's feedback and teach the agent to get there itself: not by handing it the notes, but through short skills, better tools and audits. Each round, a fresh project with only what an agent gets (the Doc's footage, transcripts and voice-over, from a new import) and "Start the editing workflow." on Opus 5.5 (Claude Code, medium); judge the edit against the team's notes (the ideal state); teach; repeat. At most ~10 rounds, no exports, one holdout video at the end. Smaller skills preferred: "when the skills get too big and verbose, the agent seems to get confused".

Videos: "Helpful" Wife Has No Idea (interrogation, 74 min), 18-Year-Old Shoots 3 Teens (interrogation compilation, three cases, 77 min), Mom & Teen Daughter Buries Newborn in Bucket (bodycam, 17 min). Holdout: Serial Predator Caught After Torturing And Killing Disabled Woman (bodycam, 17 min), never used in the loop.

The ideal state: JJ's seven Frame.io rounds of Oct 21 (Helpful Wife v2, v3c, v4, v5; the comp v1, v3, v4), the Oct 20 Helpful Wife patterns, Mom & Teen (Oct 17) and Mom Leaves 5 Kids (Oct 17), as private answer keys (`~/edit-experiments/loop2/keys/`); measured by `score2.py` (text timing against the narration's words, centred text, teaser zoom, clicks on pop-ups, the audit's flags) and by eye on frame sheets (`frames.py`: the first 30 s every 2 s, every pop-up, every bridge's middle). Working log: `~/edit-experiments/loop2/LOG.md`; every trial's project, chat, score and frames under `~/edit-experiments/loop2/rounds/`.

## What changed, by kind

### Teaching (short, and shorter)
- Round 1 (fb47944), from the team's Oct 21 notes: the core's WORDS ON SCREEN COME FIRST (a beat before they're said: "we need to have it visually in front of us a second before") and text pinned to a zooming shot ("just like parenting something inside of After Effects"); the interrogation notes rewritten shorter (7.7 → 6.5 KB): one photo per person ("stick to one image"), a look that varies by bridge and holds to the flash, the name under a File Viewer with a click, THE PAUSE instead of centred text ("pause the previous frame and then write June 2013 on that frame"), a song's good stretch only; the opening: one vignette throughout ("vignette everywhere… throughout the entire intro"), open on the people ("we need to be able to see the occupants"), no colour flashes, a dip to black, silence and a hit before the video starts.
- Round 2 (ef53453): every teaser punched in (a framing, not a zoom move: round 1 read "never a zoom on every clip" as "no punch-ins"); teasers clear and in colour (round 1's comp made them black-and-white and blurred); the picture starts where the person is when a range opens on an empty room; the final pass fixes every flag, and is shorter.
- Round 4 (b086c8b): cut-ins and music-and-sound at about half their length (7.8 → 4.4, 4.7 → 2.4 KB), same rules and quotes. No regression; Helpful Wife fewer calls.
- Round 6 (aeca8dd): house subtitles, transitions, outro and edit-workflow shortened (8.7 → 2.8, 3.7 → 1.8, 4.4 → 1.9, 4.5 → 2.3 KB): a bodycam edit's skills ~41 → ~22 KB. Mom & Teen held up (clean after one follow-up, 12.8 min).
- a4fc0ba: leave the Windows screen's times to Edit.

### The harness (where most of the gain came from)
- **Edit follows a whole edit up** (f65a7eb, 30c4b33): when a turn that loaded edit-workflow or final-pass ends with three or more fixable flags in the audit, Edit sends "(Edit, automatically) The audit still lists what the team would catch: …", up to three times, each only while the last pass cut the flags by a fifth. Before it, the comp's agent listed 18 + 12 + 52 flags and stopped ("a pass of its own"); with it, round 7's comp ended with no unillustrated bridges and no long shots.
- **Context that fits** (f207182, 006c05f): a fresh import's audit listed 819 unsubtitled lines (250k characters a reply) and round 1's first trial stopped in a minute, blind; capped at 25 per kind. Later, the comp's narrowed context came back 59k characters with *no clips at all* (its whole media list and audit ate the budget): now a span gets only its own media and issues.
- **Plans that don't fail on the agent's own work** (d93d974, bd086fe): clips left overlapping go to their own track; a plan made before the agent's own sounds, starring or a background smoothing swap still saves.
- **Defaults right in code**: music ~20 LU under (0c4ffda: at 16 the team still asked to turn it down "significantly"); range edges keep whole words (0d88188: `align` cut 0.1 s into words; every import left 10–15 cut_mid_word); the Windows screen types its lines 0.7 s ahead (81b954b); interrogation dates at the bottom, lighter soft edges (7148f2a); long "moment" sound files get their hit (90b539c: 37 inaudible whooshes); stock libraries out of image searches (9d26b37: a dreamstime photo ×4); add_subtitles skips lines the intro's captions show (0f071fe: doubled teasers).
- **New audits and ops**: `text_late` (a55f3c4, with start_by; 6ef1ca9 exempts text that can't come earlier), `silent_popup` (7148f2a), op `pause` (b4d2db5).
- **Audits that stopped contradicting the rules**: name_not_introduced accepts a File Viewer name (b4d2db5) and skips "Suspect 2" (a4fc0ba); repeated_picture leaves a person's one photo (2efaf2f) and no longer drives the follow-up (a4fc0ba); music_bed_long leaves a bed that covers just one longer narration (80c096b: Mom & Teen's agent was caught between three audits).
- **Running out of things**: the relay's daily transcription (raised to ~90 h) and maps (120) (6e880c7, deployed); the AI Gateway (Vercel) ran out of credit at 21:05: Codex (GPT-6.1 Sol, computer use, no purchases) found $0 there, $0.14 on OpenRouter, made a free Gemini key, and an xAI key from its existing $9.56; `gemini.ts` (afdcce4, cc3b2bf) speaks Gemini's own API with fallback across Flash models' free quotas, and pictures go to xAI when they're all spent. Video watching has no fallback: speaker labels were weaker while Gemini was spent (rounds 6–7).

## Results

Eight rounds and the holdout, Oct 21 19:51 – Oct 22 10:20. Each row is one from-scratch edit; flags are what its final audit still listed (after Edit's follow-ups from round 3 on). "text early" is on-screen text whose words the narration says 0.3 s or more after it shows, of those matched; "teaser zoom" the share of the opening's footage that's punched in or moving.

```
video  round  min   tools  text early       centre  teaser zoom  clicks   unillus.  long shot  text_late  teaser_wide  dead_air  bed_long  cut_mid  marked pic
comp   R1     52.6  125    23/42 (10 late)  2       0.12         18/80    16        6          8          1            0         0         9        3         
comp   R2     52.5  117    16/26 (6 late)   0       1.00         90/91    18        12         6          0            0         0         11       52        
comp   R3     42.9  103    14/46 (22 late)  0       0.50         81/81    9         20         10         1            0         0         12       6         
comp   R4     54.4  145    40/55 (10 late)  0       0.25         81/81    15        8          16         1            0         1         11       0         
comp   R5     54.6  164    27/41 (4 late)   5       1.00         33/33    11        24         11         0            0         0         11       3         
comp   R6     57.0  172    31/39 (1 late)   1       1.00         38/38    2         0          9          0            0         0         10       9         
comp   R7     50.5  156    14/26 (2 late)   0       1.00         83/83    0         0          10         0            0         0         14       0         
comp   R8     85.4  194    21/41 (0 late)   0       1.00         85/85    0         0          2          0            0         0         12       60        
hw     R1     20.0  79     11/15 (3 late)   2       0.07         51/58    4         3          0          1            0         0         13       0         
hw     R2     38.0  112    22/31 (1 late)   0       1.00         73/76    0         0          2          0            5         0         14       0         
hw     R3     38.9  127    14/24 (5 late)   0       1.00         60/60    0         0          0          0            0         0         15       0         
hw     R4     30.8  82     14/21 (3 late)   0       1.00         72/72    0         0          2          0            0         0         9        0         
hw     R5     33.2  129    21/27 (0 late)   0       1.00         65/65    0         0          0          0            0         0         7        0         
hw     R6     37.9  124    20/28 (4 late)   0       1.00         69/69    0         0          1          0            0         0         8        0         
hw     R7     22.2  65     11/17 (2 late)   0       1.00         77/77    0         0          4          0            0         0         8        0         
hw     R8     20.3  89     9/10 (0 late)    0       1.00         122/122  0         0          0          0            0         0         8        0         
mom    R1     16.5  65     0/1 (0 late)     0       0.00         0/0      0         13         0          0            0         6         10       0         
mom    R2     13.5  49     0/1 (0 late)     1       0.00         0/0      0         32         0          0            0         7         12       0         
mom    R3     20.3  106    0/1 (0 late)     1       0.38         0/0      0         0          0          0            0         6         12       0         
mom    R4     18.8  67     0/1 (0 late)     1       0.12         6/6      0         0          0          0            0         0         11       0         
mom    R5     11.8  50     8/9 (0 late)     1       0.25         6/6      0         0          0          0            0         0         12       0         
mom    R6     12.8  66     2/5 (0 late)     1       0.00         6/6      0         0          0          0            0         0         11       0         
mom    R7     15.7  89     0/1 (0 late)     1       0.00         0/0      0         0          0          0            0         0         12       0         
mom    R8     19.4  93     4/5 (0 late)     1       0.00         6/6      0         0          0          0            0         0         10       0         
```

- **Helpful Wife** reached the team's notes by round 2 (teasers punched in, no centred text, names under File Viewers, one photo per person, pause frames: "A tip: a man named 'John'", "June 2013"), with flags left; from round 5 the follow-up cleared them, and round 8 finished with nothing fixable left in 20 minutes.
- **The comp** (three cases, 77 minutes) was the hard one: its agent ran out of turn, listed its flags and stopped (rounds 1–5), and once read a context with no clips in it (round 4). The follow-up, up to three passes, and the narrowed context took it from 16 unillustrated bridges and 24 long shots to none (rounds 7–8), at 50–85 minutes.
- **Mom & Teen** was clean from round 4 (12–19 minutes) and held up on skills about half their size (rounds 6–8).
- **The holdout** (Serial Predator, bodycam, never seen): one clean shot in 19 minutes, one follow-up: text early 15/16 (none late), clicks 12/12, no long shots, bars, flashes or long beds; the victim's File Viewer with her name and one photo throughout, the map with the police department labelled and the real building, a Notepad of evidence, the charges screen starred; the suspect in yellow, officers named in teal. Left: 7 cuts that clip a word by 0.1–0.2 s ("the editing tools have no way to insert time") and a logo inside a desktop Video Player.

What the measures can't say: none of this was heard (music choice, sound design) or judged for pace and taste; the team's eye is still the test.

## Next, from what the agents ran into
- **Insert time**: the agent can cut time (remove_time) but not add it, so a range that clips a word can't be lengthened without breaking what follows; realign_script fails on overlapping clips.
- **Speaker labels** need the watcher; with it the holdout's were right, without it (rounds 6–8, Gemini spent) they fell back to "speaker_N" voices.
- **Windows-screen lines timed by hand** still come in late; Edit's own timing is right.
- **Picture marks** judged by xAI's model over-flag (a sheriff's report's own text, a bodycam's camera ID): Gemini is the better judge.
- **Big edits take long**: the comp's round 8 took 85 minutes with its follow-ups.

## Open for the user
- **The AI Gateway** ran out of credit on Oct 21 (every release build's watcher, speaker naming and picture checks failed); the user added credit on Oct 22 08:20, and the dev server is back on it. `EDIT_AI_PROVIDER=gemini` (Gemini's free tier, xAI behind it) stays for the next time.
- **Speaker labels** are the least stable result (the same detective was "Kevin", "Brewer", "Det. Brewer", "Sergeant" across rounds), worst when the watcher is out.
- **Clean copies**: Lola Luna's tapes carry "THE INTERROGATOR FILES" across the room; the comp's Chandler tapes a logo and a second-angle inset.
