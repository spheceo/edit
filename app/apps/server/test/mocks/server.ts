// One mock for every paid or remote service the server calls: Edit's relay
// (transcription, speech, voices, cloud: presigned R2 URLs and Convex), the AI
// gateway (Gemini through Vercel), and Google (OAuth tokens, Drive, Docs). It
// records every request, answers with canned defaults, and a test overrides
// any route with `on`.
//
// `useEnv()` points the server at it: EDIT_RELAY_URL (the relay's base),
// EDIT_AI_GATEWAY_URL (the gateway's base: chat completions go to <base>/v1/chat/completions) and
// EDIT_GOOGLE_API_URL (standing in for https://www.googleapis.com, OAuth's
// token endpoint included as /token).

import type { Server } from "bun";

import { CloudMock } from "./cloud.ts";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export type MockHandler = (request: Recorded, mock: MockServer) => Response | Promise<Response>;

interface Route {
  method: string;
  path: string | RegExp;
  handler: MockHandler;
  /** Answers this many times, then steps aside (undefined: always). */
  times?: number;
}

/** A Scribe answer saying `words` (half a second each, one speaker). */
export function scribeAnswer(words: string[] = ["Hello", "there."], speaker = "speaker_0"): unknown {
  return {
    language_code: "eng",
    words: words.flatMap((text, index) => [
      { text, start: index * 0.5, end: index * 0.5 + 0.4, type: "word", speaker_id: speaker },
      { text: " ", start: index * 0.5 + 0.4, end: index * 0.5 + 0.5, type: "spacing" },
    ]),
  };
}

export class MockServer {
  readonly requests: Recorded[] = [];
  /** The relay's cloud routes, R2 behind its presigned URLs, and Convex's `edit:` functions (mocks/cloud.ts). */
  readonly cloud: CloudMock;
  /** What the gateway's model answers (the message content). */
  gatewayAnswer = "{}";
  /** The answer to the watcher's who-is-who call (cast.ts), when set; else it gets `gatewayAnswer` like any call. */
  castAnswer: string | null = null;
  /** The answer to a second look at a disputed turn (bridges.ts), when set; else it gets `gatewayAnswer`. */
  bridgeAnswer: string | null = null;
  private routes: Route[] = [];
  private server: Server<undefined>;

  private constructor() {
    this.cloud = new CloudMock(this);
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = new Uint8Array(await request.arrayBuffer());
        const recorded: Recorded = {
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body,
          text: () => new TextDecoder().decode(body),
          json: <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
        };
        this.requests.push(recorded);
        // The latest route that fits wins, so a test's `on` beats the defaults.
        for (let index = this.routes.length - 1; index >= 0; index--) {
          const route = this.routes[index]!;
          if (route.method !== request.method && route.method !== "*") continue;
          const fits = typeof route.path === "string" ? route.path === url.pathname : route.path.test(url.pathname);
          if (!fits) continue;
          if (route.times !== undefined) {
            if (route.times <= 0) continue;
            route.times -= 1;
          }
          return route.handler(recorded, this);
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    this.defaults();
  }

  /** Objects put through presigned URLs (R2), by key. */
  get objects(): Map<string, Uint8Array> {
    return this.cloud.objects;
  }

  static start(): MockServer {
    return new MockServer();
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Answers `method path` with `handler` (the latest one wins); `times` limits how often. */
  on(method: string, path: string | RegExp, handler: MockHandler, times?: number): this {
    this.routes.push({ method, path, handler, times });
    return this;
  }

  /** The requests made to `path` (and `method`). */
  calls(path: string | RegExp, method?: string): Recorded[] {
    return this.requests.filter(
      (request) =>
        (method === undefined || request.method === method) &&
        (typeof path === "string" ? request.path === path : path.test(request.path)),
    );
  }

  /** The environment that points Edit at this mock. */
  env(): Record<string, string> {
    return {
      EDIT_RELAY_URL: this.url,
      EDIT_AI_GATEWAY_URL: this.url,
      EDIT_GOOGLE_API_URL: this.url,
    };
  }

  /** Sets `env()` (and any `extra`) in process.env; returns what puts it back. */
  useEnv(extra: Record<string, string | undefined> = {}): () => void {
    // Pages the tests serve from here may be read (net_guard.ts allows it only under bun test).
    const values = { EDIT_TEST_LOCAL_WEB: "1", ...this.env(), ...extra };
    const before = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
      before.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  /**
   * Shares a Google Doc with anyone who has the link: its HTML export at
   * `/docs.google.com/document/d/<id>/export` (EDIT_GOOGLE_API_URL's layout).
   */
  doc(id: string, html: string, title?: string): this {
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (title !== undefined) headers["content-disposition"] = `attachment; filename="${title}.html"`;
    return this.on("GET", `/docs.google.com/document/d/${id}/export`, () => new Response(html, { headers }));
  }

  /**
   * Shares a Drive file with anyone who has the link: Drive's download URL
   * (`/drive.usercontent.google.com/download?id=<file>`) sends `bytes` as
   * `name`, honouring byte ranges (a probe's first byte, a resumed download)
   * as Drive does.
   */
  driveFile(file: string, bytes: Uint8Array, name: string, type = "video/mp4"): this {
    return this.on("GET", "/drive.usercontent.google.com/download", (request) => {
      if (request.query.get("id") !== file) {
        // Another file: whatever answered before (or Drive's 404).
        return new Response("", { status: 404 });
      }
      const headers = { "content-type": type, "content-disposition": `attachment; filename="${name}"` };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      if (range === null) return new Response(bytes, { headers });
      const from = Number(range[1]);
      if (from >= bytes.length) return new Response("", { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
      const to = range[2] === "" ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
      return new Response(bytes.slice(from, to + 1), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${from}-${to}/${bytes.length}` },
      });
    });
  }

  stop(): void {
    void this.server.stop(true);
  }

  private defaults(): void {
    // The relay.
    this.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer()));
    this.on("POST", "/v1/speech", () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { "content-type": "audio/mpeg" } }));
    this.on("GET", "/v1/voices", () => Response.json({ voices: [] }));
    // The cloud: /v1/cloud/*, R2 behind presigned URLs, Convex.
    this.cloud.install();
    // The AI gateway (OpenAI-style chat completions).
    this.on("POST", "/v1/chat/completions", async (request, mock) => {
      const asked = await request.text();
      const content =
        mock.castAnswer !== null && asked.includes('"name":"cast"')
          ? mock.castAnswer
          : mock.bridgeAnswer !== null && asked.includes('"name":"who"')
            ? mock.bridgeAnswer
            : mock.gatewayAnswer;
      return Response.json({ choices: [{ message: { role: "assistant", content } }] });
    });
    // Google.
    this.on("POST", "/token", () => Response.json({ access_token: "mock-access-token", expires_in: 3600, token_type: "Bearer" }));
    this.on("GET", "/drive/v3/files", () => Response.json({ files: [] }));
    // As endpoints.ts sends them: the Google host first in the path.
    this.on("POST", "/oauth2.googleapis.com/token", () =>
      Response.json({ access_token: "mock-access-token", expires_in: 3600, token_type: "Bearer" }),
    );
    this.on("GET", "/www.googleapis.com/drive/v3/files", () => Response.json({ files: [] }));
  }
}
