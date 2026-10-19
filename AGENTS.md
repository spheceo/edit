# Agent notes

## Git commits

Never add a `Co-authored-by` trailer (Cursor, agents, or otherwise). Commit as the user only: `git add`, `git commit`, and `git push` with a normal message body — no co-authors, no extra attribution trailers.

## The repo

- `agent/` — what the agent is taught, as Markdown that people read and write: `instructions.md` (the core house style every agent gets), `skills/<name>.md` (one part of the edit each, loaded with the `skill` tool; frontmatter `description` is its line in the instructions' SKILLS list), `styles/<style>/notes.md` and `styles/<style>/skills/<name>.md` (a kind of video's own rules, and its versions of house skills), `shared/<name>.md` (taken in with `{{> name}}`). The server reads the whole folder at build time (`app/apps/server/src/agent_files.ts`, a Bun macro), so a new file is part of the build and the binary by itself, and the `skill` tool's choices follow the skill files; under `just dev`, restart the server to see an edit. Keep the team's wording and quotes: the rules were learnt edit by edit.
- `app/` — all the code and its build config (Cargo, Bun, the Justfile). **Read `app/AGENTS.md` before working on the code**: what each part does and how it's built, checked and released. The root `Justfile` forwards every recipe to `app/Justfile`, so `just dev` works from here too.
- `docs/` — plans and the team's feedback write-ups (`docs/feedback/`).
- `install.sh` and `.github/` stay at the root: installs fetch `main/install.sh`, and GitHub reads workflows only from there (they run in `app/`).

## The agent's text

Skills are the house style beyond the core (`instructions.md`, whose SKILLS list is made from each skill's `description`), loaded by the agent with the `skill` tool when it reaches that part of the edit: edit-workflow, research, intro, transitions, cut-ins, outro, subtitles, subtitle-video, music-and-sound, final-pass, feedback. There's no Full edit button: the user says "start the editing workflow" (plus any steering) in the chat, and the agent loads edit-workflow and does the whole edit in that one turn, stage by stage; loading it also starts `watch_footage` in the background. What made full edits take hours was model round trips, not tools: a conversation 200k+ tokens long (each answer several times slower; Edit's Codex threads and Claude Code sessions now compact near 150k), the agent polling slow tools second by second in Codex's code mode, and checking the same work again and again. So the developer instructions (which also carry `app/apps/server/src/mcp/reference.ts`, every tool on one line, so code mode needn't look them up), the core and the skills ask for one context read, one plan, one look per stage; keep it that way when adding rules: say what to check, never "check with render_frame". A new rule goes in the skill for its part; only what every part needs goes in the core.

## Feedback from the team

Every round of feedback on an edit (a Frame.io link, notes in chat) is a chance to make the next edit better, not just this one. For each round:

1. Read it all: `read_review` (in the app) or headless Chrome's `--dump-dom` on the share's print view (`…/share/<id>/print/comments/<asset>`, ~25 s virtual-time budget: the page is script-rendered and Frame.io's API refuses anonymous calls). Map each comment's timecode to the timeline (the export starts at frame 0) and look at what's there.
2. Find the cause, not just the moment: the same note at several times ("change the music" ×12) is one pattern. Look at the project data (shot lengths, what repeats, what the audit said) and the skill text that led the agent there; often a rule says the opposite of what the team wants.
3. For every pattern answer three questions: how do we TEACH the agent (the skill for that part in `agent/skills/` or `agent/styles/<style>/`; only what every part needs goes in `agent/instructions.md`), what CODE should change so it's right by default (a default, a mute, a background check started earlier), and what TOOL or AUDIT makes sure it can't slip through again (an `audit` kind in `app/apps/server/src/edit_plan.ts`, a tool argument, a new tool the agent was missing). Quote the team's words in the rule so the reason travels with it.
4. Write it down in `docs/feedback/<date>-<video>.md`: each pattern with its comments, cause, lesson, code and tool; the one-offs; open questions for the user.
5. Apply it to the project through the in-app agent (the `feedback` skill: read, sort, fix across the video, report each comment), with the new build, so the lesson is exercised; fix in code whatever it still gets wrong.
