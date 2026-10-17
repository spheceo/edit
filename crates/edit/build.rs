fn main() {
    // The macOS media code (mac_media.m) is edit-engine's, and links from there.
    #[cfg(feature = "app")]
    tauri_build::build();
}
