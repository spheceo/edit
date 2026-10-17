//! Edit's native engine: the work that stays in Rust whoever serves the
//! editor. Frame renders and exports (`render`, `export`, `mix`), probing and
//! preview making (`media`), sound measurement (`loudness`), tracking
//! (`track`, `motion`), face detection (`faces`), redaction checks
//! (`censor`), camera angles (`seats`), the desktop profile's pictures
//! (`desktop`) and, on macOS, AVFoundation/ImageIO/Vision (`mac_media`).
//!
//! It knows nothing of the server: no store, no events, no HTTP. The host
//! says where FFmpeg, the cache and the media folders are (`util`) and takes
//! its log lines (`log`). The Rust server (`crates/edit`) and the native
//! addon (`crates/edit-native`) are its two hosts.

pub mod censor;
pub mod desktop;
pub mod export;
pub mod faces;
pub mod log;
pub mod loudness;
#[cfg(target_os = "macos")]
pub mod mac_media;
pub mod media;
pub mod mix;
pub mod motion;
pub mod render;
pub mod seats;
pub mod track;
pub mod util;
