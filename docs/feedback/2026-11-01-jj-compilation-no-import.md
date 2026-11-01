# JJ's compilation that never imported, Nov 1

JJ (Discord, 4:11 PM): "For this interrogation compilation video right here, I've tried to start the script twice, and then I don't see it importing inside of the app or anything like that. Republican Chairman Realizes Cops Caught Him Meeting 17-Year-Old For Paid S*x"

## What was found

- Prod's cloud has no script, idea or project by that title (391 scripts read; the nearest is an older edit, "Predator Senator Gets Caught With 17-Year-Old Boy During Paid S*x Meetup"), so neither start got as far as a script that synced.
- His exact title imports fine on the current build (dev, two YouTube links, Interrogation): the `*` isn't it.
- A compilation's script is written to disk at once (`writer/imports.ts` `start`), so a failure inside its import leaves a "Stopped" row. Nothing at all means the request failed before that, or its failure was never shown.
- **The hole:** New project (`components/Home.tsx` `create`) waited 1.5 s for a refusal, then closed with "importing its footage, then writing the script" and dropped any later failure (`work.catch(() => {})`). A busy Mac (Mathias's was running two 6–7 h imports that afternoon) can take longer than that to answer, so a refusal then was never seen.

## Fixed on the way

- A refusal that comes after New project has closed is said as an error toast ("Couldn't start “…”: …"), never dropped. Script mode's own import dialog already waits for the import to show and says its failures.

## Open

- The real refusal on JJ's Mac isn't known: his Mac couldn't be reached (remote support, now always on, ships with the next nightly). After he updates: try once more; the error now shows, or pull his report with `edit remote diagnostics`.
