//! A small, server-free host for the same engine used by the desktop addon.
use std::{collections::HashMap, path::PathBuf, sync::atomic::AtomicBool};

fn run() -> Result<(), String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--probe") {
        let _renderer = edit_engine::render::new_renderer(32, 32)?;
        println!("{}", serde_json::json!({"gpu": true}));
        return Ok(());
    }
    let audio_only = args.first().map(String::as_str) == Some("--audio-only");
    let cloud_plan = args.first().map(String::as_str) == Some("--cloud-plan");
    if audio_only || cloud_plan {
        args.remove(0);
    }
    let [project, options, output, cache] = args.as_slice() else {
        return Err(
            "usage: edit-worker [--audio-only] <project.json> <options.json> <output> <cache>"
                .into(),
        );
    };
    let read = |path: &str| std::fs::read(path).map_err(|error| error.to_string());
    let project: edit_core::Project =
        serde_json::from_slice(&read(project)?).map_err(|error| format!("project: {error}"))?;
    let options: edit_engine::export::ExportOptions =
        serde_json::from_slice(&read(options)?).map_err(|error| format!("options: {error}"))?;
    let plan = edit_engine::render::export_plan(&project, &options)?;
    if cloud_plan {
        let count: i64 = cache.parse().map_err(|_| "invalid section count")?;
        if !(1..=8).contains(&count) || plan.end - plan.start < count {
            return Err("section count must be 1..8 and no greater than the frame count".into());
        }
        let settings = format!(
            "cloud-v3|{}|{}x{}|{}",
            serde_json::to_string(&options).map_err(|e| e.to_string())?,
            plan.width,
            plan.height,
            project.fps()
        );
        let sections: Vec<_> = (0..count)
            .map(|index| {
                let mut section = plan.clone();
                section.start = plan.start + (plan.end - plan.start) * index / count;
                section.end = plan.start + (plan.end - plan.start) * (index + 1) / count;
                let keys: Vec<_> = edit_engine::chunks::split(&project, &section, &settings)
                    .into_iter()
                    .map(|chunk| chunk.key)
                    .collect();
                serde_json::json!({"index": index, "range": [section.start, section.end], "keys": keys})
            })
            .collect();
        let seconds = plan.seconds(project.fps());
        let parts = edit_engine::mix::parts(
            &edit_engine::render::heard_segments(&project, plan.start, plan.end),
            |id| project.media(id).map(|media| PathBuf::from(&media.path)),
            plan.start as f64 / project.fps(),
            seconds,
        );
        let receipt = serde_json::json!({
            "sections": sections,
            "sound": edit_engine::render::sound_key(&options, &parts, seconds),
        });
        std::fs::write(output, receipt.to_string()).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let cache = PathBuf::from(cache);
    std::fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    edit_engine::util::use_cache_dir(cache.clone());
    if audio_only {
        if !plan.audio {
            return Err("there's no sound to export in that span".into());
        }
        // One continuous mix for distributed picture sections: preserve the
        // edit's loudness, limiter, fades and AAC priming across every seam.
        let seconds = plan.seconds(project.fps());
        let parts = edit_engine::mix::parts(
            &edit_engine::render::heard_segments(&project, plan.start, plan.end),
            |id| project.media(id).map(|media| PathBuf::from(&media.path)),
            plan.start as f64 / project.fps(),
            seconds,
        );
        let codec = edit_engine::export::audio_args(&options);
        edit_engine::mix::render(
            &parts,
            (seconds * edit_engine::mix::RATE as f64).round() as usize,
            options.loudness,
            &edit_engine::mix::Encoding {
                codec: &codec,
                aac: Some(edit_engine::export::audio_bitrate(
                    options.format,
                    options.quality,
                )),
            },
            output.as_ref(),
            &cache.join("mix.f32"),
            &AtomicBool::new(false),
            &mut |progress| println!("{}", serde_json::json!({"progress": progress})),
        )?;
    } else {
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
    }
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
