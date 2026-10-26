# Exports across projects

The export activity button sits near the top right of Edit on both Home and the
editor. Closing Share or opening another project keeps jobs visible there. It
shows how many are exporting and queued, with per-project progress, cancellation,
failures, recent completion and downloads. The activity can be recovered by a
page reload or reconnect; it does not depend on having observed a project's
websocket events. Signed-out screens hide it.

An export for another project is accepted immediately. Local exports run FIFO,
one renderer at a time; queued jobs are explicitly labeled. Each native renderer
owns three decoder workers, a 48-frame lookahead and three GPU readback buffers,
so accepting jobs does not allocate another full renderer or compete with the
editor for those resources. Cloud/Modal exports keep their existing concurrency
and routing policy; this change enables no new paid backend. Uploading a finished
file to the archive does not occupy the local renderer's slot.

Every accepted queued export keeps its own immutable project/options and the
existing durable jobs entry plus timeline snapshot. Edits made while it waits
cannot change what exports, and startup resumes the queued snapshots. Failure or
cancellation releases the queue; cancelling a waiting job removes it immediately
without rendering it. One job per project and one writer per output path remain
enforced. A snapshot that cannot be saved now refuses the export rather than
accepting a job that could restart with a different edit.

Code: `apps/server/src/exports.ts`, the `GET /api/exports/activity` route and
`apps/web/src/components/ExportActivity.tsx`. Activity is filtered to projects the
current person may see. Recent outcomes are limited to 20 per server session;
finished export files retain their existing persistent per-project export list.

Verification covers multiple project jobs, waiting-job cancellation, failure
advancing the queue, immutable inputs/options, durable restart snapshots, global
activity retrieval and existing export/download/cancellation behavior. Tests use
an in-memory export worker and local files; no user project was exported and no
paid render was run. The web typecheck, test suite and production build passed.
