// The version and release flag, set by `bun build --define` in the release
// workflow (EDIT_VERSION, EDIT_RELEASE, and EDIT_NIGHTLY for a nightly); a dev
// run takes the package's version (`just publish` bumps it with Cargo.toml's)
// and never updates itself.

import pkg from "../package.json" with { type: "json" };

declare const EDIT_VERSION: string | undefined;
declare const EDIT_RELEASE: boolean | undefined;
declare const EDIT_NIGHTLY: number | undefined;

export const VERSION: string = typeof EDIT_VERSION === "string" ? EDIT_VERSION : pkg.version;

/** Whether this is a release build (only those update themselves). */
export const RELEASE: boolean = typeof EDIT_RELEASE === "boolean" ? EDIT_RELEASE : false;

/** A nightly's number (tag `nightly-<N>`), or null for a release (built with 0) or a dev build. */
export const NIGHTLY: number | null = typeof EDIT_NIGHTLY === "number" && EDIT_NIGHTLY > 0 ? EDIT_NIGHTLY : null;

/** This build as people see it: "nightly-12", or the version ("0.0.0"). */
export const BUILD: string = NIGHTLY !== null ? `nightly-${NIGHTLY}` : VERSION;
