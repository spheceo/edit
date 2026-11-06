fn main() {
    // The page's calls into the window (src/preview.rs): allowed by name in capabilities/page.json.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "preview_open",
        "preview_place",
        "preview_project",
        "preview_frame",
        "preview_close",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
