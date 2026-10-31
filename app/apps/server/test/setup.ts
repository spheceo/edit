// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
// Exports stay in the tests, never on Modal (this checkout has its worker).
process.env.EDIT_MODAL_EXPORTS ??= "0";
// A busy model is asked again after a pause (cast.ts): none in tests.
import { busyTiming } from "../src/cast.ts";
busyTiming.waitMs = 0;
// Edit asks Claude (ai_claude.ts, watch.ts); in tests the mock server's
// stand-in model answers instead (mocks/model.ts).
import { standIn } from "../src/ai_claude.ts";
import { post as standInPost } from "./mocks/model.ts";
standIn.post = standInPost;
