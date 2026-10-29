// Bun's string matchers, which Writer's tests were written with, for vitest.
import { expect } from "vitest";

expect.extend({
  toStartWith(received: string, prefix: string) {
    return { pass: received.startsWith(prefix), message: () => `expected ${JSON.stringify(received.slice(0, 120))} to start with ${JSON.stringify(prefix)}` };
  },
  toEndWith(received: string, suffix: string) {
    return { pass: received.endsWith(suffix), message: () => `expected ${JSON.stringify(received.slice(-120))} to end with ${JSON.stringify(suffix)}` };
  },
});

declare module "vitest" {
  interface Assertion {
    toStartWith(prefix: string): void;
    toEndWith(suffix: string): void;
  }
}
