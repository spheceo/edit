# Thumbnails

Thumb (`code/thumb`, thumb.spheceo.com) brought into Edit, Nov 2 2026. Sphe:
"have a conversation with the agent to have a thumbnail generated (claude gets
drafts and stuff generated on openart via mcp)"; "the ability to add our
overlays and work with photoshop type stuff like editing exposure and
saturation etc."; "text overlays and stuff and control the dropshadow spread
ETC. like basically bringing photoshop to it but only have features we
need/use"; "instead of allowing us to add our own openart accounts, the team
shares one team account". Two reasons to have it in Edit, as with Ideas:
Claude on the person's own subscription, and frames pulled on the Mac.

## Who

The same people as ideas (an `ideas.*` capability, or an admin): Home's
Thumbnails (a tab beside Ideas on the classic Home, an entry under Ideas in the
sidebar), `/thumbnails` and `/thumbnails/<id>`.

## Where things are

| Part | Where |
| --- | --- |
| The thumbnails | mamagi's Convex, `thumbnails` module (`accounts/convex/thumbnails.ts`): one row a thumbnail, its whole body, rev by rev as ideas are; the team's overlays are `thumbnailAssets` |
| Their pictures | R2 under `edit/thumbnails/<id>/`; the team's overlays under `edit/thumbnails/assets/`; kept on the Mac in `<cache>/thumbnails/` after the first look |
| OpenArt | the team's accounts, listed in code (`ACCOUNTS` in `app/apps/server/src/thumbnails/openart.ts`: id, name, relay route; never the person's own), the one in use per Mac in `<home>/openart-account.json` (the page's account menu; the first until another is picked). Today one, `mamagi-openart-1`, only through the relay: `POST /v1/openart/mcp` forwards OpenArt's MCP server with the team's token (`apps/relay/src/openart.ts`); the sign-in is `OPENART_CLIENT_ID` / `OPENART_REFRESH_TOKEN` / `OPENART_ACCOUNT` in Infisical `/edit-relay` (put there by `apps/relay/scripts/openart-connect.ts`, then `push-secrets.ts --only …`), the live token pair in the BUDGET Durable Object's `openart` instance (OpenArt hands a new refresh token with each renewal and revokes the old; a new sign-in in Infisical starts it over). One sign-in for dev and prod (Sphe, Nov 2): only the live relay holds it; the dev relay forwards to it (`OPENART_UPSTREAM` in wrangler's `[env.dev.vars]`, `OPENART_RELAY_TOKEN` the same in both environments' Infisical) |
| Server | `app/apps/server/src/thumbnails/` (`/api/thumbnails`, Claude's tools at `/mcp/thumbnails/<token>`) |
| Drawing | `app/packages/edit-types/src/thumbnail_render.ts`: Canvas 2D, the one drawing for the page and for Claude (the server hands it, transpiled, to a headless Chrome kept open five minutes: `thumbnails/render.ts`) |
| UI | `app/apps/web/src/thumbnails/` (`list.tsx`, `page.tsx`) |
| Craft | `agent/thumbnails/guide.md` |
| Edit's own overlays and fonts | `app/assets/thumbnails/` (the REC overlay, `bodycam-rec`; Arabic-font-2013 for white and red, ITC Avant Garde Gothic Bold for a black box, Montserrat) |

## A thumbnail

Layers on a 1280×720 canvas, bottom first: pictures (the thumbnail's images,
or `asset:<id>` from the library) with cover/contain/stretch, zoom and focus,
and Photoshop's few (exposure, contrast, saturation, warmth, shadows,
highlights, vignette, sharpen); text in lower case unless asked otherwise, with
its font, weight, size, colour, a box behind it, a stroke when one is asked
for; and a drop shadow on either, as Photoshop's (colour, opacity, angle,
distance, spread, size). White and red is Arabic-font-2013 with no stroke and
the house shadow (opacity 100, spread 36, size 32, angle 90). A black box is ITC Avant
Garde Gothic Bold. The page has no controls of its own (Sphe, Nov 4: "give
more of that to the agents on the right and then have the user just chat with
it"): no layers, pictures or overlays panels, no Camera Raw, no dragging. The
person asks; Claude changes it through its tools:

- `make_picture`: a picture on OpenArt from a prompt, or from pictures given
  (a base cleaned of its overlays: "sometimes our bases will have them so
  we'll need the openart agent to also remove all overlays (most of the
  time)"); the model is Claude's to pick, else the first of
  `run.PREFERRED_MODELS` the account has.
- `set_layers`, `change_layers`: the layout, drawn at once and named for Claude
  to look at; `look` (with a grid every 160×120 px for placing by eye).
- `undo`, `redo`: back or forward on the layout's timeline (below).
- `new_version`, `switch_version`, `take_final`, `remove_version`: versions
  (below).
- `compare`: two to four pictures or versions side by side, the same area of
  each blown up and labelled, so an edit is checked against what it had to
  keep (the guide's "Getting a picture edit right": the reference, what must
  hold and change, made from the reference, compared close, up to three tries,
  a comment settled only when the comparison shows it done).
- `comments`, `look_at_comment`, `reply_to_comment`, `settle_comment`,
  `remove_comment`: comments (below).
- `cut_out`: a picture's subject lifted out exactly (the engine's
  `subjectCutout`: Vision's foreground instances on the Mac, half a second, no
  credits), added to the pictures as a transparent PNG at the picture's size,
  to lay over another base instead of OpenArt redrawing him.
- `save_overlay`: a picture the person gave, into the team's library with a
  note on where it goes, when they ask to keep it.
- `openart_models`, `model_options`, `rename`.

Undo is one timeline for both (Sphe, Nov 2: "we should have undo both for us
and for the agent"): every change to the layout keeps the layout before it on the thumbnail
(`history`, the last 40, each with who and what: "changed “She smiled”"), and
Claude steps back and forward through it with `undo` / `redo`, the recent
changes in its message ("undo the last change"). The page has no undo of its
own (Sphe, Nov 4: "the agents can undo and redo on their own"). A new change
drops what redo had.

Pictures dropped or pasted anywhere on the page join the thumbnail and go to
Claude with the next message.

Versions: one until the person asks for another or for options (each draft is
a version). Once there are two, they sit side by side under the canvas, each
drawn as it stands: a click shows one at once, from the layouts and drawings
the page already has, the server told behind it (the list's picture is drawn
again by the server). The view is the person's: while Claude works, a click
moves only their page, the version Claude is on lit on its tile (the canvas lit
only when it's the one shown); left alone the page follows Claude, and a
message carries the version being looked at, which its turn starts on. Claude
looks at or compares other versions without switching. And the one that ships is marked Final on its tile ("Make final" on
hover) or by asking Claude. Claude removes one when asked: the ones after it
move down a number (Sphe, Nov 4: "if version 1 is removed, version 2 becomes
version 1"), what showed or was final passes to a neighbour, and down to one
the thumbnail has no versions again.

Comments (Sphe, Nov 4: "our cursor sort of takes on that comment tool, and we
can click on areas in the image… The agents would then be able to see that
specific area"): the header's Comment (or C) makes the cursor a pin; a click
leaves a numbered comment on that spot of the version showing (`comments` on
the thumbnail: where, words, who, which version). There's no queue and no
special prompt: every turn's message lists the open ones with a drawing of
their pins, and Claude does them with whatever is asked, `look_at_comment`
showing it the area close. Only those on the version showing are its to do unasked; those on other
versions it mentions and asks about (Sphe, Nov 4: "it can ask you, there are
comments in this other V as well, can I implement those?"). Anyone removes a
comment from its card (the bin, on hover or open) or with Delete once it's
open; Claude removes one only when asked. Comments pinned while it works reach it too: each
layout change ends with the ones on that version it hasn't settled or
answered, and it runs `comments` before it finishes a turn that changed
anything. Done and looked at, it settles one (kept, off the
page); one it can't quite do it answers under the comment and says so in the
chat. A version's tile counts its open ones; a removed version's are settled
with it.

The header is the way back, the name, Comment, the OpenArt account and Download; a
thumbnail is deleted from the list (its ⋯ on hover, or a right click).

Credits: the header's account button shows the account in use and its credits
(amber under twenty pictures' worth, red under one); its panel lists the
team's accounts, what a picture costs on the house's model and about how many
that leaves, and what this thumbnail has spent (each picture keeps its cost
and account from Nov 4 on). A second account is a line in `ACCOUNTS` plus its
sign-in on the relay at its own route.

## Not built yet

The channel's caption styles by niche ("the text stuff depends on the
niche/channel whatever but we'll get to that later"); frames pulled from a
YouTube video here (Ideas' `scan_video` / `grab_frames`); a thumbnail started
from an idea's guide.
