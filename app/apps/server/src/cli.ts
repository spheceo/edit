// The `edit` command: the desktop app, the server, and the small
// commands beside them. `main.ts` runs it; this file only defines it, so
// tests can call its parts.

import { main as scriptEval } from "./script_eval.ts";
import * as accounts from "./accounts.ts";
import * as diag from "./diag.ts";
import { runCli as mediaCli } from "./media_drive/move.ts";
import { initNative } from "./native/index.ts";
import { join } from "./paths.ts";
import * as seams from "./seams.ts";
import { fail, start } from "./serve.ts";
import * as tools from "./tools.ts";
import { runCli as updateCli } from "./update.ts";
import { BUILD } from "./version.ts";
import { runSupport } from "./support_cli.ts";
import { adoptShellEnv, portTaken, runWindow, windowHelper } from "./window.ts";

export const DEFAULT_PORT = 7700;

export const HELP = `edit — a local, agent-driven video editor

USAGE
  edit [app] [--port N] [--home DIR]
      Open the editor in its own window (the server below runs inside it; if
      an Edit is already serving on the port, the window opens onto that).
  edit serve [--port N] [--host ADDR] [--home DIR]
      Serve the editor. Binds 127.0.0.1 and this machine's Tailscale IP.
      Open http://localhost:7700 (WebGPU needs localhost or HTTPS; for other
      devices use \`tailscale serve --bg http://127.0.0.1:7700\`).
  edit mcp
      Print how to connect Codex / Claude Code to the editor.
  edit media [use DIR | off | move --to DIR]
      Keep big media files (downloads, uploads, exports) on another drive;
      \`edit media help\` says more.
  edit cloud [url | put | get | head | ls | rm | convex] …
      Try Edit's cloud storage (R2) and Convex through the relay by hand;
      \`edit cloud help\` says more.
  edit cloud backfill <project id> [--port N]
      Put every file a cloud project uses that isn't in the cloud yet there
      now, through the running Edit (it also happens by itself after saves).
  edit update
      Install the newest release (the editor also offers it, one click).
  edit support <command> --url https://<device>.<tailnet>.ts.net
      Inspect or help an owner's already-shared Edit; \`edit support help\` says more.
  edit --version

ENV
  EDIT_HOME   data directory (default ~/.edit)
  EDIT_MEDIA_DIR  keep big media files here instead (overrides the setting)
  EDIT_HOSTS  extra Host names to accept, comma-separated
  EDIT_RELAY_URL, EDIT_RELAY_TOKEN
              another relay (default Edit's), and the token it wants (cloud needs it;
              else a saved one, else the one built into releases)
  EDIT_CLOUD_HOLDER
              how teammates see this machine when it's editing a cloud project
              (default: the setting, else the machine's name)
  GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DOCS_REFRESH_TOKEN
              a Google sign-in that can read the team's sound library in Drive
`;

export function mcpText(port: string): string {
  return `Start the editor with \`edit serve\`, then register it once:

  claude mcp add --transport http edit http://127.0.0.1:${port}/mcp
  codex mcp add edit --url http://127.0.0.1:${port}/mcp

Agents then see tools like get_project, add_text, update_clip, set_keyframes,
render_frame and contact_sheet, and their edits appear live in the open project.`;
}

function defaultHome(): string {
  const home = process.env.HOME;
  return join(home !== undefined ? home : ".", ".edit");
}

/** Runs `edit <args>`. */
export async function main(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const port = () => {
    const given = flag("--port");
    if (given === undefined) return DEFAULT_PORT;
    if (!/^\+?\d+$/.test(given) || Number(given) > 65535) fail("--port must be a number");
    return Number(given);
  };
  const home = () => {
    const given = flag("--home");
    if (given !== undefined) return given;
    const env = process.env.EDIT_HOME;
    return env !== undefined ? env : defaultHome();
  };
  const command = args[0];
  switch (command) {
    case "serve":
      // A bundle's window helper starts `edit serve` from Finder's bare environment.
      if (process.env.EDIT_ADOPT_SHELL_ENV === "1") adoptShellEnv();
      // Headless (not Edit.app's window starting it): signing in is a code printed here.
      else accounts.signInOnTerminal(true);
      start(home(), flag("--host") ?? null, port());
      return;
    case "app":
    case "--port":
    case "--home":
    case undefined:
      app(home(), port());
      return;
    case "mcp":
      console.log(mcpText(flag("--port") ?? String(DEFAULT_PORT)));
      return;
    case "script-eval":
      // One Edit Script, run apart from the server (run_edit starts it).
      void scriptEval().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
      return;
    case "media": {
      const where = home();
      initNative({
        home: where,
        cacheDir: join(where, "cache"),
        ffmpeg: tools.ffmpeg(),
        ffprobe: tools.ffprobe(),
        mediaFolders: [],
      });
      await mediaCli(where, port(), args.slice(1), fail);
      return;
    }
    case "cloud":
      if (args[1] === "backfill") {
        let code = 0;
        try {
          code = await seams.cloud.backfillCli(args[2], port());
        } catch (error) {
          fail(diag.messageOf(error));
        }
        if (code !== 0) process.exit(code);
        return;
      }
      try {
        seams.cloudProjects.useSavedToken(home());
        await seams.cloud.runCli(args.slice(1));
      } catch (error) {
        fail(diag.messageOf(error));
      }
      return;
    case "update": {
      const env = process.env.EDIT_HOME;
      await updateCli(env !== undefined ? env : defaultHome());
      return;
    }
    case "support":
      try { console.log(await runSupport(args.slice(1))); }
      catch (error) { fail(diag.messageOf(error)); }
      return;
    case "--version":
    case "-V":
    case "version":
      console.log(`edit ${BUILD}`);
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown command ${command}\n\n${HELP}`);
  }
}

/** The desktop app: the same server, in this process, with a window onto it. */
function app(home: string, port: number): void {
  const helper = windowHelper(home);
  const url = `http://127.0.0.1:${port}/`;
  if (helper === null) fail(`this build has no window; open ${url} in a browser`);
  adoptShellEnv();
  // Something already on the port is most likely another Edit (`edit serve`,
  // `just dev`, the app opened twice): open onto it rather than run a second
  // server over the same projects.
  if (!portTaken(port)) start(home, null, port);
  runWindow(helper, url);
}

