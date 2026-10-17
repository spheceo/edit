//! Sound effects bundled with Edit. They're written into ~/.edit/sfx so a
//! project imports them like any other file.

use std::path::{Path, PathBuf};

pub struct Sound {
    pub name: &'static str,
    file: &'static str,
    bytes: &'static [u8],
    /// Seconds into the file of its "hit" marker: the point that lands on the cut.
    hit: f64,
}

pub const SOUNDS: &[Sound] = &[Sound {
    name: "shutter",
    file: "shutter.wav",
    bytes: include_bytes!("../../../assets/sfx/shutter.wav"),
    // The middle of the shutter, so it straddles the cut.
    hit: 0.085,
}];

/// The marker a placed sound lines up on the cut.
pub const HIT: &str = "hit";

impl Sound {
    /// Seconds into the file of its hit.
    pub fn hit(&self) -> f64 {
        self.hit
    }

    /// The markers the sound comes with.
    pub fn markers(&self) -> Vec<edit_core::Marker> {
        vec![edit_core::Marker {
            time: self.hit,
            name: HIT.to_owned(),
            note: String::new(),
        }]
    }
}

pub fn find(name: &str) -> Option<&'static Sound> {
    SOUNDS.iter().find(|sound| sound.name == name)
}

pub fn names() -> Vec<&'static str> {
    SOUNDS.iter().map(|sound| sound.name).collect()
}

/// The sound's file on disk, written if missing. The name carries a hash of
/// the bytes, so a new version of a sound is a new file and projects using
/// the old one keep it.
pub fn path(home: &Path, sound: &Sound) -> Result<PathBuf, String> {
    let dir = home.join("sfx");
    // FNV-1a.
    let hash = sound
        .bytes
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
        });
    let (stem, extension) = sound.file.rsplit_once('.').unwrap_or((sound.file, "wav"));
    let path = dir.join(format!("{stem}-{:08x}.{extension}", hash as u32));
    if std::fs::read(&path).ok().as_deref() != Some(sound.bytes) {
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        crate::store::write_atomic(&path, sound.bytes).map_err(|error| error.to_string())?;
    }
    Ok(path)
}
