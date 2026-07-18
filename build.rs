use std::{env, path::PathBuf};

fn main() {
    let plist_relative = PathBuf::from("packaging/macos/Info.plist");
    println!("cargo:rerun-if-changed={}", plist_relative.display());

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must provide CARGO_MANIFEST_DIR"),
    );
    let plist = manifest_dir
        .join(plist_relative)
        .canonicalize()
        .expect("packaging/macos/Info.plist must exist");

    // A bare Mach-O launched by `cargo run` has no app bundle Info.plist.
    // Embedding the same plist in __TEXT makes privacy usage descriptions
    // available to TCC in both development and bundled builds.
    println!(
        "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        plist.display()
    );
}
