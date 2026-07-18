# Agent notes

## macOS dock icon

Hard constraints for dock / window icons (rationale + failed experiments: Traycer epic decision log `macos-dock-icon/decisions`):

- Keep `assets/brand/kuro-icon.png` (and 256/512 variants) as **1024 / 512 / 256** square PNGs with alpha
- Keep the black (or brand) shape as a **squircle baked into the PNG** — do not ship a sharp full-bleed square
- Keep the shape at about **82% of the canvas** with even transparent padding on all sides
- Corner radius ≈ **22.37%** of the shape side (macOS-like)
- Wire the window icon from `assets/brand/kuro-icon.png` in `main.rs`; bundle script builds `.icns` from the same source

Glyph / mark artwork inside the squircle can change freely. The canvas, padding ratio, and pre-masked squircle must stay.
