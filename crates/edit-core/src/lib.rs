//! Edit's project model and timeline evaluation.
//!
//! This crate compiles natively (server, export, agent tools) and to WASM
//! (browser preview), so both sides evaluate a frame with exactly the same code.

mod eval;
mod model;
mod sections;
mod timeline;

pub use eval::*;
pub use model::*;
pub use sections::*;
pub use timeline::*;
