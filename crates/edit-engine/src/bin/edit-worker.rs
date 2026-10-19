//! A small, server-free host for the same engine used by the desktop addon.
use std::{collections::HashMap, path::PathBuf, sync::atomic::AtomicBool};

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--probe") {
        let _renderer = edit_engine::render::new_renderer(32, 32)?;
        println!("{}", serde_json::json!({"gpu": true}));
        return Ok(());
    }
    let [project, options, output, cache] = args.as_slice() else {
        return Err("usage: edit-worker <project.json> <options.json> <output> <cache>".into());
    };
    let read = |path: &str| std::fs::read(path).map_err(|error| error.to_string());
    let project: edit_core::Project =
        serde_json::from_slice(&read(project)?).map_err(|error| format!("project: {error}"))?;
    let options: edit_engine::export::ExportOptions =
        serde_json::from_slice(&read(options)?).map_err(|error| format!("options: {error}"))?;
    let plan = edit_engine::render::export_plan(&project, &options)?;
    let cache = PathBuf::from(cache);
    std::fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    edit_engine::util::use_cache_dir(cache.clone());
    edit_engine::render::export_file(
        &project,
        &options,
        &plan,
        output.as_ref(),
        &cache,
        &HashMap::new(),
        &AtomicBool::new(false),
        |progress| println!("{}", serde_json::json!({"progress": progress})),
    )?;
    let fps = options.fps.map_or(project.fps(), f64::from);
    let receipt = serde_json::json!({
        "width": plan.width, "height": plan.height, "audio": plan.audio,
        "frames": ((plan.end - plan.start) as f64 * fps / project.fps()).round(),
        "seconds": plan.seconds(project.fps()), "fps": fps,
    });
    std::fs::write(cache.join("result.json"), receipt.to_string())
        .map_err(|error| error.to_string())?;
    println!("{}", serde_json::json!({"done": true}));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
