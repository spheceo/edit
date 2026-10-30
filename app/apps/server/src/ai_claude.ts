// Edit's small model questions, asked of Claude (through Claude Code, the
// person's own account) instead of Gemini on the AI gateway: the same request
// they built for the gateway (OpenAI-style chat: a system prompt, text, images
// as data URLs, a JSON schema), answered in the same shape, so the callers
// change only which `post` they hand over. Oct 30, the user: Gemini cost $17
// in a day; "move" the spill fix and the watermark check to Claude.

import * as fs from "node:fs";
import * as os from "node:os";

import { join } from "./paths.ts";
import * as tools from "./tools.ts";
import * as claude from "./writer/claude.ts";

type Part = { type?: string; text?: string; image_url?: { url?: string }; file?: { filename?: string; file_data?: string } };
type Message = { role?: string; content?: string | Part[] };
type Request = { messages?: Message[]; response_format?: { json_schema?: { schema?: Record<string, unknown> } } };

/** The tests' switch (test/setup.ts): questions go to the AI gateway (their stand-in server), not Claude. */
export const viaGateway = { on: false };

/** Asks the gateway request in `bodyFile` of Claude (`model`, Opus by default); answers as the gateway would. */
export async function post(bodyFile: string, model: string = claude.OPUS, label = "Claude opus answering a small question"): Promise<unknown> {
  if (viaGateway.on) return (await import("./watch.ts")).post(bodyFile);
  const request = JSON.parse(fs.readFileSync(bodyFile, "utf8")) as Request;
  const messages = request.messages ?? [];
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n\n");
  // Images go in a folder Claude may read, named in the prompt in their order.
  const folder = fs.mkdtempSync(join(os.tmpdir(), "edit-claude-"));
  try {
    const images: string[] = [];
    const prompt = messages
      .filter((message) => message.role !== "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) => {
                // A video (a gateway request's file part): contact sheets, a frame a second, as the watcher shows Claude (watch.ts).
                const video = part.type === "file" ? /^data:video\/\w+;base64,(.+)$/s.exec(part.file?.file_data ?? "") : null;
                if (video !== null) {
                  const clip = join(folder, `video-${images.length + 1}.mp4`);
                  fs.writeFileSync(clip, Buffer.from(video[1]!, "base64"));
                  const first = images.length;
                  const made = Bun.spawnSync([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-vf", "fps=1,scale=320:-2,tile=4x3", "-q:v", "4", join(folder, `sheets-${first}-%02d.jpg`)]);
                  if (made.exitCode !== 0) throw new Error("the video's frames couldn't be taken");
                  const sheets = fs.readdirSync(folder).filter((name) => name.startsWith(`sheets-${first}-`)).sort();
                  images.push(...sheets.map((name) => join(folder, name)));
                  return `[The video, as contact sheets of 12 frames, one a second, left to right then top to bottom:\n${sheets.map((name, index) => `Sheet ${index + 1} (${join(folder, name)}): seconds ${index * 12} to ${index * 12 + 11}`).join("\n")}]`;
                }
                const data = part.type === "image_url" ? /^data:image\/(\w+);base64,(.+)$/s.exec(part.image_url?.url ?? "") : null;
                if (data === null) return part.text ?? "";
                const path = join(folder, `image-${images.length + 1}.${data[1] === "jpeg" ? "jpg" : data[1]}`);
                fs.writeFileSync(path, Buffer.from(data[2]!, "base64"));
                images.push(path);
                return `[Image ${images.length}: ${path}]`;
              })
              .join("\n"),
      )
      .join("\n\n");
    const shown = images.length === 0 ? prompt : `${prompt}\n\nRead each image file above (in order) before answering.`;
    const schema = request.response_format?.json_schema?.schema;
    const answer = await claude.askPatiently({ model, system: system || "Answer exactly as asked.", prompt: shown, label, ...(schema ? { schema } : {}), ...(images.length > 0 ? { read: folder } : {}) });
    const content = answer.structured !== null ? JSON.stringify(answer.structured) : (answer.text ?? "");
    return { choices: [{ message: { content } }] };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

const textOf = (content: Message["content"]): string => (typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n"));

/** The spill fix's question (turns.ts), on Opus. */
export const spills = (bodyFile: string): Promise<unknown> => post(bodyFile, claude.OPUS, "Claude opus putting spilled words back");
