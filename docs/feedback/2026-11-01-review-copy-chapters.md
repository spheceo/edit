# Review copies far longer than their edits, Nov 1

From the feedback thread: Kroger's review (https://feedback.spheceo.com/r/CrxgYt5LZ5w1E6fk1U0dNA) played 17 h 11 min for an 82.5-minute edit; JJ, on Predator Tutor: "it seems like everything freezes after the cut-in at around minute 3".

## Fixed on the way

- **What broke, where:** sharing, the review copy made on Modal. Every review copy made in the cloud since 68458d2b (Oct 31: exports carry chapters).
- **Root cause:** the export's chapters run to its end; `review_runtime.piece` cut `-ss start -i export -frames:v N -an`, which copies them into each piece; Debian bookworm's ffmpeg 5.1 (Modal's image) counts chapters in a piece's length, the concat demuxer offset each next piece by it, and `-c:v copy` held each piece's last frame until the export's end. Local ffmpeg 8.1 doesn't.
- **Fix:** b3448030: `piece()` and the Mac's `reviewCopyFromChunks` cut with `-map_chapters -1` (`test_review_runtime.py` fails without it); the Mac's whole-file `reviewCopy` too (3663416f/da91b003). Live on prod Modal with the next nightly (its tag runs deploy_cloud.py). The other thread's 44d91f47 refuses to publish a copy whose picture, sound and export lengths don't match.
- **Tool:** `scripts/repair-review-copies.ts` (with `review_repair.ts`): sweeps every Edit review's versions, reading each video.mp4's own index from R2; a copy longer than its edit *because frames were held* is made again from its export (meta.fullKey) with the Mac's reviewCopy and put over the same key (as a share's replace: link, number and notes stay), its size recorded, its time notes moved by the broken file's stts (inside a piece's frames the same frame, inside a held tail the end of that piece) with mamagi's new `reviews:retime` (accounts 5aadb00, deployed to dev and prod).
- **Repaired** (all checked by a fresh sweep: 28 reviews, 0 faulty):
  - Kroger Employee Follows 5-Year-Old… v1: 17 h 11 min → 1 h 22 min; its 4 time notes were inside the first piece, unmoved.
  - Predator Tutor Realizes Cops Have 21,000 Snapchat… v1, v2, v3 (JJ's): 2 h 13 min → 26:30.
  - "Helpful" Wife Has No Idea Police Are About To Arrest Her… v1: 5 h 24 min → 43 min.
  - Cops Surprise Predator Masseur… v1: 8 h 30 min → 54 min.
- **Not this fault:** Off-Duty Officer Accidentally Says Something Only The Killer Would Know v1 (Oct 29) plays as long as its export, but the export itself is 122.4 min (220,273 frames) against the edit's recorded 93.5 min: the export or the recorded length is wrong, so making the copy again changes nothing. Open.
- **On the way:** the import tests waited on the real Claude for "who says each line" (the other thread saw import_stops time out): `caption_turns.asking` is now stood in (da91b003).
