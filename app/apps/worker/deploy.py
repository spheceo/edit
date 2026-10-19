"""Explicit deployment, with process-only configuration and active-app checks."""
import json
import os
import subprocess
import sys

import modal
from build import ROOT, build_id


def main():
    name = os.environ.get("EDIT_MODAL_APP", "edit-exports-pilot")
    environment = os.environ.get("EDIT_MODAL_ENV", "dev")
    if not name.startswith("edit-exports-") or environment != "dev":
        raise RuntimeError("Use an isolated edit-exports-* app in the existing dev environment")
    relay = os.environ.get("EDIT_RELAY_URL", "")
    token = os.environ.get("MODAL_WORKER_TOKEN", "")
    if not relay.startswith("https://") or len(token) < 32:
        raise RuntimeError("Inject EDIT_RELAY_URL and a separate MODAL_WORKER_TOKEN (32+ characters) through the process environment")
    listing = subprocess.run([sys.executable, "-m", "modal", "app", "list", "--env", environment, "--json"], check=True, capture_output=True, text=True)
    for app in json.loads(listing.stdout):
        if app.get("description") == name and int(app.get("tasks", 0)):
            raise RuntimeError("That Edit worker has active tasks; wait for them or choose a new app name")
    values = {"EDIT_RELAY_URL": relay.rstrip("/"), "MODAL_WORKER_TOKEN": token}
    secret = f"{name}-relay"
    modal.Secret.objects.create(secret, values, environment_name=environment, allow_existing=True)
    modal.Secret.from_name(secret, environment_name=environment).update(values)
    subprocess.run([sys.executable, "-m", "modal", "deploy", "apps/worker/app.py", "--env", environment], cwd=ROOT, check=True,
                   env={**os.environ, "EDIT_MODAL_APP": name})
    gateway = modal.Function.from_name(name, "gateway", environment_name=environment).get_web_url()
    print(json.dumps({"app": name, "build": build_id(), "gpu": os.environ.get("EDIT_MODAL_GPU", "L4"), "gateway": gateway}))


if __name__ == "__main__":
    main()
