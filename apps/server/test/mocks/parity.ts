// The parity run's stand-in for every outside service (scripts/parity/run.ts):
// a MockServer with canned answers that are a function of the request alone,
// so the Rust and the TS server, each given its own instance, get the same
// answers and their calls can be compared afterwards.
//
// - Relay: Scribe transcripts as long as the audio sent (ffprobe on the
//   body), the house voice's speech (a real MP3), the voice list, and the
//   cloud (mocks/cloud.ts, in memory).
// - AI gateway: watch windows ("watched": a speaker per listed line, the
//   segments) and seats ("faces": a box per named person), each answer
//   derived from the prompt; anything else gets `{}`.
// - Google: the sign-in, the sound library's Drive folders (real sounds),
//   a script Doc and its Drive footage, Drive uploads and file checks.
// - Plain pages and images for research (`/news/…`, `/img/…`).
//
// `record` keeps every answer it gave, keyed by the request's hash (method,
// path, query, body), and `replay` gives them back: a run can be repeated
// against a saved recording (`--replay`), or a recording compared with
// another server's.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { MockServer, type Recorded } from "./server.ts";

export interface ParityFiles {
  /** A real MP3 (the house voice's speech). */
  speech: string;
  /** A short WAV (a library sound effect). */
  sfx: string;
  /** A long AAC (library music). */
  music: string;
  /** A short MP4 (the script's Drive footage). */
  footage: string;
  /** A JPEG (research images). */
  photo: string;
}

/** The script Doc the parity run imports (its footage is `SCRIPT_FILE` on Drive). */
export const SCRIPT_DOC = "DOCparity12345";
export const SCRIPT_FILE = "1PARITYfootage01";

/** The library's root folder (EDIT_LIBRARY_FOLDER). */
export const LIBRARY_ROOT = "libroot";

const WORDS =
  "so we got the call around nine and when we pulled up the door was open and nobody answered " +
  "she said her brother had been home all day but the neighbours told us something different " +
  "we checked the back room first then the garage and that is where we found the car " +
  "do you know why we are here tonight I do not know what you are talking about " +
  "okay let us start from the beginning where were you on Saturday night";

/** A Scribe answer for `seconds` of audio: words at a steady pace, two voices taking turns. */
export function scribeFor(seconds: number): unknown {
  const vocabulary = WORDS.split(" ");
  const words: unknown[] = [];
  let at = 0.3;
  let index = 0;
  while (at + 0.4 < seconds) {
    const sentence = Math.floor(index / 9);
    const speaker = `speaker_${sentence % 2}`;
    let text = vocabulary[index % vocabulary.length]!;
    if (index % 9 === 0) text = text[0]!.toUpperCase() + text.slice(1);
    const last = index % 9 === 8;
    if (last) text += sentence % 3 === 2 ? "?" : ".";
    words.push({ text, start: round(at), end: round(at + 0.32), type: "word", speaker_id: speaker, logprob: -0.05 });
    const gap = last ? 0.9 : 0.1;
    words.push({ text: " ", start: round(at + 0.32), end: round(at + 0.32 + gap), type: "spacing", speaker_id: speaker });
    at += 0.32 + gap;
    index += 1;
  }
  return { language_code: "eng", language_probability: 0.99, text: "", words };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The duration of `body` (audio or video) by ffprobe, or 0. */
function durationOf(body: Uint8Array): number {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "parity-probe-"));
  try {
    const file = nodePath.join(dir, "body");
    fs.writeFileSync(file, body);
    const out = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const seconds = Number(out.stdout.toString().trim());
    return Number.isFinite(seconds) ? seconds : 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface ChatRequest {
  messages?: { role: string; content: unknown }[];
  response_format?: { json_schema?: { name?: string; schema?: { properties?: { people?: { items?: { properties?: { name?: { enum?: string[] } } } } } } } };
}

function userText(request: ChatRequest): string {
  const user = request.messages?.find((message) => message.role === "user");
  if (typeof user?.content === "string") return user.content;
  if (Array.isArray(user?.content)) {
    return user.content
      .map((part) => (part as { type?: string; text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

/** Gemini's answer to a watch window: who says each listed line, and the segments. */
export function watchedAnswer(text: string): unknown {
  const lines = [...text.matchAll(/^(\d+) \[([\d.]+)–([\d.]+)\] ([^:]*):/gm)].map((match) => ({
    n: Number(match[1]),
    start: Number(match[2]),
    end: Number(match[3]),
    label: match[4]!,
  }));
  const length = Number(/is ([\d.]+) seconds long/.exec(text)?.[1] ?? "0");
  return {
    people: [
      { id: "A", look: "officer in a dark uniform", where: "left", on_screen: true, name: "", role: "officer" },
      { id: "B", look: "woman in a grey hoodie", where: "right", on_screen: true, name: "Dana", role: "civilian" },
    ],
    // Every fifth line is someone else than the transcript says.
    lines: lines.map((line) => ({
      n: line.n,
      who: (line.n % 5 === 4) !== line.label.startsWith("speaker_1") ? "B" : "A",
      sure: line.n % 7 === 3 ? "low" : "high",
      or: line.n % 7 === 3 ? "A" : null,
    })),
    segments:
      length > 0
        ? [
            { start: 0, end: Math.min(length, 20), kind: "captioned", note: "the opening card" },
            { start: Math.min(length, 20), end: length, kind: "footage", note: "" },
          ]
        : [],
    background: [],
  };
}

/** Gemini's answer for seats: a face box per named person, left to right. */
export function facesAnswer(names: string[]): unknown {
  return {
    people: names.map((name, index) => {
      const x = 0.12 + (0.7 * index) / Math.max(1, names.length);
      return { name, face: [x, 0.22, x + 0.14, 0.46] };
    }),
  };
}

export class ParityMock {
  readonly server: MockServer;
  /** Every answer given, by request hash (`record`), or the answers to give (`replay`). */
  readonly answers = new Map<string, { status: number; type: string; body: string }>();

  constructor(
    readonly files: ParityFiles,
    readonly replay: Map<string, { status: number; type: string; body: string }> | null = null,
  ) {
    this.server = MockServer.start();
    this.install();
  }

  get url(): string {
    return this.server.url;
  }

  env(): Record<string, string> {
    return { ...this.server.env(), EDIT_LIBRARY_FOLDER: LIBRARY_ROOT };
  }

  stop(): void {
    this.server.stop();
  }

  /** The hash a request's answer is kept under. */
  static key(request: Recorded): string {
    const query = [...request.query.entries()].sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha256")
      .update(`${request.method} ${request.path}?${JSON.stringify(query)}\n`)
      .update(request.body)
      .digest("hex")
      .slice(0, 24);
  }

  /** The calls made, for comparing two servers' (bodies by hash, mock URLs as `<mock>`). */
  calls(): string[] {
    return this.server.requests.map((request) => `${request.method} ${request.path}`);
  }

  private answer(handler: (request: Recorded) => Response | Promise<Response>) {
    return async (request: Recorded): Promise<Response> => {
      const key = ParityMock.key(request);
      const kept = this.replay?.get(key);
      if (kept !== undefined) {
        return new Response(Buffer.from(kept.body, "base64"), { status: kept.status, headers: { "content-type": kept.type } });
      }
      const response = await handler(request);
      const body = new Uint8Array(await response.clone().arrayBuffer());
      this.answers.set(key, {
        status: response.status,
        type: response.headers.get("content-type") ?? "application/octet-stream",
        body: Buffer.from(body).toString("base64"),
      });
      return response;
    };
  }

  private install(): void {
    const mock = this.server;
    const read = (path: string) => new Uint8Array(fs.readFileSync(path));
    // The relay: transcripts as long as the audio, speech, voices.
    mock.on("POST", "/v1/transcribe", this.answer((request) => Response.json(scribeFor(durationOf(request.body)))));
    mock.on("PUT", "/v1/transcribe", this.answer((request) => Response.json(scribeFor(durationOf(request.body)))));
    mock.on("POST", "/v1/speech", this.answer(() => new Response(read(this.files.speech), { headers: { "content-type": "audio/mpeg" } })));
    mock.on(
      "GET",
      "/v1/voices",
      this.answer(() =>
        Response.json({
          voices: [
            { voice_id: "house", name: "House narrator", category: "professional", labels: { accent: "american" } },
            { voice_id: "second", name: "Second voice", category: "premade", labels: {} },
          ],
        }),
      ),
    );
    // The gateway: watch windows and faces, answered from the prompt.
    mock.on(
      "POST",
      "/v1/chat/completions",
      this.answer((request) => {
        const body = request.json<ChatRequest>();
        const schema = body.response_format?.json_schema;
        let content: unknown = {};
        if (schema?.name === "watched") content = watchedAnswer(userText(body));
        else if (schema?.name === "faces") content = facesAnswer(schema.schema?.properties?.people?.items?.properties?.name?.enum ?? []);
        return Response.json({
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.001 },
        });
      }),
    );
    // Google: the library's Drive folders.
    const folder = "application/vnd.google-apps.folder";
    const sfxSize = fs.statSync(this.files.sfx).size;
    const musicSize = fs.statSync(this.files.music).size;
    const listing: Record<string, unknown[]> = {
      [LIBRARY_ROOT]: [
        { id: "music", name: "Music", mimeType: folder },
        { id: "sfx", name: "Sound effects", mimeType: folder },
        { id: "index", name: "index.txt", mimeType: "text/plain" },
        { id: "guide", name: "Usage guide", mimeType: "application/vnd.google-apps.document" },
      ],
      music: [
        { id: "tension", name: "Tension", mimeType: folder },
        { id: "sad", name: "Sad", mimeType: folder },
      ],
      tension: [
        { id: "song1", name: "Pressure Drop - Max Anson.m4a", mimeType: "audio/mp4", size: String(musicSize), md5Checksum: "a1a1a1a1a1a1a1a1" },
      ],
      sad: [
        { id: "song2", name: "Drifting Off - Hanna Lindgren.m4a", mimeType: "audio/mp4", size: String(musicSize), md5Checksum: "b2b2b2b2b2b2b2b2" },
      ],
      sfx: [
        { id: "hits", name: "Hits", mimeType: folder },
        { id: "whooshes", name: "Whooshes", mimeType: folder },
      ],
      hits: [{ id: "boom", name: "Boom, Deep Hit - Epidemic Sound.wav", mimeType: "audio/wav", size: String(sfxSize), md5Checksum: "c3c3c3c3c3c3c3c3" }],
      whooshes: [{ id: "whoosh", name: "Whoosh, Fast - Epidemic Sound.wav", mimeType: "audio/wav", size: String(sfxSize), md5Checksum: "d4d4d4d4d4d4d4d4" }],
    };
    mock.on(
      "GET",
      "/www.googleapis.com/drive/v3/files",
      this.answer((request) => {
        const parent = /'([^']+)' in parents/.exec(request.query.get("q") ?? "")?.[1] ?? "";
        return Response.json({ files: listing[parent] ?? [] });
      }),
    );
    mock.on(
      "GET",
      "/www.googleapis.com/drive/v3/files/index",
      this.answer(
        () =>
          new Response(
            "MUSIC & SFX LIBRARY\n\n[Music / Tension]\nPressure Drop - Max Anson.m4a\nSource note: Builds slowly: Epidemic Sound\n\n" +
              "[Sound effects / Hits]\nBoom, Deep Hit - Epidemic Sound.wav\nSource note: Hit at 0 s: Epidemic Sound\n",
          ),
      ),
    );
    mock.on("GET", "/www.googleapis.com/drive/v3/files/guide/export", this.answer(() => new Response("\u{feff}Hits go on cuts. Music sits under speech.\n")));
    for (const [id, path] of [
      ["boom", this.files.sfx],
      ["whoosh", this.files.sfx],
      ["song1", this.files.music],
      ["song2", this.files.music],
    ] as const) {
      mock.on("GET", `/www.googleapis.com/drive/v3/files/${id}`, this.answer(() => new Response(read(path))));
    }
    // Drive uploads (an export of a subtitled video) and the checks on them.
    mock.on(
      "POST",
      "/www.googleapis.com/upload/drive/v3/files",
      this.answer(() => new Response(null, { status: 200, headers: { location: `${mock.url}/www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=parity` } })),
    );
    mock.on("PUT", "/www.googleapis.com/upload/drive/v3/files", () => Response.json({ id: "upload1", name: "export.mp4" }));
    mock.on("POST", /^\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+\/permissions$/, this.answer(() => Response.json({ id: "anyoneWithLink" })));
    mock.on("GET", "/www.googleapis.com/drive/v3/files/upload1", this.answer(() => Response.json({ id: "upload1", trashed: false })));
    mock.on("GET", /^\/www\.googleapis\.com\/drive\/v3\/files\/1[^/]*$/, this.answer(() => Response.json({ id: "x", trashed: false })));
    // The script: a Doc with two footage links into one Drive file.
    const link = (range: string) =>
      `<a href="https://www.google.com/url?q=https://drive.google.com/file/d/${SCRIPT_FILE}/view?usp%3Dsharing&amp;sa=D">${range}</a>`;
    mock.doc(
      SCRIPT_DOC,
      `<html><head><title>Parity case</title></head><body>
<p><span>Parity case</span></p>
<p><span>(</span>${link("00:01 - 00:04")}<span>)</span></p>
<p><span>On a Saturday night in March, officers were called to a house on Elm Street.</span></p>
<p><span>(</span>${link("00:06 - 00:10")}<span>)</span></p>
<p><span>What they found inside would change the case.</span></p>
</body></html>`,
      "Parity case",
    );
    mock.driveFile(SCRIPT_FILE, read(this.files.footage), "Bodycam parity.mp4");
    // Research: a plain article page and images.
    mock.on(
      "GET",
      /^\/news\//,
      this.answer(
        () =>
          new Response(
            `<html><head><title>Police find car in garage after Elm Street call | Parity News</title>
<meta property="og:site_name" content="Parity News"><meta property="article:published_time" content="2026-03-14T09:00:00Z">
<meta property="og:image" content="${mock.url}/img/photo.jpg"></head><body><article>
<h1>Police find car in garage after Elm Street call</h1>
<p>Officers were called to a house on Elm Street on Saturday night after neighbours reported an open door.</p>
<p>Inside the garage they found a car that had been reported stolen two weeks earlier.</p>
<p>A 34-year-old woman was later charged. Her brother told reporters he had been home all day.</p>
<img src="${mock.url}/img/photo.jpg" alt="The house on Elm Street">
</article></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      ),
    );
    mock.on("GET", /^\/img\//, this.answer(() => new Response(read(this.files.photo), { headers: { "content-type": "image/jpeg" } })));
  }
}
