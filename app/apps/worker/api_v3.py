"""The v3 exporter's door for an Edit installed on anyone's Mac: the relay
(which signed the person in) calls this with the shared token, and it starts
the export or review copy on `edit-exports-v3` (sections_v3.py) and says how
it's going. Its own small app: that one's module needs the engine's image,
which a web container doesn't have."""
import hmac
import os

import modal

APP = "edit-exports-v3"
PROGRESS = APP + "-progress"
PHASE_SHARE = {"queued": .03, "staged": .10, "planned": .12, "picture_finished": .74, "assembled": .78, "verified": .86, "uploaded": .90}

app = modal.App(APP + "-api")
image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]==0.115.12")
cloud = modal.Secret.from_name(APP + "-cloud", required_keys=["EDIT_V3_TOKEN"])


@app.function(image=image, secrets=[cloud], cpu=0.25, memory=256, max_containers=4, scaledown_window=120, timeout=60)
@modal.fastapi_endpoint(method="POST")
def api(body: dict):
    """start_export / start_review {job} -> {call}; status {call, id} -> {state, progress, result | error}; cancel {call}."""
    if not hmac.compare_digest(str(body.get("token", "")), os.environ["EDIT_V3_TOKEN"]):
        return {"error": "not allowed"}
    action = body.get("action")
    if action in ("start_export", "start_review"):
        run = modal.Function.from_name(APP, "run_export" if action == "start_export" else "run_review")
        return {"call": run.spawn(body["job"]).object_id}
    call = modal.FunctionCall.from_id(str(body.get("call", "")))
    if action == "cancel":
        call.cancel(terminate_containers=True)
        return {"state": "cancelled"}
    if action == "status":
        try:
            return {"state": "done", "result": call.get(timeout=0)}
        except TimeoutError:
            progress = 0.0
            try:
                state = modal.Dict.from_name(PROGRESS, create_if_missing=True).get(str(body.get("id", "")))
            except Exception:
                state = None
            if state:
                phase = state.get("phase")
                if phase in PHASE_SHARE:
                    progress = PHASE_SHARE[phase]
                elif phase == "section" and state.get("sections"):
                    done = state.get("cached", 0) + state.get("rendered", 0)
                    progress = PHASE_SHARE["planned"] + (PHASE_SHARE["picture_finished"] - PHASE_SHARE["planned"]) * done / state["sections"]
            return {"state": "running", "progress": progress}
        except Exception as error:
            return {"state": "failed", "error": str(error)[:500]}
    return {"error": "unknown action"}
