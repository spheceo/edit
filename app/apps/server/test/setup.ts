// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
// A busy AI gateway is asked again after a pause (cast.ts): none in tests.
import { busyTiming } from "../src/cast.ts";
busyTiming.waitMs = 0;
