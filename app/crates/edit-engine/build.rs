use std::hash::{Hash, Hasher};
use std::path::Path;

/// Hashes every file under `path` (names and contents, in order).
fn hash_tree(path: &Path, hasher: &mut std::collections::hash_map::DefaultHasher) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.is_dir() {
        let mut names: Vec<_> = std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        names.sort();
        for name in names {
            hash_tree(&name, hasher);
        }
    } else if let Ok(bytes) = std::fs::read(path) {
        path.file_name().hash(hasher);
        bytes.hash(hasher);
    }
}

fn main() {
    println!("cargo:rerun-if-changed=src/mac_media.m");
    // What draws and encodes an export's picture: a chunk made by other code
    // is never reused (chunks.rs).
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in [
        "../edit-render/src",
        "../edit-render/Cargo.toml",
        "../edit-render/fonts",
        "../edit-core/src/eval.rs",
        "src/render.rs",
        "src/export.rs",
        "src/chunks.rs",
        "src/mac_media.m",
    ] {
        println!("cargo:rerun-if-changed={path}");
        hash_tree(Path::new(path), &mut hasher);
    }
    println!(
        "cargo:rustc-env=EDIT_RENDER_SOURCE={:016x}",
        hasher.finish()
    );
    // What mixes and encodes an export's sound (the mixer, the model's mutes
    // and segments, the decoders): a sound made by other code is never reused.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in [
        "../edit-core/src",
        "src/mix.rs",
        "src/render.rs",
        "src/export.rs",
        "src/util.rs",
        "src/mac_media.rs",
        "src/mac_media.m",
    ] {
        println!("cargo:rerun-if-changed={path}");
        hash_tree(Path::new(path), &mut hasher);
    }
    println!("cargo:rustc-env=EDIT_SOUND_SOURCE={:016x}", hasher.finish());
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let mut build = cc::Build::new();
        build
            .file("src/mac_media.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-Wno-deprecated-declarations");
        build.compile("edit_mac_media");
        // `@available` calls compiler-rt's __isPlatformVersionAtLeast, which
        // clang links by itself and rustc's link line leaves out. The thin-LTO
        // release lost the copy Rust's builtins had, so the addon looked it up
        // at run time, found nothing and jumped to 0 (nightly-14's build).
        let resources = std::process::Command::new(build.get_compiler().path())
            .arg("--print-resource-dir")
            .output();
        let Ok(resources) =
            resources.map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        else {
            eprintln!("edit-engine: the C compiler didn't say where its runtime is");
            std::process::exit(1);
        };
        println!("cargo:rustc-link-search=native={resources}/lib/darwin");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        for framework in [
            "AVFoundation",
            "Foundation",
            "CoreMedia",
            "CoreVideo",
            "Accelerate",
            "ImageIO",
            "CoreGraphics",
            "Vision",
            "VideoToolbox",
            "Security",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
