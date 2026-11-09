// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
// Nor the live relay: a test without its own mock relay (mocks/server.ts useEnv) asks a closed port, so a
// relay check it makes (voices.ts' pyannote flag, Nov 9: the live relay's "on" sent a captions test to Scribe)
// is "unreachable", never production's answer.
process.env.EDIT_RELAY_URL ??= "http://127.0.0.1:9";
// A busy model is asked again after a pause (cast.ts): none in tests.
import { busyTiming } from "../src/cast.ts";
busyTiming.waitMs = 0;
// Edit asks Claude (ai_claude.ts, watch.ts); in tests the mock server's
// stand-in model answers instead (mocks/model.ts).
import { standIn } from "../src/ai_claude.ts";
import { post as standInPost } from "./mocks/model.ts";
standIn.post = standInPost;
