# Ideas

Repackaging in Edit (Oct 31 2026): a case (a YouTube video, an article)
turned into 3–5 titles and a thumbnail guide, then sent to its board as a
card. Two kinds (workspaces), chosen in New idea: **Interrogation** (the
Interrogation board) and **Bodycam** (Nov 1: the Raw Channels board). It runs on
each person's own Claude Code (Opus 5.5), so the team's subscriptions pay
instead of the AI gateway.

The craft is Repack's Interrogation teachings word for word (Nov 1, the
user: "replicate the interrogation teachings… that we have on the Repack
websites"; it was Sphe Research's on Oct 31): its title guide, thread-chat
rules, thumbnail editorial guide with its base inspection, and case summary.
Bodycam is the same teachings adapted only where the encounter on camera
differs from the room (the user: "the closest we're looking for is
interrogation, but with bodycam, it just adapts some of those parts"; Sphe
Research's own bodycam craft was "too far gone").

## Who

`ideas.interrogation` and `ideas.bodycam` in Edit's manifest (group "Ideas",
preset "Repackager", in "Everything"): an admin grants them at
accounts.spheceo.com. Without either the section isn't there, the server
answers 403 and the relay refuses `/v1/ideas/*` and `edit/ideas/` keys; with
one, the person sees and makes only that kind, and the relay answers only
that board. An admin has it all.

## Where things are

| Part | Where |
| --- | --- |
| The ideas | mamagi's Convex, `ideas` module (`accounts/convex/ideas.ts`): one row an idea, its whole body, rev by rev |
| Their pictures | R2 under `edit/ideas/<idea>/` (uploads); a video's thumbnail and the card's pictures by their URL |
| Relay | `app/apps/relay/src/ideas.ts`: the Convex calls, YouTube's details, the board |
| Server | `app/apps/server/src/ideas/` (`/api/ideas`, Claude's tools at `/mcp/ideas/<token>`) |
| UI | Home's Ideas section (`/ideas`: Drafts and On the board in Home's sidebar, the rows `apps/web/src/ideas/home.tsx`; one waiting on someone is in Needs you too), the idea page (`/ideas/<id>`, `page.tsx`): Sphe Research's case on the left (its header and Titles / Thumbnail guide / Case form, word for word in look; no list of threads beside it), the editor's own chat on the right (`AgentPanel`'s `ChatTurns` and `ChatComposer`) |
| Craft | `agent/ideas/interrogation.md` (Repack's), `agent/ideas/bodycam.md` (adapted); the style examples are the board's approved titles, read live |
| Types | `@edit/types/ideas` |

Nothing of an idea is kept only on one Mac: every change reads the idea, makes
the change and commits it naming the rev it began from; overtaken, it's made
again on top (`ideas/cloud.ts`).

## A repackaging

1. **New idea**: links, one a line (YouTube or an article), an optional angle,
   a summary or not, a footage folder. One idea a link. A case that is
   already someone's idea is refused with a link to it.
2. **Read in code, before Claude** (`ideas/run.ts` `prepare`, one prompt, no
   fetching round trips):
   - the video's details from the YouTube Data API on the relay (its key,
     `YOUTUBE_API_KEY`, never leaves it), with Sphe Research's outlier score;
   - the board: a video already on any card (archived ones too) stops here:
     the person chooses **Improve it** (Claude treats that card's title as the
     bad version) or leaves it;
   - the captions, through the YouTube proxy only, never from the Mac's own
     address (the user: "try not to do research locally to not risk ip
     bans"), kept where Edit's imports find them
     (`cache/youtube-captions/<id>/`). No English captions: skipped (titles
     come from the transcript, never the title alone);
   - an article, read as Script mode reads one;
   - the titles the team approved (every list from Approved on, read live):
     the closest to this case first (Sphe Research's ranking), then the most
     recent, and the length they run (Repack's `titleLengthStyle`);
   - the case's thumbnail and the closest approved cards' covers, which
     Claude may look at and take one of as the guide's base.
3. **Claude writes through tools** that check and save at once
   (`ideas/policy.ts`): never "suicide", no dash splitting a title, no quoted
   spoken line, no longer than the approved titles run, one title never
   twice; the guide one lowercase note naming people by role; the summary one
   sentence of 30 words or fewer. A refusal says why and Claude fixes it in
   the same turn. A run is done with 3–5 titles and the guide.
4. Three runs at a time on a Mac. What someone wrote by hand (a title, the
   guide) stays on a fresh run. A run cut off by a restart is marked stopped.

The page's conversation runs the same way: "another angle", "drop the dad
one", "make the dress title the main one".

## The board

`BOARDS` in `relay/src/ideas.ts` names each board's lists and labels by id:
Interrogation's (read Oct 31) and bodycam's Raw Channels (read Nov 1: ideas go
to "Ideas - Sphe"; its approved titles are Ted's and Sams's channels from
Ready for script to uploaded, listed by id, as the board also carries other
channels and footage sourcing; its changes labels are "Sphe changes required"
and "Changes made"). Edit writes only:

- a card in a **lane**: Repackaging (Sphe), Repackaging (JJ), Sphe - Draft
  Ideas Ready For Check, each list checked to still be that open list first;
- a card **waiting on changes** ("Changes required" without "Changes Made").

**Send to Trello** checks the board again (it fails closed: a video someone
put there since stops it, unless the person ticks "send a second card"), then
makes the card at the top of the lane: named by the main (starred) title,
Titles / Thumbnail Guide / Case / Footage as the board writes them, the
pictures uploaded (the first is the cover) and written into the description.
A send tried again finishes the card it began.

**Changes**: a card in a lane labelled "Changes required" shows in Home's
Needs you and On the board (its idea's, or the card alone; opening it makes an idea from it, its
titles, guide, links and pictures read from the description). The comments
are the brief: **Make these changes**, then **Update the card**, which writes
it back and adds "Changes Made" beside the card's labels.

**Approved**: an idea's card in a list from Approved on shows as approved, and
**Write the script** opens New project with its title and case links.

## Tried

Oct 31, live against the relay, mamagi and the board: a case repackaged in
75 s (the captions through the proxy took 50), a chat turn, sent to
Repackaging (Sphe), changes asked for on the card, made by Claude and written
back with Changes Made, a hand-written Ready For Check card opened as an idea;
the UI driven end to end in Chrome. The test card was deleted.

Not built yet: research (no crawling: an idea starts from a link), pushing
later at a set time, a second workspace.
