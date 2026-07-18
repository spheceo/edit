# Agent notes

## macOS dock icon

**Problem:** Running via `cargo run` / eframe does **not** apply macOS’s system squircle mask the way a bundled `.app` does. Icon sizing in the Dock is therefore controlled entirely by the PNG asset.

**What went wrong:**
- Full-bleed opaque square → sharp corners, reads oversized next to other apps
- Full-bleed pre-rounded squircle (no margin) → still too big in the Dock
- Heavy transparent padding (~68%) → too small and “squashed”
- Sweet spot → squircle at **~82%** of the canvas, centered, transparent margin around it

**Do not change (even with a new logo):**
- Keep `assets/brand/kuro-icon.png` (and 256/512 variants) as **1024 / 512 / 256** square PNGs with alpha
- Keep the black (or brand) shape as a **squircle baked into the PNG** — do not ship a sharp full-bleed square
- Keep the shape at about **82% of the canvas** with even transparent padding on all sides
- Corner radius ≈ **22.37%** of the shape side (macOS-like)
- Wire the window icon from `assets/brand/kuro-icon.png` in `main.rs`; bundle script builds `.icns` from the same source

Glyph / mark artwork inside the squircle can change freely. The canvas, padding ratio, and pre-masked squircle must stay.
