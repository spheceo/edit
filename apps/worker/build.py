"""Deterministic deployment identity, without reading local configuration."""
import hashlib
import os
from pathlib import Path

ROOT = Path(os.environ["EDIT_WORKER_SOURCE_ROOT"]) if "EDIT_WORKER_SOURCE_ROOT" in os.environ else Path(__file__).resolve().parents[2]


def build_id():
    digest = hashlib.sha256()
    paths = [ROOT / "Cargo.toml", ROOT / "Cargo.lock"]
    for folder in ["crates/edit-core", "crates/edit-render", "crates/edit-engine", "crates/edit-native", "crates/edit-wasm", "crates/edit-window", "apps/worker"]:
        paths.extend(path for path in (ROOT / folder).rglob("*") if path.is_file()
                     and not any(part in {"node_modules", "__pycache__", ".venv", "target"} for part in path.parts)
                     and path.suffix not in {".pyc", ".node"})
    for path in sorted(set(paths)):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


if __name__ == "__main__":
    print(build_id())
