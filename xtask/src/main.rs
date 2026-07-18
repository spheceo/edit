use std::{
    env,
    error::Error,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const FFMPEG_BRANCH: &str = "release/8.1";
const FFMPEG_REPOSITORY: &str = "https://github.com/FFmpeg/FFmpeg.git";

fn main() {
    if let Err(error) = try_main() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn try_main() -> Result<()> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let Some(command) = arguments.next() else {
        print_help();
        return Ok(());
    };
    let remaining = arguments.collect::<Vec<_>>();

    match command.to_string_lossy().as_ref() {
        "bundle-macos" => {
            if matches!(remaining.as_slice(), [option] if option == "-h" || option == "--help") {
                print_bundle_help();
                return Ok(());
            }
            if !remaining.is_empty() {
                return Err(usage_error("bundle-macos accepts no options"));
            }
            bundle_macos()
        }
        "run-macos" => run_macos(&remaining),
        "-h" | "--help" | "help" => {
            print_help();
            Ok(())
        }
        other => Err(usage_error(&format!("unknown command: {other}"))),
    }
}

fn print_help() {
    println!(
        "Usage: cargo run -p xtask -- <command> [options]\n\nCommands:\n  bundle-macos  Build a self-contained dist/Kuro.app with FFmpeg\n  run-macos     Build, sign, and open a development Kuro.app\n\nRun `cargo run -p xtask -- <command> --help` for command-specific help."
    );
}

fn print_bundle_help() {
    println!("Usage: cargo run -p xtask -- bundle-macos");
}

fn print_run_help() {
    println!("Usage: cargo run -p xtask -- run-macos [--release]");
}

fn usage_error(message: &str) -> Box<dyn Error> {
    Box::new(io::Error::new(
        io::ErrorKind::InvalidInput,
        message.to_owned(),
    ))
}

fn project_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must be a direct child of the project root")
        .to_path_buf()
}

fn bundle_macos() -> Result<()> {
    require_tools(&[
        "git",
        "make",
        "pkg-config",
        "install_name_tool",
        "otool",
        "codesign",
        "sips",
        "iconutil",
        "sysctl",
    ])?;

    let project_dir = project_dir();
    let build_root = project_dir.join(".build/macos-bundle");
    let ffmpeg_source = build_root.join("ffmpeg-8.1");
    let ffmpeg_prefix = build_root.join("ffmpeg-install");
    let cargo_target = build_root.join("cargo-target");
    let app_bundle = project_dir.join("dist/Kuro.app");

    if app_bundle.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} already exists. Move or remove it before bundling again.",
                app_bundle.display()
            ),
        )
        .into());
    }

    fs::create_dir_all(&build_root)?;
    fs::create_dir_all(project_dir.join("dist"))?;

    if !ffmpeg_source.join(".git").is_dir() {
        let mut command = Command::new("git");
        command.args([
            "clone",
            "--depth",
            "1",
            "--branch",
            FFMPEG_BRANCH,
            FFMPEG_REPOSITORY,
        ]);
        command.arg(&ffmpeg_source);
        run(&mut command)?;
    }

    if !ffmpeg_prefix.join("lib/pkgconfig/libavfilter.pc").is_file() {
        fs::create_dir_all(&ffmpeg_prefix)?;
        if ffmpeg_source.join("Makefile").is_file() {
            let mut command = Command::new("make");
            command.arg("distclean").current_dir(&ffmpeg_source);
            run(&mut command)?;
        }

        let prefix = ffmpeg_prefix.to_string_lossy();
        let mut configure = Command::new(ffmpeg_source.join("configure"));
        configure.current_dir(&ffmpeg_source).args([
            format!("--prefix={prefix}"),
            "--enable-shared".into(),
            "--disable-static".into(),
            "--disable-programs".into(),
            "--disable-doc".into(),
            "--disable-debug".into(),
            "--disable-gpl".into(),
            "--disable-nonfree".into(),
            "--disable-version3".into(),
            "--disable-autodetect".into(),
            "--disable-avdevice".into(),
            "--disable-network".into(),
            "--enable-avcodec".into(),
            "--enable-avformat".into(),
            "--enable-avfilter".into(),
            "--enable-avutil".into(),
            "--enable-swresample".into(),
            "--enable-swscale".into(),
            "--enable-videotoolbox".into(),
            "--enable-audiotoolbox".into(),
            "--enable-pic".into(),
            "--extra-cflags=-mmacosx-version-min=12.0".into(),
            "--extra-ldflags=-mmacosx-version-min=12.0".into(),
        ]);
        run(&mut configure)?;

        let cores = sysctl_logical_cpu_count()?;
        let mut make = Command::new("make");
        make.arg(format!("-j{cores}")).current_dir(&ffmpeg_source);
        run(&mut make)?;
        let mut install = Command::new("make");
        install.arg("install").current_dir(&ffmpeg_source);
        run(&mut install)?;
    }

    let mut cargo = Command::new("cargo");
    cargo
        .current_dir(&project_dir)
        .args(["build", "--manifest-path"])
        .arg(project_dir.join("Cargo.toml"))
        .arg("--release")
        .env("PKG_CONFIG_PATH", ffmpeg_prefix.join("lib/pkgconfig"))
        .env("DYLD_LIBRARY_PATH", ffmpeg_prefix.join("lib"))
        .env("MACOSX_DEPLOYMENT_TARGET", "12.0")
        .env("CARGO_TARGET_DIR", &cargo_target);
    run(&mut cargo)?;

    let contents = app_bundle.join("Contents");
    let macos_dir = contents.join("MacOS");
    let frameworks_dir = contents.join("Frameworks");
    let resources_dir = contents.join("Resources");
    fs::create_dir_all(&macos_dir)?;
    fs::create_dir_all(&frameworks_dir)?;
    fs::create_dir_all(&resources_dir)?;

    copy_file(cargo_target.join("release/kuro"), macos_dir.join("Kuro"))?;
    copy_file(
        project_dir.join("packaging/macos/Info.plist"),
        contents.join("Info.plist"),
    )?;
    copy_file(
        project_dir.join("packaging/THIRD_PARTY_NOTICES.md"),
        resources_dir.join("THIRD_PARTY_NOTICES.md"),
    )?;
    copy_file(
        project_dir.join("assets/icons/LICENSE-HUGEICONS.md"),
        resources_dir.join("LICENSE-HUGEICONS.md"),
    )?;
    copy_file(
        ffmpeg_source.join("COPYING.LGPLv2.1"),
        resources_dir.join("COPYING.LGPLv2.1"),
    )?;
    make_executable(&macos_dir.join("Kuro"))?;

    create_icon(&project_dir, &build_root, &resources_dir)?;

    let executable = macos_dir.join("Kuro");
    let mut add_rpath = Command::new("install_name_tool");
    add_rpath
        .args(["-add_rpath", "@executable_path/../Frameworks"])
        .arg(&executable);
    run(&mut add_rpath)?;
    bundle_dependencies(&executable, &ffmpeg_prefix, &frameworks_dir)?;

    codesign(&app_bundle)?;
    println!("Created self-contained bundle: {}", app_bundle.display());
    println!("For distribution, sign it with your Developer ID and submit it for notarization.");
    Ok(())
}

fn run_macos(arguments: &[OsString]) -> Result<()> {
    let profile = match arguments {
        [] => "debug",
        [option] if option == "--release" => "release",
        [option] if option == "-h" || option == "--help" => {
            print_run_help();
            return Ok(());
        }
        [option] => {
            return Err(usage_error(&format!(
                "unknown option: {}",
                option.to_string_lossy()
            )))
        }
        _ => return Err(usage_error("run-macos accepts at most one option")),
    };

    require_tools(&["codesign", "open"])?;
    let project_dir = project_dir();
    let mut cargo = Command::new("cargo");
    cargo.current_dir(&project_dir).arg("build");
    if profile == "release" {
        cargo.arg("--release");
    }
    run(&mut cargo)?;

    let target_root = cargo_target_root(&project_dir)?;
    let binary = target_root.join(profile).join("kuro");
    let app = target_root.join(profile).join("Kuro.app");
    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    let contents = app.join("Contents");
    let macos_dir = contents.join("MacOS");
    fs::create_dir_all(&macos_dir)?;
    copy_file(
        project_dir.join("packaging/macos/Info.plist"),
        contents.join("Info.plist"),
    )?;
    copy_file(binary, macos_dir.join("Kuro"))?;
    make_executable(&macos_dir.join("Kuro"))?;
    codesign(&app)?;

    println!("Launching development bundle: {}", app.display());
    let mut open = Command::new("open");
    open.args(["-n"]).arg(&app);
    run(&mut open)
}

fn cargo_target_root(project_dir: &Path) -> Result<PathBuf> {
    match env::var_os("CARGO_TARGET_DIR") {
        Some(target) => {
            let target = PathBuf::from(target);
            if target.is_absolute() {
                Ok(target)
            } else {
                Ok(project_dir.join(target))
            }
        }
        None => Ok(project_dir.join("target")),
    }
}

fn create_icon(project_dir: &Path, build_root: &Path, resources_dir: &Path) -> Result<()> {
    let source = project_dir.join("assets/brand/kuro-icon.png");
    let iconset = build_root.join("Kuro.iconset");
    if iconset.exists() {
        fs::remove_dir_all(&iconset)?;
    }
    fs::create_dir_all(&iconset)?;
    for size in [16, 32, 128, 256, 512] {
        sips_resize(
            &source,
            size,
            &iconset.join(format!("icon_{size}x{size}.png")),
        )?;
        let double = size * 2;
        sips_resize(
            &source,
            double,
            &iconset.join(format!("icon_{size}x{size}@2x.png")),
        )?;
    }
    let mut iconutil = Command::new("iconutil");
    iconutil
        .args(["-c", "icns"])
        .arg(&iconset)
        .args(["-o"])
        .arg(resources_dir.join("Kuro.icns"));
    run(&mut iconutil)?;
    fs::remove_dir_all(iconset)?;
    Ok(())
}

fn sips_resize(source: &Path, size: u32, output: &Path) -> Result<()> {
    let mut sips = Command::new("sips");
    sips.args(["-z", &size.to_string(), &size.to_string()])
        .arg(source)
        .args(["--out"])
        .arg(output)
        .stdout(Stdio::null());
    run(&mut sips)
}

fn bundle_dependencies(binary: &Path, ffmpeg_prefix: &Path, frameworks_dir: &Path) -> Result<()> {
    for dependency in otool_dependencies(binary)? {
        if !dependency.starts_with(ffmpeg_prefix) {
            continue;
        }
        let basename = dependency.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "FFmpeg dependency has no filename: {}",
                    dependency.display()
                ),
            )
        })?;
        let bundled = frameworks_dir.join(basename);
        if !bundled.is_file() {
            copy_file(&dependency, &bundled)?;
            make_executable(&bundled)?;
            let name = basename.to_string_lossy();
            let mut set_id = Command::new("install_name_tool");
            set_id
                .args(["-id", &format!("@rpath/{name}")])
                .arg(&bundled);
            run(&mut set_id)?;
            bundle_dependencies(&bundled, ffmpeg_prefix, frameworks_dir)?;
        }
        let name = basename.to_string_lossy();
        let mut change = Command::new("install_name_tool");
        change
            .args(["-change"])
            .arg(&dependency)
            .arg(format!("@rpath/{name}"))
            .arg(binary);
        run(&mut change)?;
    }
    Ok(())
}

fn otool_dependencies(binary: &Path) -> Result<Vec<PathBuf>> {
    eprintln!("+ otool -L {}", binary.display());
    let output = Command::new("otool").arg("-L").arg(binary).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!("otool failed for {}", binary.display())).into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .map(PathBuf::from)
        .collect())
}

fn sysctl_logical_cpu_count() -> Result<usize> {
    eprintln!("+ sysctl -n hw.logicalcpu");
    let output = Command::new("sysctl")
        .args(["-n", "hw.logicalcpu"])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("sysctl -n hw.logicalcpu failed").into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().parse()?)
}

fn codesign(app: &Path) -> Result<()> {
    let mut command = Command::new("codesign");
    command.args(["--force", "--deep", "--sign", "-"]).arg(app);
    run(&mut command)
}

fn copy_file(source: impl AsRef<Path>, destination: impl AsRef<Path>) -> Result<()> {
    fs::copy(source, destination)?;
    Ok(())
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn require_tools(tools: &[&str]) -> Result<()> {
    for tool in tools {
        if !in_path(tool) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("Required build tool is missing: {tool}"),
            )
            .into());
        }
    }
    Ok(())
}

fn in_path(tool: &str) -> bool {
    env::var_os("PATH")
        .is_some_and(|path| env::split_paths(&path).any(|directory| directory.join(tool).is_file()))
}

fn run(command: &mut Command) -> Result<()> {
    eprintln!("+ {command:?}");
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("command exited with {status}")).into())
    }
}
