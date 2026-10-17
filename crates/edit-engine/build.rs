fn main() {
    println!("cargo:rerun-if-changed=src/mac_media.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/mac_media.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-Wno-deprecated-declarations")
            .compile("edit_mac_media");
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
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
