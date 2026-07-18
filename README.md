<h1 align="center">Kuro</h1>

Kuro is a fast, native video editor built in Rust for smooth playback, precise timeline editing, and focused cutting workflows.

## macOS development

Run Kuro as a lightweight app bundle when testing Speech transcription:

```sh
./scripts/run-macos.sh
```

The script builds the debug binary, stages and ad-hoc signs `target/debug/Kuro.app`, then launches it. Use `./scripts/run-macos.sh --release` for a release build. A bare `cargo run` executable cannot request macOS Speech Recognition permission; Kuro reports this safely in the Transcription panel instead of calling the TCC-protected API.
