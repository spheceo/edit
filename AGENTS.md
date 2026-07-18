# Agent notes

## Git commits

Never add a `Co-authored-by` trailer (Cursor, agents, or otherwise). Commit as the user only: `git add`, `git commit`, and `git push` with a normal message body — no co-authors, no extra attribution trailers.

## Auto-update (later)

Candidate for later: [Velopack](https://velopack.io/) — cross-platform installer / auto-update for desktop apps. Not integrated yet; keep in mind when we add shipping updates.

## macOS packaging (xtask)

There is no `.cargo` alias. Invoke the packager directly:

```sh
cargo run -p xtask -- run-macos              # dev Kuro.app (Speech / day-to-day)
cargo run -p xtask -- run-macos --release
cargo run -p xtask -- bundle-macos           # self-contained dist/Kuro.app + FFmpeg
```

## macOS dock icon

Hard constraints for dock / window icons (rationale + failed experiments: Traycer epic decision log `macos-dock-icon/decisions`):

- Keep `assets/brand/kuro-icon.png` (and 256/512 variants) as **1024 / 512 / 256** square PNGs with alpha
- Keep the black (or brand) shape as a **squircle baked into the PNG** — do not ship a sharp full-bleed square
- Keep the shape at about **82% of the canvas** with even transparent padding on all sides
- Corner radius ≈ **22.37%** of the shape side (macOS-like)
- Wire the window icon from `assets/brand/kuro-icon.png` in `main.rs`; `cargo run -p xtask -- bundle-macos` builds `.icns` from the same source

Glyph / mark artwork inside the squircle can change freely. The canvas, padding ratio, and pre-masked squircle must stay.
