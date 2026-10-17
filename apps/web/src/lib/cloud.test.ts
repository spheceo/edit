import { describe, expect, it } from "vitest";

import { readOnly, syncLabel, type CloudStatus } from "./cloud";

const status = (fields: Partial<CloudStatus>): CloudStatus => ({ cloud: true, on: true, ...fields });

describe("cloud status", () => {
  it("is read-only only while someone else holds the lock", () => {
    expect(readOnly(status({ lock: "elsewhere", holder: "kenobi" }))).toBe(true);
    expect(readOnly(status({ lock: "held" }))).toBe(false);
    // Offline or new: edits go on, queued.
    expect(readOnly(status({ lock: "provisional" }))).toBe(false);
    expect(readOnly(null)).toBe(false);
  });

  it("says nothing for projects only on this machine or with cloud off", () => {
    expect(syncLabel({ cloud: false, on: true })).toBeNull();
    expect(syncLabel(status({ on: false, sync: "off" }))).toBeNull();
  });

  it("names each sync state", () => {
    expect(syncLabel(status({ sync: "synced" }))?.text).toBe("Saved to cloud");
    expect(syncLabel(status({ sync: "pending" }))?.tone).toBe("busy");
    expect(syncLabel(status({ sync: "offline" }))?.text).toBe("Offline · will sync");
    expect(syncLabel(status({ sync: "conflict" }))?.tone).toBe("bad");
    expect(syncLabel(status({ sync: "readonly" }))?.text).toBe("Read-only");
  });

  it("says when files are neither here nor in the cloud, read-only still first", () => {
    const missing = "1 file isn't on this machine and not in the cloud (map.mp4)";
    expect(syncLabel(status({ sync: "synced", missing }))?.text).toBe("Files missing");
    expect(syncLabel(status({ sync: "readonly", missing }))?.text).toBe("Read-only");
  });
});
