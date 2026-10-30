# Exports and proxies on Modal

The house export of a whole edit whose footage is all in the cloud runs on
Modal when that's quicker than this Mac (`apps/server/src/modal_exports.ts`,
on with `EDIT_MODAL_EXPORTS=1` and `EDIT_WORKER_ROOT`, both set by `just dev`).
For each export the server runs `export_v3.py` under `infisical run` (R2's keys
from the team project's `/media`, for that process only): it deploys the
`edit-exports-v3` app when this checkout's build isn't the deployed one
(`sections_v3.py`, `api_v3.py`), then renders the edit in sections on a shared
pool of L40S GPUs, verifies every frame of the joined file on CPU workers,
makes the review copy (`review_runtime.py`) and publishes to R2. Unchanged
sections are reused from the `edit-exports-sections-v3-live` volume.

`proxy.py` is the `edit-proxies` app: small preview copies of imported footage,
asked for through Edit's relay (`apps/relay/src/jobs.ts`).

`hardware_probe.py` checks a new GPU type before it's used (graphics and both
encoders, with a bounded budget):

```sh
EDIT_MODAL_PROBE_COMPUTE_BUDGET_USD=0.20 uv run --python 3.12 --with modal==1.5.3 modal run --env dev apps/worker/hardware_probe.py
```

## Checks

```sh
uv run --python 3.12 --with httpx==0.28.1 python -m unittest discover -s apps/worker -p 'test_*.py' -v
cargo clippy -p edit-engine --bin edit-worker -- -D warnings
```

The tests need no network, GPU or credentials.
