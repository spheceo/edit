#!/usr/bin/env python3
"""Deploys everything of Edit's on Modal to one environment:

    EDIT_MODAL_ENV=main python apps/worker/deploy_cloud.py   # production (release.yml, a nightly's tag)
    EDIT_MODAL_ENV=dev  python apps/worker/deploy_cloud.py   # dev, by hand

the cloud proxies (`edit-proxies`, proxy.py) and the export pool with the API
the relay calls (`edit-exports-v3`, `edit-exports-v3-api`: export_v3.deploy).
Needs Modal's token (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET) in the environment,
and the environment's secrets made once by hand: `edit-proxies-token`
(EDIT_PROXY_TOKEN) and `edit-exports-v3-cloud` (R2_*, EDIT_V3_TOKEN). Prints
each web endpoint, for the relay's MODAL_PROXY_URL and MODAL_V3_URL.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/worker"))
os.environ.setdefault("MODAL_IMAGE_BUILDER_VERSION", "2025.06")  # the pinned modal 1.5.3 refuses a new workspace's 2026.10

import export_v3  # noqa: E402
from build import build_id  # noqa: E402

environment = export_v3.ENVIRONMENT
if environment not in ("dev", "main"):
    raise SystemExit("EDIT_MODAL_ENV must be dev or main")
subprocess.run([sys.executable, "-m", "modal", "deploy", "apps/worker/proxy.py", "--env", environment], cwd=ROOT, check=True)
export_v3.deploy(build_id(), lambda: None, lambda phase, progress: print(phase, flush=True))
import modal  # noqa: E402
print("proxies:", modal.Function.from_name("edit-proxies", "endpoint", environment_name=environment).get_web_url())
print("exports api:", modal.Function.from_name("edit-exports-v3-api", "api", environment_name=environment).get_web_url())
