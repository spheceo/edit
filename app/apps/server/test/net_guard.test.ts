// net_guard.ts's tests (the audit's F2): the agent's web reading never reaches this Mac or its network.

import { expect, test } from "bun:test";

import { isPrivateAddress, publicUrl, safeFetch } from "../src/net_guard.ts";
import { readPage } from "../src/research.ts";

const publicDns = async () => ["93.184.216.34"];

test("private, loopback, link-local, CGNAT, multicast and mapped addresses are not the web", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.80.66.124", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1"]) {
    expect(isPrivateAddress(ip)).toBe(true);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
});

test("only public http(s) addresses on the usual ports", async () => {
  expect((await publicUrl("https://example.com/a?b=1", publicDns)).href).toBe("https://example.com/a?b=1");
  for (const bad of ["http://127.0.0.1:7700/api/projects", "http://localhost/api/fs", "http://edit.local/", "http://[::1]/", "https://example.com:8443/", "file:///etc/passwd", "ftp://example.com/", "https://user:pw@example.com/"]) {
    await expect(publicUrl(bad, publicDns)).rejects.toThrow();
  }
  // A public-looking name that resolves inside (DNS pointing at this Mac).
  await expect(publicUrl("https://sneaky.example/", async () => ["127.0.0.1"])).rejects.toThrow("on this Mac or its network");
});

test("a redirect to this Mac is refused; to another public page it's followed", async () => {
  const hops: string[] = [];
  const fetcher = async (url: string) => {
    hops.push(url);
    if (url === "https://example.com/start") return new Response(null, { status: 302, headers: { location: "https://example.org/next" } });
    if (url === "https://example.org/next") return new Response(null, { status: 301, headers: { location: "http://127.0.0.1:7700/api/account" } });
    return new Response("ok");
  };
  await expect(safeFetch("https://example.com/start", {}, { lookup: publicDns, fetcher })).rejects.toThrow();
  expect(hops).toEqual(["https://example.com/start", "https://example.org/next"]);
  const fine = await safeFetch("https://example.com/other", {}, { lookup: publicDns, fetcher });
  expect(await fine.text()).toBe("ok");
});

test("read_page refuses Edit's own API", async () => {
  await expect(readPage("http://127.0.0.1:7700/api/projects", 1000)).rejects.toThrow();
  await expect(readPage("http://127.0.0.1/api/projects", 1000)).rejects.toThrow("on this Mac or its network");
});
