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
| OpenArt | the team's account (`mamagi-openart-1`), only through the relay: `POST /v1/openart/mcp` forwards OpenArt's MCP server with the team's token (`apps/relay/src/openart.ts`); the sign-in is `OPENART_CLIENT_ID` / `OPENART_REFRESH_TOKEN` / `OPENART_ACCOUNT` in Infisical `/edit-relay` (put there by `apps/relay/scripts/openart-connect.ts`, then `push-secrets.ts --only …`), the live token pair in the BUDGET Durable Object's `openart` instance (OpenArt may hand a new refresh token with each renewal; a new sign-in in Infisical starts it over) |
| Server | `app/apps/server/src/thumbnails/` (`/api/thumbnails`, Claude's tools at `/mcp/thumbnails/<token>`) |
| Drawing | `app/packages/edit-types/src/thumbnail_render.ts`: Canvas 2D, the one drawing for the page and for Claude (the server hands it, transpiled, to a headless Chrome kept open five minutes: `thumbnails/render.ts`) |
| UI | `app/apps/web/src/thumbnails/` (`list.tsx`, `page.tsx`) |
| Craft | `agent/thumbnails/guide.md` |
| Edit's own overlays and font | `app/assets/thumbnails/` (the REC overlay, `bodycam-rec`; Montserrat, OFL) |

## A thumbnail

Layers on a 1280×720 canvas, bottom first: pictures (the thumbnail's images,
or `asset:<id>` from the library) with cover/contain/stretch, zoom and focus,
and Photoshop's few (exposure, contrast, saturation, warmth, shadows,
highlights, vignette, sharpen); text with its font, weight, size, colour, a box
behind it, a stroke; and a drop shadow on either, as Photoshop's (colour,
opacity, angle, distance, spread, size). The page edits them by hand (drag,
the corner to resize, arrows, ⌘Z) and saves them; Claude edits them through
its tools:

- `make_picture`: a picture on OpenArt from a prompt, or from pictures given
  (a base cleaned of its overlays: "sometimes our bases will have them so
  we'll need the openart agent to also remove all overlays (most of the
  time)"); the model is Claude's to pick, else the first of
  `run.PREFERRED_MODELS` the account has.
- `set_layers`, `change_layers`: the layout, drawn at once and named for Claude
  to look at; `look` (with a grid every 160×120 px for placing by eye).
- `openart_models`, `model_options`, `rename`.

Pictures dropped or pasted anywhere on the page join the thumbnail and go to
Claude with the next message. The team's own overlays are uploaded from the
page's Overlays panel with a note Claude reads (what it is, where it goes).

## Not built yet

The channel's caption styles by niche ("the text stuff depends on the
niche/channel whatever but we'll get to that later"); frames pulled from a
YouTube video here (Ideas' `scan_video` / `grab_frames`); a thumbnail started
from an idea's guide; prod (the relay's OpenArt secrets for `--env prod`, and
mamagi prod's `thumbnails` module, go out with the next nightly).
