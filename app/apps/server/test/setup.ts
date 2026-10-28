// Loaded before every test file (bunfig.toml): a run never uses this Mac's
// own Chrome sign-in to YouTube (youtube_signin.ts); tests that want one turn
// it on against a stand-in Chrome folder.
process.env.EDIT_YOUTUBE_SIGNIN = "0";
