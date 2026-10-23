// Reading the web for the agent without reaching this Mac or its network (the
// audit's F2, Oct 23: read_page fetched any http(s) address and followed
// redirects, so http://127.0.0.1:7700/api/… answered, Bun's fetch sending no
// Origin for the cross-site guard to see). An address the agent gives is
// fetched only when it's http or https on the usual ports and every address
// its name resolves to is public; each redirect is checked the same way.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (host: string) => Promise<string[]>;

const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((one) => one.address);

const MAX_REDIRECTS = 5;

/** Whether `ip` (v4 or v6) is somewhere a public page can't be: this Mac, its network, link-local, multicast, reserved. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase().replace(/^\[|\]$/gu, "");
    if (low === "::" || low === "::1") return true;
    // An IPv4 address inside (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::a.b.c.d): judged as that.
    const v4 = /(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/u.exec(low)?.[1];
    if (v4 !== undefined) return isPrivateAddress(v4);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(low);
    if (mapped !== null) {
      const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(low.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

/** Tests reading pages from their mock on this Mac: only under `bun test`, only when the mock says so. */
function localAllowedForTests(url: URL): boolean {
  return process.env.NODE_ENV === "test" && process.env.EDIT_TEST_LOCAL_WEB === "1" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** `given` when it's a public web address (else why not, thrown). */
export async function publicUrl(given: string | URL, lookup: Lookup = systemLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error("give a web address (http or https)");
  }
  if (localAllowedForTests(url)) return url;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("give a web address (http or https)");
  if (url.username !== "" || url.password !== "") throw new Error("that address carries a sign-in: give the page's own address");
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new Error("only web pages on the usual ports (80, 443) can be read");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (host === "" || host === "localhost" || /\.(?:local|localhost|internal|lan|home\.arpa)$/u.test(host)) {
    throw new Error("that address is on this Mac or its network, not the web");
  }
  const addresses = isIP(host) !== 0 ? [host] : await lookup(host).catch(() => {
    throw new Error(`couldn't find ${host}`);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("that address is on this Mac or its network, not the web");
  return url;
}

/** `fetch` for an address the agent gave: only public addresses, every redirect checked, at most a few. */
export async function safeFetch(
  given: string,
  init: RequestInit = {},
  options: { lookup?: Lookup; fetcher?: (url: string, init: RequestInit) => Promise<Response> } = {},
): Promise<Response> {
  const fetcher = options.fetcher ?? ((url: string, request: RequestInit) => fetch(url, request));
  let url = await publicUrl(given, options.lookup);
  for (let hop = 0; ; hop++) {
    const response = await fetcher(url.href, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    void response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error("that page redirects too many times");
    url = await publicUrl(new URL(location, url), options.lookup);
  }
}
