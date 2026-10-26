# Caption-first YouTube transcription

Edit's media processor now tries the original video's word-timed English
automatic captions before sending audio to ElevenLabs. A previously cached local
or shared transcript still wins; it is never discarded to repeat work.

`app/apps/server/src/youtube_captions.ts` fetches `en-orig` JSON3 with the same
yt-dlp installation used for footage. It caches one transcript per original video,
deduplicates concurrent requests, and temporarily caches unavailable results so
each excerpt does not repeat the lookup. The fetch has a two-minute deadline and
does not download video. Missing, inaccessible or line-only captions fall back
to Edit's existing cached, resumable speech-transcription path.

Caption transcripts retain `model: "youtube-captions"`. Their speaker IDs are
caption turns, not claims that a particular person spoke. Existing watch/subject
and speaker correction still runs on the transcript afterwards. Name enrichment
does not send captioned footage back through paid speech recognition. Names and
identity must be corrected from evidence by the normal agent/watch stages.

Cloud provenance supplies the original source and excerpt offset. For local
script footage, saved script blocks supply the original YouTube ID and
`media_start`; conflicting provenance is refused rather than guessed from a
filename. Caption times are cropped and shifted onto that excerpt's clock.
Joined folder masters are not falsely mapped to one YouTube video.

Validation is offline: fake yt-dlp output, the existing in-memory relay, and real
FFmpeg for the missing-caption fallback test. Coverage includes caption turns,
silence, line-only rejection, concurrent excerpts and caching, source clocks,
the existing subject watcher's person reconciliation, normal Scribe fallback and
completed-transcript reuse. No paid request or production import was made.

Writer's corresponding all-format expansion is documented separately in its
`docs/caption-first-expansion.md`; it extends the already-present courtroom
caption/turn implementation to compilation, interrogation and bodycam sources.
Neither app was released or deployed by this change. Live YouTube availability
and project-level visual subject accuracy still require normal review.
