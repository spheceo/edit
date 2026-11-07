# Edit

Edit is a desktop and web application that combines all of the processes we run in our YouTube production system. We have the ideation, thumbnail, scripting, and editing phases, with more to come.

You can think of Edit as us turning tasks normally done by dozens of people into skills and agent calls. Our goal is to have a handful of people at most working in this app.

# What makes Edit special?

We have a handful of team members who love Edit and rely on it to run our most challenging work across our portoflio of YouTube Channels. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

1. Quality + Speed
The quality of our ideas, thumbnails, scripts, and videos, done at very high speeds, is what makes our application special. It has helped the team produce high-quality content much quicker and in parallel, which overall saves an enormous amount of time. We want to continue to improve on this and never lose our goal of high quality at insane speeds.

2. Reliability
Edit has been reliable, and it has to stay that way as it improves. Dev and prod should stay separate, so anything we break in dev never reaches the work people are doing in prod. We should not ship a change that breaks something else that already works, unless the request or the discussion around it makes removing that piece the sensible thing to do, even if we never say so outright.

3. Minimalism + Ease of use
Edit should stay minimal at the core, both in the code and structure of the project and in what the user actually sees. We want to be intentional about every piece we keep, especially anything that shows up on screen. If a button or toggle is something the user would have to interact with, it is usually better set for them, on or off, and taken out of their hands entirely, with us making the call depending on what it is. This even applies to things like certain UI layouts. If there's something that shows up in the UI (like a piece of text that states the obvious, or just anything, really, that displays on the UI), that adds extra thinking for the user. We want to significantly simplify this. If there are certain things that we can just not have at all in the UI and just have the user not even think about, that would be ideal. A few choices do have to stay, because projects differ, but we should still leave most of the thinking out of the user's mind. Where something would otherwise be done by hand, we should find a way to do it automatically. The aim is to make the work easier, which is what we have been doing and what we mean to keep doing.

# A note from Sphe
I like projects that push the frontier and question what most people are doing, in order to find ways to do things cheaper, better, and faster. I also care a lot about the UI: animations used intentionally, not too many, just enough where they make sense, and a screen that looks appealing.

When something needs fixing, think about whether we are patching a symptom or whether the real fix is a rewrite. Do not let a rewrite that would take days or weeks scare you off if it is the right one. It still has to be done thoughtfully.

# A small glossary
We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Edit.
- **I** means myself, Sphe, the person building Edit and the one you are talking to now.
- **we**, **us**, **users**, and **team** means the people using Edit to get work done.
- **agent** means the in-app agent a user runs inside Edit. Depending on context, that may also include you.
- **niche** means the type of content often used as a category, for example, bodycam.

# In-app agent improvement
When I hand you a project to take through Edit, pass on the team's feedback on the agent's work, ask for a trial or teaching loop, or you change anything in `agent/`, use the `in-app-agent` skill in `.agents/skills`. Its core rule is to go through Edit as a real user would and fix what breaks in the product, never by hand.

# General Rules
- Before working on the code, read `app/AGENTS.md`.
- Try not to kill a running dev server unless absolutely necessary.
- Try and have as few environment variables as possible. If something can just be hard-coded as a normal variable within the code, just do that.
- Try not to create audit reports or endless documentation content. This must be done thoughtfully. Once you no longer need something docs-related, like a plan, you can then just remove it after you're done using it.
- Try to write code or pick languages or pick frameworks within languages that allow us to have the most robust application. Meaning, it makes your job a lot easier to see where things go wrong so that they can be easily fixed.
- Never add a `Co-authored-by` trailer (Cursor, agents, or otherwise). Commit as the user only: `git add`, `git commit`, and `git push` with a normal message body — no co-authors, no extra attribution trailers.
- When you finish your work simply commit it.
- We should mainly make nightly releases but only once you get permission. Once you make the release you must watch it and let me know when it's out.
- When asked to create skills or when there is a very specific need for creating a skill for future coding agents that work on this project, place it inside of `.agents/skills` (and not in `.claude` or any other specific directory) as this will just be symlinked to there.
- Do not edit this AGENTS.md file unless explicitly given permission to do so.

# Development environment
You are most likely on our Linux machine, `mandalorian` (Ubuntu, NVIDIA RTX 4060), running inside T3 Code. That can change, but assume it unless you see otherwise.

The team mainly uses macOS, so a Mac is linked to this machine for anything Mac-specific: the native window and player, the Keychain, VideoToolbox, signing. Reach it through T3 Code's linked environments. Its tools are loaded on demand, so search for them by what they do (linked environments, delegating a task) rather than by a name that may change:
- List the linked environments to get the Mac's environment id and check that it answers.
- Delegate a task with that environment id and Edit's project on the Mac. The agent there has its own shell and works in the Mac's checkout of this repo, on whatever branch is checked out there. It starts with none of your context, so brief it fully: the goal, what is already done, the checks to run, and what not to do (no release, no killing a dev server).
- The same tools read the Mac's threads and projects, so you can see what is running there before you start.

The usual case is a feature built here that then needs doing or checking on macOS: commit and push here, have the Mac's agent rebase onto `origin` and push (never force-push), then pull here, so both machines stay on the same commits.

T3 Code can also render an HTML page inline in the chat, which is the way to show a UI prototype before building it. Its preview check, which screenshots the page first, needs the browser sandbox allowed on this machine once (`sudo env "PATH=$PATH" t3 browser setup --base-dir ~/.t3`); until then it fails on Ubuntu's AppArmor, and only the inline render works.

You may be running in a worktree. Don't create worktrees yourself; I make them. If you're not in one, work on the branch you find yourself on and commit as the rules above say. If you are, you're probably on a separate branch: commit when you're done, and once we're happy with the work we'll open a pull request.