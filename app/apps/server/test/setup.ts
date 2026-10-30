// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
// Exports stay in the tests, never on Modal (this checkout has its worker).
process.env.EDIT_MODAL_EXPORTS ??= "0";
// A busy AI gateway is asked again after a pause (cast.ts): none in tests.
import { busyTiming } from "../src/cast.ts";
busyTiming.waitMs = 0;
// Edit asks Claude (ai_claude.ts, watch.ts) where it asked Gemini; the tests'
// stand-in AI gateway answers instead, as it answered for Gemini.
import { viaGateway } from "../src/ai_claude.ts";
viaGateway.on = true;
