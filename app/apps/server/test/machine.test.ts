import { expect, test } from "bun:test";

import { hashed, id, platformUuid } from "../src/machine.ts";

test("the computer's id hashes the platform UUID as Writer does", () => {
  const ioreg = '+-o J314sAP  <class IOPlatformExpertDevice>\n    "IOPlatformSerialNumber" = "X"\n    "IOPlatformUUID" = "1B2C3D4E-0000-1111-2222-333344445555"\n';
  expect(platformUuid(ioreg)).toBe("1B2C3D4E-0000-1111-2222-333344445555");
  // The same value Writer's machine.rs test expects.
  expect(hashed("1B2C3D4E-0000-1111-2222-333344445555")).toBe("4a96f96fd1a3ae9208835d1c");
  expect(id()).toMatch(/^[0-9a-f]{24}$/);
});
