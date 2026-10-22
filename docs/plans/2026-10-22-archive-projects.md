# Archiving Writer and Edit projects from Repack (plan, Oct 22)

The user: "on repack it would be great to have writer and edit projects managed, so we can delete footage when things arent needed… if we say need the project again footage can be downloaded/project recovered if needed, but thats just like json really but the big files like footage and exports are gone to save space month over month, and i hope both writer and edit projects are fully cloud projects."

Decided:
- **By hand, with suggestions:** Repack's dashboard lists every Edit project and Writer script, with its size and last use, and suggests archiving ones that are approved or idle for 30+ days. A member clicks Archive. Nothing is archived on its own.
- **Archive frees everything big**, files uploaded from a Mac's disk included. A restore downloads again what Drive and YouTube can give back; what they can't shows as missing.

## What an archive keeps and deletes
- **Kept:** the project or script JSON (Convex, R2 bodies), every analysis that cost money (`edit/analysis/…`: transcripts, the watcher's answers, faces and seats), review notes, and history. A restore then pays for no new hearing.
- **Deleted on R2:**
  - For each footage source the project uses, `edit/originals/…`, `edit/excerpts/…` and `edit/proxies/…`, but only for sources no other active project of either app uses (count references across `editProjects` and `writerScripts`).
  - Its review files: `edit/reviews/<id>/`, `writer/reviews/<id>/`.
  - Writer's big script files (`writer/scripts/<id>/files/…` video and audio).
- **The registry:** the rows of deleted sources (`editMedia`) are marked not ready (`originalReady`/`proxyReady` false), so the next user downloads again.
- **On each Mac** (each app does this when it hears the archive): the project's exports, its cached proxies and downloads, Writer's script folder footage. The JSON stays, so the project still lists.

## Contract (Repack's Convex; Repack's thread pushes it)
- **Archive state:** `editProjects` and `writerScripts` rows get `archived: {at, by, freedBytes} | null` and `restore: {at, by} | null`, returned by `edit:listProjects` / `edit:getProject` and `writer:listScripts` / `getScript`.
- **Members' functions:** `projectsPage:list` (both apps: title, app, last update and by whom, holder, review state, bytes on R2, archived, suggested and why), `projectsPage:archive({app, id, by})` and `projectsPage:restore({app, id, by})`. They're called by Repack's server routes, never by a relay. The server works out the keys, deletes them (it has R2's keys; Convex never does), and marks the rows and registry.
- **Apps' functions:** `edit:clearRestore({projectId})` and `writer:clearRestore({scriptId})`, once a restore has brought the footage back.

## In the apps
- **Edit:**
  - When its cloud list says a project is archived, Edit deletes its exports and cached copies here (only those no other active project here uses). The card shows "Archived" with Restore.
  - Restore (the card's button, or `restore` set on Repack) runs the script import again for its footage. Drive and YouTube download again into the registry, excerpts are cut, and the shared transcripts are reused. Media that can't come back show missing.
  - The six projects only on this Mac (Oct 15–18) go to the cloud as JSON (`edit:commitProject`, no footage backfill), so Repack lists them and can archive them. Their footage isn't uploaded only to be deleted.
- **Writer:**
  - When a script is archived, Writer deletes its local footage (keeping script.json, transcripts and the rest of the small files) and shows it archived with Restore.
  - Restore downloads again from the sources' links (registering in the shared registry as it already does).
  - Every script is fully cloud: footage from disk is registered as `sha256:` on import, not only when sent to Edit.
