"""Deterministic deployment identity, without reading local configuration."""
import hashlib
import os
from pathlib import Path

ROOT = Path(os.environ["EDIT_WORKER_SOURCE_ROOT"]) if "EDIT_WORKER_SOURCE_ROOT" in os.environ else Path(__file__).resolve().parents[2]


def fingerprint(worker):
    digest = hashlib.sha256()
    paths = [ROOT / "Cargo.toml", ROOT / "Cargo.lock"]
    folders = ["crates/edit-core", "crates/edit-render", "crates/edit-engine", "crates/edit-native", "crates/edit-wasm", "crates/edit-window"]
    for folder in folders + (["apps/worker"] if worker else []):
        paths.extend(path for path in (ROOT / folder).rglob("*") if path.is_file()
                     and not any(part in {"node_modules", "__pycache__", ".venv", "target"} for part in path.parts)
                     and path.suffix not in {".pyc", ".node"})
    for path in sorted(set(paths)):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def build_id():
    return fingerprint(True)


# What draws, mixes and encodes a section (edit-worker's own code and what it
# calls), as the engine's build.rs names its EDIT_RENDER_SOURCE: a change
# anywhere else (the window, the WASM wrapper, the addon, tracking, faces,
# tests) used to count too, so nearly every commit redrew all eight sections
# of the next export on the GPUs (Oct 31: three full redraws of the same two
# videos in a day, at about $1 each).
ENGINE_PATHS = [
    "Cargo.toml", "Cargo.lock",
    "crates/edit-core/Cargo.toml", "crates/edit-core/src",
    "crates/edit-render/Cargo.toml", "crates/edit-render/src", "crates/edit-render/fonts",
    "crates/edit-engine/Cargo.toml", "crates/edit-engine/build.rs", "crates/edit-engine/src/bin",
    *(f"crates/edit-engine/src/{name}.rs" for name in ["lib", "render", "export", "chunks", "mix", "util", "media", "mac_media", "log"]),
]


def engine_id():
    """Drawing/encoding dependencies, independent of transfers and deployment."""
    digest = hashlib.sha256()
    paths = []
    for name in ENGINE_PATHS:
        path = ROOT / name
        paths.extend(sorted(item for item in path.rglob("*") if item.is_file()) if path.is_dir() else [path] if path.is_file() else [])
    for path in paths:
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    recipe = ROOT / "apps/worker/app.py"
    if recipe.exists():
        digest.update(recipe.read_bytes())
    return digest.hexdigest()


if __name__ == "__main__":
    print(build_id())
