# Rewrite plan: `crates/edit` → `apps/server` (Bun) + `crates/edit-native` (napi-rs)

Status: proposal. Line references are to `crates/edit/src/*` at `b5d8751` unless noted.

## 0. Summary of decisions

| Decision | Choice |
|---|---|
| Rust that stays | A new rlib `crates/edit-engine` holds the staying modules. `crates/edit-native` is a thin napi-rs (v3) `cdylib` over it: the one `.node` addon. Phase 0 makes `crates/edit` depend on `edit-engine`, so the Rust server keeps working (and stays the parity reference) while the compiler proves the boundary is clean. |
| Project types for TS | `ts-rs` (serde-compat) on `edit-core` and the `edit-engine` option types, behind a `ts` feature, generated into `packages/edit-types/src/generated/`. This replaces the hand-written `apps/web/src/lib/types.ts`, which becomes a re-export plus UI-only extras. |
| Who writes project bytes | Rust. Every TS commit goes through `native.projectCommit`: validate, then serialize with `serde_json::to_vec_pretty` exactly as `store.rs:477` does today. This keeps the files byte-identical, rounds f32 fields the same way, and fills serde defaults. |
| Cache keys | Rust only (`mediaKey` / `keyOf`). TS never re-implements the hash. |
| Desktop window | `crates/edit-window`: today's `app.rs::run` as a Tauri helper, embedded in `edit` and extracted to `<home>/bin/Edit`. That file name also gives the "Edit" Dock name without today's hard-link-and-exec trick. |
| Archive layout | Unchanged: `edit`, `edit-ffmpeg`, `edit-ffprobe`. Old Rust updaters (`update.rs:313-322`) and `install.sh` only copy those three, so the addon, window helper and web dist are embedded in `edit`. |
| MCP | Hand-ported JSON-RPC (it's plain POST, `mcp.rs:84-169`). `tools/list` is dumped from the Rust server into `apps/server/src/mcp/tools.json`, so schemas match by construction. |

## 1. Native addon API

### 1.1 Crate layout

```
crates/edit-core      unchanged (+ optional `ts` feature: #[derive(TS)])
crates/edit-render    unchanged
crates/edit-wasm      unchanged
crates/edit-engine    NEW rlib; git mv from crates/edit/src:
                        render.rs export.rs mix.rs loudness.rs track.rs motion.rs censor.rs
                        mac_media.rs mac_media.m (+ build.rs cc/framework linking)
                        faces.rs  -> only detect/look/cached/lock_for (faces.rs:30-180, 579-584)
                        desktop.rs -> only Canvas/wallpaper/window/files (desktop.rs:115-600)
                        seats.rs  -> only levelled/distance/scenes (seats.rs:234-307)
                        media.rs  -> probe, key_of/media_key, light_preview, make_proxy, native_proxy,
                                     make_light, make_cloud_proxy, preview_from_cloud_proxy,
                                     make_image_thumbs, make_peaks, foreground()/yield_to_foreground
                        util.rs   -> copies of tools.rs (ffmpeg paths, url_args, protocols, is_url,
                                     media_cache), store::write_atomic/now_ms, guard::catch,
                                     media_drive::Layout::key_path (just the strip_prefix part)
                        log.rs    -> diag shim (info/warn/error/record/time_on/human) that forwards to a sink
crates/edit-native    NEW cdylib (napi = "3", features napi8 + tokio_rt + serde-json); bindings only
crates/edit-window    NEW Tauri bin (app.rs::run + open_in_browser + tauri.conf.json + icons)
crates/edit           Rust server during the port, depending on edit-engine; deleted at the end
```

Why two crates: a napi `cdylib` can't also be linked into a normal binary (napi symbols are undefined outside a Node/Bun host). `edit-engine` stays testable with plain `cargo test` (render tests, `matches_ffmpeg_ebur128`, mix, track, motion, censor, mac_media tests all move with it).

### 1.2 Conventions for every native call

- **Errors.** `Result<T, String>` becomes a rejected Promise or a thrown `Error` with the same message text. Agents see these strings, so the text is part of the contract.
- **Panics.** Every entry point is wrapped in `guard::catch` / `#[napi(catch_unwind)]` and becomes `"<what> crashed (...); this is a bug in Edit"`. Keep `panic = "unwind"` in every profile.
- **Threading classes:**
  - **S** (sync): microseconds to a few ms. Allowed inside a TS `store.update` closure, which must stay synchronous to remain atomic.
  - **A** (async): a napi-rs `async fn` on napi's tokio runtime with `spawn_blocking`. Never use `AsyncTask`/libuv for multi-minute jobs; it would starve Bun's work pool.
  - **T** (long-running, with progress or log callbacks): a `ThreadsafeFunction`, called `NonBlocking` and unref'd so it never keeps the process alive.
  - **BG** (fire-and-forget): background native threads, as today.
- **Logging.** `init({log})` registers a TSFN sink. Native code never writes `~/.edit/logs/edit.log` itself. TS `diag` writes the line, keeps timings and runs `cloud_media::scrub` (`cloud_media.rs:253`) over native lines, because native errors can contain presigned URLs (e.g. `media.rs:968`).
- **Project inputs.** `type ProjectInput = { ref: { id: string; rev: number } } | { json: string }`. `projectCommit` caches the parsed `Project` per (id, rev) (last 2 revs, at most 16 projects). Renders, censor checks and plans pass `ref`. A miss throws `"stale project"`, and TS re-sends it as `json`. Exports pass `json`, because `cloud_media::for_export` rewrites paths.
- **Rich types** (Project, Media, ExportOptions, Keyframe, Sections, Rippled) cross the boundary as JSON strings or serde values typed by ts-rs. Small boundary structs are `#[napi(object)]`, and napi-rs generates their `index.d.ts`. `apps/server/src/native/index.ts` wraps the raw addon with precise types.

### 1.3 API (JS-facing), what it replaces, and who calls it

#### Lifecycle and process

```ts
init(c: { home: string; cacheDir: string; ffmpeg: string; ffprobe: string;
          mediaFolders: string[];            // media_drive Layout.known, used by key_path
          log: (l: NativeLog) => void }): void                                    // S
setMediaFolders(known: string[]): void      // store.rs:138 publish_layout, :145 set_media_dir  S
shutdown(): void                            // stops the FrameRenderer thread, cancels exports   S
holdLock(path: string): boolean             // media_drive.rs:860-880 (flock via File::try_lock) S
isLocked(path: string): boolean             // media_drive.rs:900                                S
reexec(exe: string, args: string[]): never  // update.rs:283 restart(); sets FD_CLOEXEC on fds>2,
                                            // then execv, so listeners close as today           S
type NativeLog = { level: "info"|"warn"|"error"; area: string; message: string }
               | { timing: true; area: string; name: string; ms: number; failure?: string };
```

#### Cache keys

```ts
mediaKey(path: string): string           // media.rs:213. Callers: broll.rs:276, cloud_media.rs:1137,1140,1482,
                                         // library.rs:516, script.rs:1251, tools.rs:55, watch.rs:720,1587,2021,2040   S
keyOf(name: string, file: string): string  // media.rs:218. Callers: media_drive.rs:1152,1167,1288,1343            S
mediaCache(path: string): string | null    // tools.rs:54 (used by faces, seats, watch, track)                     S
lightPreview(source: string): string | null // media.rs:594                                                         S
```

#### edit-core: what the TS server needs

```ts
projectLoad(json: string): { json: string; problem?: string }       // store.rs:286 load + validate + serde defaults   S
projectValidate(json: string): string | null                         // Project::validate (model.rs:1616); store.rs:320-432, edit_plan.rs:103   S
projectCommit(id: string, rev: number, json: string): { pretty: string; json: string }
       // validate + to_vec_pretty (store.rs:417-490); caches the ref; TS writes `pretty`, re-parses `json`   S (measure on large projects)
removeTime(p: ProjectInput, start: number, end: number): { json: string; rippled: Rippled }   // mcp.rs:1953, voiceover.rs:585   S
speedSpanHolding(p: ProjectInput, start: number, end: number, speed: number, hold: string[]): { json: string; rippled: Rippled }  // voiceover.rs:698   S
sections(p: ProjectInput): Sections                                  // mcp.rs:924, mcp.rs:2496, captions.rs:562       S
animatableParams(): Record<string, string[]>                         // model.rs:1394; edit_plan.rs:283, mcp.rs:1206   S (call once, cache)
sampleKeyframes(keys: Keyframe[], frames: number[]): (number|null)[]  // eval.rs:503, used only by parity tests       S
```

Port to TS rather than call per item, then pin each with a parity test against native:
- `edit_core::sample` / `ease` / `segment_handles` (eval.rs:503-600). They run in tight loops (captions.rs:1647, 2249; faces.rs:797).
- `Project::fresh_id` / `add_track` / `subtitles_track` / `track_label` / `in_out` / `subtitled_spans` / `duration` / `fps`, and `Clip::end` / `contains` / `marks_cut` / `media_id` (model.rs:338-1610).
- `is_date_card`, `Media::is_sound_effect` (sections.rs:262, 283), `mute_gain`.

`evaluate` and `audio_segments` aren't called by any moving module. Only render.rs and mix.rs use them, so they stay internal.

#### Probing and preview making (media.rs)

```ts
probe(path: string): Promise<Probe>         // media.rs:86 (ImageIO for images, ffprobe otherwise).
                                            // Callers: server.rs:1020,1099; cloud_media.rs:281,796,2006,2094; broll.rs:367,1372; voice.rs:454   A
imageSize(path: string): Promise<[number, number]>   // mac_media.rs:133                                   A
makePreview(j: { source: string; probe: Probe; paths: CachePaths; fromCloudProxy: boolean },
            onProgress: (p: number) => void): Promise<void>
       // media.rs:677 make_proxy / :974 preview_from_cloud_proxy (fromCloudProxy = cloud_media::is_local_copy, media.rs:456)   T
makeLightPreview(source: string, paths: CachePaths, probe: Probe): Promise<void>   // media.rs:604          A
makeImageThumbs(source: string, paths: CachePaths): Promise<number>               // media.rs:1097 (ImageIO)  A
makePeaks(source: string, out: string): Promise<void>                             // media.rs:1193 (hot loop over PCM)   A
makeCloudProxy(source: string, probe: Probe, out: string): Promise<void>          // media.rs:857; cloud_media.rs:356,720   A
cloudProxyBitrate(w: number, h: number): number                                   // media.rs:844; cloud_media.rs:1685      S
```

The FFmpeg-only thumbnail strip `make_thumbs` (media.rs:1125) moves to TS. The scheduler (`Processor`, statuses, `background_slots` and the IMAGES semaphore, media.rs:25-528) also moves to TS. The `foreground()` counter that pauses previews while an export runs stays native: both the export and the preview loops live there.

#### Rendering and images (render.rs)

```ts
renderFrames(r: { project: ProjectInput; frames: number[]; maxSide: number; priority: "ui"|"agent";
                  encode: "png"|"agent"; sheetColumns?: number }): Promise<EncodedImage[]>
       // FrameRenderer::render / render_for_agent (render.rs:662/672) + tile (:1005) + encode_png (:1043) / encode_for_agent (:1060).
       // Callers: server.rs:1699-1706 (frame png), mcp.rs:2295-2303 (render_frame), :2324-2339 (contact_sheet), :2412-2419 (with_review)
       // Keeps today's queue limits: agent 16 / ui 8, "renderer busy; try again shortly"                          A (own GPU thread, oneshot)
mediaFrames(r: { media: Media; start: number; end: number; count: number; maxSide: number;
                 sheetColumns: number; encode: "agent" }): Promise<{ image: EncodedImage; times: number[] }>
       // render.rs:851 via broll.rs:121-128; mcp.rs:1827-1832 (look_at_media)                                   A
saveStill(media: Media, time: number, out: string): Promise<void>   // render.rs:902; mcp.rs:1275               A
composeSheet(images: RawImage[], columns: number, encode: "png"|"agent"): Promise<EncodedImage>
       // tile + encode for research thumbnails (research.rs:541-565 FFmpeg raw RGBA; mcp.rs:1617-1633)          A
bundledFont(file: string): Buffer | null    // edit_render::text::bundled_font_bytes; server.rs:2008              S
SHEET_CELL = 360                            // render.rs:1084; mcp.rs:2330, 2415
type EncodedImage = { data: Buffer; mime: "image/png"|"image/jpeg"; width: number; height: number };
type RawImage = { width: number; height: number; pixels: Buffer };   // RGBA
```

MCP image content (`render::image_content`, render.rs:1075) becomes TS `Buffer.toString("base64")`. Pixels never cross the boundary except research thumbnails.

#### Export (export.rs, render.rs:1090-1600, mix.rs)

```ts
exportDefaults(): ExportOptions                         // export.rs:122 (hardware = cfg!(macos))          S
exportPlan(p: ProjectInput, o: ExportOptions):
  { plan: Plan; fps: number }                           // render.rs:1144-1156: duration>0, validate, plan(),
                                                        // heard_segments → plan.audio=false, codec_args check   S
withExtension(path: string, f: Format): string          // export.rs:144; render.rs:1157                     S
encoders(): Promise<Encoders>                           // export.rs:522; server.rs:1794-1796                A
class ExportJob {
  static start(j: { project: { json: string }; options: ExportOptions; plan: Plan; output: string; cacheDir: string },
               onProgress: (p: number) => void): ExportJob
       // render.rs:1220-1250 (+ export() :1327-…): holds foreground(), mixes sound (mix::parts/render),
       // runs the picture pipeline, joins with FFmpeg, writes ".<pid>-<id>.partial.<ext>" and renames onto `output`   T
  cancel(): void                                        // render.rs:1125 (AtomicBool)
  wait(): Promise<{ seconds: number; bytes: number }>   // rejects "cancelled" on cancel
}
```

Moves to TS: the `Exports` registry (`exported`, `running`, `finished` list of 50, one export at a time, "would overwrite source footage"), `drive::wanted`/`start`, `cloud_media::for_export`, the `export` websocket events, and the `default_export_path`/`expand_home` routes (server.rs:1715-1790; mcp.rs:2349-2380).

#### Sound measurement (loudness.rs)

```ts
loudnessSpans(path: string, spans: { from: number; seconds: number }[]):
  Promise<{ integrated: number; loudest: number; peak: number }[]>
       // loudness::blocks + Blocks::span (loudness.rs:57,190); library.rs:427-445 levels/span_levels   A (first call decodes; then µs)
loudestMoment(path: string): Promise<number>           // loudness.rs:271; library.rs:551            A
loudnessPrepare(paths: string[]): Promise<void>        // loudness.rs:140; library.rs:529, mcp.rs:1786   A (3 at a time)
loudnessWarm(path: string): void                       // loudness.rs:162; server.rs:1145, 1204         BG
```

`library::levels`/`loudness`/`gain_to`/`footage_loudness` (library.rs:415-545) move to TS on top of `loudnessSpans`.

#### Analysis (track.rs, motion.rs, faces.rs, censor.rs, seats.rs, desktop.rs)

```ts
trackAnchors(r: { path: string; size: [number, number]; fps: number; from: number; to: number;
                  anchors: { at: number; region: [number, number, number, number] }[] }):
  Promise<{ samples: { time: number; x: number; y: number }[]; lost: [number, number][]; cuts: number[] }>
       // track.rs:112 (frames kept in native memory, 180 s / 256 MiB); captions.rs:1979-2112   A (up to MAX_SPAN 180 s of source)
facesDetect(source: string, size: [number, number], indexes: number[]): Promise<Record<number, Box[]>>
       // faces.rs:70 detect (Vision, faces-v1.json, one per file); captions.rs:1562, faces.rs:470   A (a minute or two on first run)
facesCached(source: string): Record<number, Box[]> | null   // faces.rs:579; faces.rs:784 (text_on_faces)   S
FACES_RATE = 2.0                                            // faces.rs:36
censorIssues(p: ProjectInput, start: boolean): { issues: unknown[]; pending: string[] }
       // censor.rs:173 (starts analyse_in_background :102 when start); mcp.rs:2451   S (+BG)
seatsScenes(gray64x36: Buffer): { scenes: [number, number, number | null][]; angles: number }
       // seats.rs:246 (TS runs the FFmpeg read of seats.rs:195-232, incl. watch::keyframes_close)   A
desktopFiles(width: number, height: number, photoTitle: string, notepadTitle: string): Promise<[string, string, string]>
       // desktop.rs:581 files() → <home>/graphics/*.png via edit_render::text; mcp.rs:3214-3220   A
type Box = [number, number, number, number];   // shares of the picture
```

Not exposed at all: mix.rs, motion.rs and mac_media.rs. No moving module calls them; they're internal to export, track, faces and media.

### 1.4 How TS gets the project types

- **ts-rs** `#[derive(TS)] #[ts(export, export_to = "../../packages/edit-types/src/generated/")]` on the edit-core model, eval types used by the UI, `Sections`, `Rippled`, and the engine's `ExportOptions`/`Format`/`Shape`/`Fill`/`Quality`/`Chapter`/`Plan`/`Encoders`/`Probe`. Gate it behind a `ts` feature, so the WASM build and edit-core stay dependency-free.
- **Why ts-rs:** it reads the serde attributes edit-core actually uses (the counts: 63× `default, skip_serializing_if`, 54× `default`, 49× `default = "…"`, 17× `rename_all`, 2× `tag`, 1× `flatten`, model.rs:333) and carries `///` docs into JSDoc. It's derive-only with no runtime cost.
- **What to verify in the spike:** fixed arrays (`Rgba([f32; 4])`) come out as tuples, and `skip_serializing_if` Options come out as `?:`. Fix gaps with `#[ts(type = …)]` / `#[ts(optional)]`.
- **Generated types describe what serde emits** (the read shape). TS writers may build partial objects, because `projectCommit` fills defaults; that's how UI and MCP writers behave today.
- **`just types`** regenerates them; `just check` fails if `git diff --exit-code packages/edit-types` is dirty.
- **Root `package.json`** becomes a Bun workspace (`apps/*`, `packages/*`). `apps/web/src/lib/types.ts` becomes `export * from "@edit/types"` plus UI-only types and consts (`CLIP_COLORS`, etc.).
- **AGENTS.md rule** "update edit-core, types.ts, edit.ts params, mcp.rs together" becomes "edit-core, `just types`, edit.ts params, mcp tool descriptions".

## 2. Where staying code calls moving code, and how each call is cut

| Staying site | Calls into a moving module | Cut |
|---|---|---|
| render.rs:1136-1306 `Exports::start` | `Store` (`layout().writable` :1160, `cache_dir` :1197, `emit` :1213), `drive::wanted` :1198, `cloud_media::for_export` :1237, `drive::start` :1303, `library::Library` :1139 | TS `Exports.start`: `exportPlan` → `layout.writable(output)` → mkdir/canonicalize/overwrite check → registry insert → emit `running` → `forExport` (keeps `_originals` until done) → `ExportJob.start(..., p => emit("running", p))` → on success emit `done`, add to `finished`, then `drive.start`. Native gets plain data and a progress callback. |
| render.rs:1338 | `broll::smoothing_pending` (only used for a log line) | TS logs it before starting. |
| render.rs:1337, media.rs:33-54 | `media::foreground` (global atomic) | Stays native: both sides of it live there. |
| render.rs:729, :747 | `media::media_key`, `media::light_preview` | Native (`edit-engine::media`). |
| media.rs:358 `Processor::set` → `store.emit`; :286 `store.cache_dir` | Store | `Processor` moves to TS. Native jobs take explicit `CachePaths` and report through promises/TSFN. |
| media.rs:456 | `cloud_media::is_local_copy` | TS computes it and passes `fromCloudProxy`. |
| media.rs:968 | `cloud_media::scrub` | TS scrubs native error strings and native log lines. |
| media.rs:560 | `transcribe::run` (relay) | `Processor.transcribe` is TS. |
| media.rs:88 | `broll::is_image_path` | Native keeps a copy of the extension list. TS keeps its own; a test compares them. |
| media.rs:214 | `media_drive::key_path` (published Layout, media_drive.rs:217-236) | Native holds `mediaFolders` from `init`/`setMediaFolders`, called whenever TS changes the media drive. |
| faces.rs:193, :757, :807 | `subtitles::box_size`, `captions::CAPTION_PREFIX`, `captions::caption_size`; plus `server::App` in `place_subtitles` (:362) | Split the module: placement geometry (`grown`, `place`, `place_from`, `placed_by_edit`, `picture_at`, `place_subtitles`, `pick`, `follow`, `clearly_visible`, `smooth`, `in_frame`, `indexes_between`, `overlap`, `text_on_faces`, `subtitle_size`) moves to TS `faces.ts`, together with what it calls. Native keeps only `detect`/`look`/`cached`. These size helpers are character-count estimates with no font metrics (subtitles.rs:929, captions.rs:478), so TS needs no text measurement. |
| desktop.rs:922, :925 | `markers::add_timeline` (in `profile`); `edit_plan::{Assets, apply_with}` at :1000-1010 are tests only | Split: `Layout`, `titles`, `Art`, `profile` move to TS `desktop.ts`. Native keeps drawing (`files`). |
| seats.rs:204, :372-475 | `watch::{keyframes_close, Window, cut, MODEL, post, unfence}` | Split: TS keeps `seats()`, `stretches`, `look` (Gemini), `faces` (medians) and `Seats::dot`. Native keeps `scenes`. |
| censor.rs:308 | `edit_review::callout_timing` (test only); `store::write_atomic` :120 | Native uses `util::write_atomic`; the test stays in TS. |
| mix.rs / loudness.rs / track.rs / mac_media.rs / export.rs | `tools::*`, `diag::*`, `store::now_ms` | `edit-engine::util` and `log`, configured by `init`. |

Rule after the cut: `edit-engine` has no `use` of any moving module. The compiler checks this in Phase 0, because `crates/edit` must still build against it.

## 3. Port order: work packages

### Phase 0: lands first, 2 agents in parallel

**WP0, native engine (Rust).** Inputs: sections 1 and 2.
1. Create `crates/edit-engine` with `git mv`, make the cuts, and point `crates/edit` at it. `just check` must stay green, and the Rust server must behave identically (this is the parity reference; tag it `parity-base`).
2. Add `EDIT_GOOGLE_API_URL` and `EDIT_AI_GATEWAY_URL` overrides to the Rust server (library.rs, drive.rs, script.rs, watch.rs, seats.rs) so parity runs can be mocked.
3. Change the updater (`update.rs:313-322`) to swap every executable in the archive (a bridge release; it makes later layout changes possible). Add `EDIT_VERSION` support to `install.sh` for pinned installs and rollbacks.
4. `crates/edit-native` napi bindings, the `index.d.ts`, and bun smoke tests: init, mediaKey, render a fixture frame, export a 2 s fixture, and TSFN progress.
5. ts-rs generation plus `packages/edit-types`.
6. A spike before anything else: napi-rs v3 TSFN, async fns and Buffers under Bun, and an embedded `.node` in `bun build --compile`.

**WP1, shared TS foundation (`apps/server/src/core`).** It can start from the contract in section 1 against a stub addon. This is the package every other one waits for:
- Workspace, tsconfig strict, bun:test, a fixture-home helper, and a mock relay/gateway/Google server (`apps/server/test/mocks/`).
- `native/index.ts` (typed wrapper and loader), `diag.ts` (log file, `record`/`time_on`/`time_async`, `lines`, `timings`, `uptime`, scrub), `guard.ts`, `tools.ts` (FFmpeg resolution beside `process.execPath`, `EDIT_FFMPEG`/`EDIT_FFPROBE`, `url_args`, `protocols`), `relay.ts` (fetch with bearer; same env vars).
- `store.ts`: open, list (needs `subtitles.isSubtitled`, store.rs:253, so that tiny helper lives here), get, create, create_copy, put_from_cloud, delete, replace, `update(id, origin, syncFn)`, commit through `native.projectCommit`, history every 10 min keeping 30, `write_atomic`, events bus, chat paths, active project, `resolve`.
  - The cloud hook is an interface `{ mayWrite(id): Promise<void>; wrote(id) }`. Because `mayWrite` is async in TS, the rev is re-checked after the await (store.rs:466 already does this check).
- `media_drive/layout.ts`: Layout resolve/`key_path`/writable/drive_dir/uploads_dir/exports_dir/check/mounted, settings.json, `holdLock` through native.
- `media.ts`: `Processor` (statuses, paths, ensure, transcribe, semaphores, `media` events). `transcribe.ts`: Transcript/Word types, `run`, `parse_scribe`.
- `app.ts`: the DI context mirroring `server::App` (server.rs:24-35).
- `http/`: Bun.serve wrapper, router, `check_host`, `log_requests` timings, the panic/error→JSON mapping, embedded static assets, `/api/ws` pub/sub, `/fonts/:file`.
- `mcp/`: JSON-RPC dispatch (initialize protocol versions, ping, tools/list, tools/call with `time_async("agent", "tool <name>")`), a tool registry, `tools.json`, `INSTRUCTIONS`, `tool_reference()`, and a `stableStringify` (sorted keys) for every JSON-as-text tool output.
- `import.ts`: `import_paths`, `import_made`, `house_media`, `house_media_saved`, `place_at_end`, `expand_home` (server.rs:965-1240), with a cloud hook for `cloud_media.import_local`.
- `project.ts`: TS ports of the small edit-core helpers in section 1.3, plus the edit primitives other packages use from mcp.rs: `tidy_tracks`, `merge_clip`, `free_track(_from)`, `touches_people`.

### Phase 1: 7 agents in parallel once WP0 and WP1 are merged

Each package owns its modules, its REST routes, its MCP tool handlers (registered into the registry), and a port of its Rust tests with the same names.

| WP | Modules (Rust lines) | Routes / MCP tools | Consumes |
|---|---|---|---|
| **WP2 Shell, server core, shipping** | main.rs, app.rs → edit-window, update.rs, media_drive.rs CLI + move (~1.4k), server.rs generic handlers (~1.5k), `adopt_shell_env` | health, diagnostics(+client), setup, fs, media-drive, update, projects CRUD, import/upload/media-status/media files, frame png, export/cancel/encoders/file/reveal; `edit` CLI; build and release (section 4) | WP1 |
| **WP3 Cloud** | cloud.rs, cloud_projects.rs, cloud_media.rs (~5.75k) | cloud routes (`cloud_projects::routes`), `edit cloud …` and `cloud backfill`; fills the store and import hooks; `forExport` for WP2's exports | WP1 (+ `script.Excerpt`/`safe_name`/`clock`/`duration_of`/`cut`/`resolve`/`keyframe_before`/`spans` from WP4; agree that interface on day 1) |
| **WP4 Script, voice, research** | script.rs, voice.rs, voiceover.rs, research.rs (~5.25k) | voice/*, scripts/*, script, research/*; search_web, read_page, add_article, case_articles, look_at_found, reject_found, collect_images, use_found, realign_script, place_voiceovers, tighten_voiceover, speed_voiceover | WP1; `subtitles.{footage_sound, write_mutes, timed_words, suggestions}` from WP5 |
| **WP5 Subtitles core** | subtitles.rs, speakers.rs, people.rs, seats (TS half), faces geometry (~5k). `captions::transcript_of` and `hex` move in here to break the cycle | add_subtitles, place_subtitles, repack_subtitles, mute_house_words, set_segments | WP1 |
| **WP6 Captions, watching, review** | captions.rs, watch.rs, edit_review.rs, footage_search.rs (~5.5k) | captions, watch, transcribe-related routes; caption_speakers, place_captions, track_region, watch_footage, transcribe, media_transcript, find_in_footage, read_transcript | WP1; the WP5 exports listed in the note below |
| **WP7 Editing tools and plans** | mcp.rs generic tool handlers, edit_plan.rs, graphics.rs, cutin.rs, markers.rs, desktop.ts, sfx.rs (+ embedded `assets/sfx`), skills.rs, styles.rs (~7.5k) | skill, get_edit_context, apply_edit_plan, review_edit, get_project, add_text, add_clip, update_clip(s), batch, cover_cut_in, set_in_out, delete_clips, set_keyframes, import_media, still_frame, markers, add_sound_effect, remove_time, tidy_tracks, render_frame, contact_sheet, look_at_media, export | WP1; `faces.text_on_faces` (WP5), `people.one_colour_per_person` (WP5), `broll.wait_for_*` (WP8) |
| **WP8 Media sources, sound, agent** | broll.rs (+ `map_page.html`), library.rs, drive.rs, agent.rs (~4.6k) | library, map routes, drive, agent/*; list_library, add_from_library, set_loudness, measure_audio, smooth_slow_motion, map_view | WP1 |

WP6 consumes these WP5 exports: `subtitles.{Found, Line, TimedWord, Suggestion, segment, hidden_role, silent_role, write_mutes, uncram, timed_words, suggestions, star_on_screen, star, role_of, longest_ms, house_words, house_style, footage_sound, is_subtitled, box_size}`, `speakers.{Person, BACKGROUND, ROLES, distinct, role_title, edit_transcript}`, and `faces.*`.

Cross-package seams are written down on day 1 as TS signatures (taken from the symbol list in the dependency trace). Until the owning package lands, they're stubbed with `throw new Error("not ported")`.

**Phase 2:** parity and dogfooding (section 5). **Phase 3:** switch over and delete.

## 4. How it ships

**Build (per target, `aarch64-apple-darwin` and `x86_64-apple-darwin`):**
1. `cargo build -p edit-native --release --target $T` (via `napi build --platform`), then `codesign -s - -f edit-native.node`.
2. `cargo build -p edit-window --release --target $T` (Tauri), then ad-hoc codesign.
3. `apps/server/scripts/embed.ts` generates `src/embedded.gen.ts`: `import … with { type: "file" }` for every file in `apps/web/dist`, the `.node` addon, `edit-window`, `assets/sfx/*`, and `map_page.html`.
4. `bun build apps/server/src/main.ts --compile --target=bun-darwin-arm64|bun-darwin-x64 --define EDIT_VERSION="\"$V\"" --define EDIT_RELEASE=true --outfile package/edit`, then `codesign -s - -f package/edit`.
5. Package as today: `tar -czf edit-$T.tar.gz edit edit-ffmpeg edit-ffprobe`, plus `.sha256`.

**How the CLI commands map:**

| Command | New behaviour |
|---|---|
| `edit` / `edit app [--port --home]` | TS runs `adopt_shell_env` (app.rs:75-122). It starts the server unless the port is taken (main.rs:217). It extracts the embedded `edit-window` to `<home>/bin/Edit` when the hash differs; that file name is the Dock name and replaces `run_as_edit` (app.rs:141-180). It spawns `Edit --url http://127.0.0.1:<port>/` with a stdin pipe, and the helper quits on EOF so a crashed server leaves no orphan window. When the child exits, TS runs `cloudProjects.shutdown()` and exits 0. |
| `edit serve [--port --host --home]` | The TS server: `bind_addresses`, Tailscale IP/name, `EDIT_HOSTS`, as in main.rs:263-333. SIGINT runs cloud shutdown and exits 130. |
| `edit mcp`, `--version`, `help` | Same text. Version comes from `--define EDIT_VERSION`. |
| `edit media [use DIR / off / move --to DIR]` | TS `media_drive.runCli`. It refuses while `isLocked(<home>/server.lock)` or while the port answers with the same home. |
| `edit cloud …` / `edit cloud backfill <id>` | TS `cloud.runCli`; backfill uses fetch instead of curl (main.rs:150-172). |
| `edit update` | TS `update.runCli`. |

**Self-update (`update.ts`, port of update.rs):**
- `enabled = EDIT_RELEASE && unix`; same `asset_target()`; GitHub `releases/latest` digest or `.sha256`; streamed download with progress; `Bun.CryptoHasher` sha256; `tar`.
- Swap in `edit-ffmpeg`/`edit-ffprobe`/`edit` the same way (copy to `.name-update`, chmod 755, rename). `original_exe` becomes `process.execPath`; the `EDIT_EXE` env goes away.
- Restart with `native.reexec(process.execPath, argv)`: execv with the same PID, terminal and flags, after marking every fd above 2 CLOEXEC. Bun's sockets aren't guaranteed CLOEXEC, and a leaked listener would make the new server fail to bind.
- In app mode, kill the window helper first. The new image runs `edit app` again and opens a fresh window, matching today's exec of the Tauri process.
- Still refuse while an export or Drive upload runs (server.rs:598-604).
- Everything ships inside `edit`, so the first TS release installs through the old Rust updater unchanged.

**Release workflow changes (`.github/workflows/release.yml`):**
- Keep `prepare` (tag vs Cargo.toml version) and `web`.
- `build` adds `oven-sh/setup-bun@v2`, the native and window builds per target (x86_64 cross-compiled on the arm64 runner as today), `bun install --frozen-lockfile` at the root, the embed and compile steps, and codesign.
- Smoke step: `package/edit --version`; `package/edit serve --home $(mktemp -d) --port 7799 &`; curl `/api/health` and `/mcp` initialize. Skip GPU renders on hosted runners (no Metal).
- `just publish` also bumps `apps/server/package.json`.
- `Justfile`:
  - `serve-build` becomes `bun build --compile` with the `.node` built by `cargo build --profile serve -p edit-native`, renamed into `/tmp/run/edit` as today.
  - `dev` becomes `bun --watch apps/server/src/main.ts serve` plus `cargo watch` on edit-engine/edit-native (restart on `.node` change) plus Vite.
  - `check` adds `bun test --cwd apps/server`, `tsc --noEmit`, and the types diff.
  - `bundle` builds `edit-window` as the .app with `edit` in Resources; in bundle mode the helper spawns `Resources/edit serve`.

## 5. Parity strategy

1. **Reference.** The Rust server at tag `parity-base` (after Phase 0's env overrides), built once in `[profile.serve]`.
2. **Harness.** `scripts/parity/run.ts`:
   - Clone a fixture home twice with `cp -p` (mtimes kept, so cache keys match; fixture media lives outside both homes at fixed absolute paths, so `media_key`s are identical). Start Rust on :7801 and TS on :7802 with `EDIT_RELAY_URL`, `EDIT_AI_GATEWAY_URL`, `EDIT_GOOGLE_API_URL` pointing at one record/replay mock (canned transcripts, speech, R2/Convex in memory, Gemini answers keyed by request hash, Drive/Docs).
   - Replay the same step list against both and compare:
     - **HTTP status and JSON.** Key-order-insensitive. Parse JSON embedded in MCP text content. Floats within 1e-4 relative (f32 math in faces/subtitles/captions runs in f64 in TS). Strip timestamps, durations, `uptime` and home prefixes.
     - **Images.** Decoded bytes must be identical, since both servers use the same native code.
     - **Project files on disk** after every step: byte-identical, because both go through `to_vec_pretty`.
     - **Websocket event streams:** the (type, id, rev, origin) sequence plus payloads, compared the same way.
3. **Coverage gates:**
   - Every route in the Rust router (server.rs:65-129) exists in TS (a test parses server.rs).
   - `tools/list` is equal after parse.
   - Each of the 57 tools is exercised. Arguments are harvested from real agent sessions in `~/.edit/projects/*.chat.json` where present, plus scripted edit-workflow plans for `apply_edit_plan`.
   - Every `#[test]` in a moving module has a same-named `bun:test` (CI compares counts: subtitles 20, edit_plan 16, captions 13, cloud_projects 9, script 9, watch 9, cloud_media 9, voiceover 8, mcp 7, cloud 7, …). Ignored live tests stay ignored, behind the same env gates.
4. **Native parity.** `sampleKeyframes`/`removeTime`/`sections` property tests (random projects, native vs TS ports), and `mediaKey` against a frozen list of known keys.
5. **Performance gates.** `scripts/benchmark.py` and `benchmark-history.ts` against both. Budgets: REST p95 within 1.2×, `get_edit_context`/`apply_edit_plan`/`edit_plan::audit` within 1.5×, export frames/s within 2%, idle RSS stated. Also check that a running agent tool call doesn't stall UI requests by more than 100 ms (pure-TS work now runs on the JS thread).
6. **Dogfood.** Point `/tmp/run/serve.sh` at the TS build for a week of real edits on the 8 GB M1, with `/api/diagnostics` reviewed daily.
7. **Switch-over:**
   1. Release vX with the TS `edit`. The archive layout is unchanged and the data layout identical, so rollback is `EDIT_VERSION=vX-1 install.sh` with no data migration.
   2. After two patch releases without regressions, `git rm -r crates/edit` (only main/server/agent leftovers remain; the staying files already moved), drop the Rust-only Justfile recipes, and remove `apps/web/src/lib/types.ts`'s hand-written body.
   3. Rewrite AGENTS.md's module notes to point at `apps/server/src/*.ts` and `crates/edit-engine/src/*.rs`, and keep `parity-base` as a tag.

## 6. Risks, and what should not move

**Keep in Rust (beyond the decided split), and why:**
- **`media_key`/`key_of`.** They're `DefaultHasher` (SipHash-1-3) over a `Path` hash plus `Option<SystemTime>`. A TS reimplementation would silently invalidate every cache, cloud analysis and excerpt name. Also pin the Rust toolchain, since `DefaultHasher` isn't guaranteed stable across releases (this risk already exists).
- **`probe`, `export::plan`/`with_extension`/`codec_args`, `make_peaks`, project canonicalization, and ripple edits** (`remove_time`, `speed_span_holding`). Duplicating these risks drift for no gain.
- **The `server.lock` flock** (Bun has no flock) and the **exec-in-place restart**.
- **Honest marginal cases:** `seatsScenes` and `censorIssues` are small arithmetic the TS side could own. They're kept native per the decision, but they're the first to reconsider if the napi surface gets in the way.

**Risks:**
1. **Bun's N-API completeness** (TSFN, finalizers, napi-rs v3 async on Bun) and **embedded `.node` extraction** in `--compile` (temp-dir dlopen, ad-hoc signatures, quarantine). Mitigation: the WP0 spike on a clean Mac. The bridge updater (Phase 0) allows a fallback of shipping `edit-native.node` beside the binary.
2. **JS-thread CPU.** In Rust, heavy pure logic ran on tokio workers. In TS it blocks HTTP and websocket: `find_in_footage` over every transcript, `people::one_colour_per_person` ΔE, `edit_plan::audit`, `get_edit_context` (up to 36k chars), subtitle layout over long edits. Measure; move offenders to a Bun Worker, or native as a last resort.
3. **Agent-visible output drift.** Rust `json!` maps have sorted keys (`serde_json` without `preserve_order`), `1.0` vs `1` formatting, f32 rounding, and error wording. Use `stableStringify`, port error strings verbatim, and let the parity harness catch the rest.
4. **Memory on 8 GB.** The Bun runtime and JS heap, plus project JSON held both in JS and in the native cache. Keep the cache bounded; watch RSS in dogfooding.
5. **Window lifecycle.** The window is now a separate process: cloud shutdown on window close, orphan windows, update restarts in app mode, and `just bundle` inverting who spawns whom. All covered above, but this is new surface.
6. **Bun.serve specifics:**
   - `maxRequestBodySize` is server-wide, so set it high and enforce the 64 MiB route limits (server.rs:112-116) by hand.
   - Uploads must stream to disk with the 60 s idle cutoff (server.rs:608).
   - Websocket backpressure replaces the dropped-lagging-receiver behaviour of `broadcast`.
7. **Async store writes.** `Cloud::may_write` takes the lock over the network; in TS it's async, so a write can race. The rev re-check covers correctness, but expect more "project changed while editing; retry" under contention.
8. **Native crashes.** A segfault in Metal, AVFoundation or wgpu kills the whole server, as today. Panics must stay `unwind`; `catch_unwind` must be at every napi entry and in the renderer and export threads (already true via `guard::catch`, render.rs:618, :1217).
9. **Size and dev loop.** The compiled binary grows (Bun runtime plus addon plus window helper; expect roughly 70–100 MB against today's), so updates take longer to download. Changing the addon means restarting the dev server; the 8 s incremental Rust rebuilds don't carry over.
10. **Is it worth it?** The boundary is clean and the Phase 0 extraction is worth doing on its own. The other ~37k lines become TS, with fewer compile-time guarantees (offset by generated types, strict TS and the ported tests). Roughly 8 agent-packages plus a parity phase.

### Critical Files for Implementation
- /Users/siphesihlembuyisa/Documents/code/edit/crates/edit/src/render.rs
- /Users/siphesihlembuyisa/Documents/code/edit/crates/edit/src/media.rs
- /Users/siphesihlembuyisa/Documents/code/edit/crates/edit/src/server.rs
- /Users/siphesihlembuyisa/Documents/code/edit/crates/edit/src/store.rs
- /Users/siphesihlembuyisa/Documents/code/edit/crates/edit/src/update.rs
