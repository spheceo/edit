// The version and release flag, set by `bun build --define` in the release
// workflow (EDIT_VERSION, EDIT_RELEASE); a dev run takes the package's version
// (`just publish` bumps it with Cargo.toml's) and never updates itself.

import pkg from "../package.json" with { type: "json" };

declare const EDIT_VERSION: string | undefined;
declare const EDIT_RELEASE: boolean | undefined;

export const VERSION: string = typeof EDIT_VERSION === "string" ? EDIT_VERSION : pkg.version;

/** Whether this is a release build (only those update themselves). */
export const RELEASE: boolean = typeof EDIT_RELEASE === "boolean" ? EDIT_RELEASE : false;
