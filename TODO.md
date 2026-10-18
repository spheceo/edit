# To do

Ideas and next steps that aren't started yet. Newest at the top.

## Exports streamed straight to R2 (discuss again before implementing)

**Not decided: talk it through again before any work starts.** The idea: an export uses as little of this Mac's disk as possible. A 2h35m export needed ~8 GB of chunks in the cache and the file itself, and the internal disk had 2.8 GB free (Oct 18).

- Upload each chunk to R2 as it's encoded, as one part of a single multipart upload, and delete it here straight away: only a chunk or two on the disk at a time.
- Chunks encoded as fragmented MP4 (one shared init segment, then self-contained fragments), so the parts laid end to end are a playable file and R2 puts the export together with no local copy; today's join needs an ordinary MP4, whose index is written after all the video.
- The sound mixed first, as now (small: ~150 MB for 2.5 hours), and muxed into each chunk's fragments.
- The export list points at the R2 file; the browser downloads it through a presigned URL, and a re-export reuses unchanged chunks from R2.
- To weigh: fragmented MP4 plays in browsers, YouTube and Premiere but some old players handle it less well; the Mac's upload speed becomes part of the export's time; it's a sizeable change to the export pipeline (`render.rs`, `chunks.rs`, `exports.ts`, `cloud_media.ts`) and needs careful testing.

## Home screen: group projects by channel

Separate the projects on the home screen by the channel each video is for, so each channel's work is together.

- A project needs to know its channel. Today nothing records it: it could be picked when a project is created (beside its style), or come from the script Doc.
- The home screen would then show a section per channel (or a channel filter beside All / Edits / Subtitled videos and the styles), each with its own Continue and edits.
- Open questions: the list of channels and where it's kept (the cloud, so every Mac shares it), and what a project with no channel shows under.
