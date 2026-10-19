# Real decoder playback regression

`preview.html` exercises the real browser decoder, WASM compositor and playback
loop. Unit tests cannot establish whether a decoded picture matches `currentTime`.
It checks cut colours, black flashes, seeking after playback ends, and rapid seeks
that must finish on the latest requested frame. Reloading also exercises saved
playhead restoration.

Use an isolated data directory, with FFmpeg installed:

```sh
just wasm
cargo run -p edit -- serve --host 127.0.0.1 --port 7711 --home /tmp/edit-preview-test/home
```

In another terminal:

```sh
EDIT_HTTPS=0 EDIT_SERVER=http://127.0.0.1:7711 bun run --cwd apps/web dev --host 127.0.0.1 --port 5174
```

Then prepare a project and open the printed URL in a WebGPU browser:

```sh
python3 apps/web/tests/prepare_preview.py
```

Wait for the initial picture, click **Run playback checks**, and expect `PASS`.
Reload the page after the test: `restoredFrame` should be 5. Fixtures use synthetic
320×180, 30 fps all-intra video; this is a correctness regression, not a benchmark
for long recordings, variable frame rate, HDR or slower devices. Delete the
temporary data directory after stopping the two servers.
