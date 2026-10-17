import { writeSetting } from "../lib/storage";
// The ⋯ menu at the top (shortcuts, settings) and the dialogs it opens.

import { Bug, Check, Cloud, Copy, Ellipsis, Keyboard, RotateCw, Settings } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { chooseEffort, chooseModel, currentEffort, currentModel, EFFORT_LABELS, useAgent, type AgentModel, type AgentStatus } from "../lib/agent";
import { api, fetchRetrying, useMachine, type MediaDrive } from "../lib/api";
import { cloudApi, type CloudSettings } from "../lib/cloud";
import { closeDialog, openDialog, SHORTCUTS, useDialogs } from "../lib/dialogs";
import { buildReport, closeReport, copyText, openReport, useReport } from "../lib/diagnostics";
import { setPreviewQuality, usePreviewQuality } from "../lib/previewQuality";
import { OpenAIMark } from "./AgentPanel";
import { toggleMenu } from "./ContextMenu";
import { cx, IconButton, Kbd, Modal, Select } from "./ui";

export function AppMenu() {
  return (
    <IconButton
      label="More"
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          [
            { label: "Keyboard shortcuts", icon: <Keyboard size={14} />, shortcut: "?", onSelect: () => openDialog("shortcuts") },
            { label: "Settings", icon: <Settings size={14} />, shortcut: "⌘,", onSelect: () => openDialog("settings") },
            { label: "Cloud…", icon: <Cloud size={14} />, onSelect: () => openDialog("settings") },
            { label: "Report a problem…", icon: <Bug size={14} />, onSelect: () => openReport() },
          ],
          { width: 210 },
        )
      }
    >
      <Ellipsis size={16} />
    </IconButton>
  );
}

/** Mount once at the root: the dialogs and their keys (? and ⌘,). */
export function AppDialogs() {
  const open = useDialogs((state) => state.open);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openDialog("settings");
      } else if (event.key === "?" && !document.querySelector("[role=dialog]")) {
        event.preventDefault();
        openDialog("shortcuts");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <Modal open={open === "shortcuts"} onClose={closeDialog} width={560}>
        <DialogHeader title="Keyboard shortcuts" />
        <div className="grid max-h-[70vh] grid-cols-2 gap-x-6 gap-y-4 overflow-y-auto px-5 pt-1 pb-5">
          {SHORTCUTS.map(({ group, keys }) => (
            <div key={group}>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{group}</div>
              {keys.map(([key, what]) => (
                <div key={key} className="flex h-7 items-center justify-between gap-3">
                  <span className="truncate text-muted">{what}</span>
                  <Kbd>{key}</Kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>
      <Modal open={open === "settings"} onClose={closeDialog} width={520}>
        <DialogHeader title="Settings" />
        <SettingsBody />
      </Modal>
      <ReportDialog />
    </>
  );
}

/** "Report a problem": everything needed to work out what went wrong, ready to copy. */
function ReportDialog() {
  const { open, trigger } = useReport();
  const [comment, setComment] = useState("");
  const [report, setReport] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setReport("");
    let current = true;
    void buildReport(trigger, comment).then((text) => current && setReport(text));
    return () => {
      current = false;
    };
    // The comment is added when copying; rebuilding on every keystroke would refetch the logs.
  }, [open, trigger]);
  const copy = async () => {
    const text = comment.trim() ? await buildReport(trigger, comment) : report;
    setReport(text);
    setCopied(await copyText(text));
  };
  return (
    <Modal open={open} onClose={closeReport} width={640}>
      <DialogHeader title="Report a problem" />
      <div className="flex flex-col gap-3 px-5 pb-5">
        <p className="text-[13px] leading-relaxed text-muted">
          {trigger ? <span className="text-fg">{trigger}. </span> : null}
          Copy this report and paste it to whoever is fixing Edit: it has what went wrong, Edit's recent log and how long things took. Nothing is sent anywhere.
        </p>
        <input
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="What were you doing? (optional)"
          className="h-8 rounded-lg border border-line bg-panel px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-line-strong"
        />
        <textarea
          readOnly
          value={report || "Gathering the details…"}
          onFocus={(event) => event.currentTarget.select()}
          className="h-[300px] resize-none rounded-lg border border-line bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted outline-none"
        />
        <div className="flex justify-end gap-2">
          <button className="h-8 rounded-lg px-3 text-[13px] text-muted hover:text-fg" onClick={closeReport}>
            Close
          </button>
          <button
            disabled={!report}
            className="h-8 rounded-lg bg-white px-3 text-[13px] font-medium text-black transition-opacity disabled:opacity-40"
            onClick={() => void copy()}
          >
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Full or light preview picture (light: 720p, a quarter of the data, for watching over the internet). */
function PreviewQualityRow() {
  const quality = usePreviewQuality((state) => state.quality);
  return (
    <div className="rounded-xl bg-black ring-1 ring-line">
      <Line label="Quality" last>
        <div className="w-48">
          <Select
            value={quality}
            options={[
              { value: "auto", label: "Auto (light when away)" },
              { value: "full", label: "Full quality" },
              { value: "light", label: "Light (720p, less data)" },
            ]}
            onChange={setPreviewQuality}
          />
        </div>
      </Line>
    </div>
  );
}

function DialogHeader({ title }: { title: string }) {
  return (
    <div className="flex h-12 items-center px-5">
      <span className="text-[15px] font-semibold">{title}</span>
    </div>
  );
}

function SettingsBody() {
  const machine = useMachine();
  const [status, setStatus] = useState<AgentStatus | null>(useAgent.getState().status);
  const [checking, setChecking] = useState(false);
  const models = useAgent((state) => state.models);
  const model = useAgent((state) => currentModel(state));
  const effort = useAgent((state) => currentEffort(state));

  const check = async () => {
    setChecking(true);
    try {
      const next = (await (await fetchRetrying("/api/agent")).json()) as AgentStatus;
      setStatus(next);
      useAgent.setState({ status: next });
      if (next.ready) {
        const { models } = (await (await fetchRetrying("/api/agent/models")).json()) as { models: AgentModel[] };
        if (models?.length) {
          writeSetting("edit.agent.models", JSON.stringify(models));
          useAgent.setState({ models });
        }
      }
    } catch {
      // Unreachable: keep what we showed.
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check();
  }, []);

  const state = status?.state ?? (status?.ready ? "ready" : status ? "missing" : undefined);
  return (
    <div className="flex max-h-[72vh] flex-col gap-5 overflow-y-auto px-5 pb-5">
      <Group title="Agent">
        <div className="grid grid-cols-2 gap-2">
          <Provider icon={<OpenAIMark size={16} />} name="Codex" detail="OpenAI · runs on your Codex login" selected>
            <StatusPill state={state} />
          </Provider>
          <Provider icon={<span className="text-[15px] font-semibold">✳︎</span>} name="Claude Code" detail="Anthropic" disabled>
            <span className="text-[11px] text-faint">Coming soon</span>
          </Provider>
        </div>
        <div className="mt-2 rounded-xl bg-black ring-1 ring-line">
          <Line label="Machine">{machine}</Line>
          <Line label="Version">{status?.version ?? (state === "missing" ? "Not installed" : "—")}</Line>
          {status?.path && (
            <Line label="Location">
              <span className="truncate font-mono text-[11px]" title={status.path}>
                {status.path}
              </span>
            </Line>
          )}
          <Line label="Default model">
            {models.length ? (
              <div className="w-40">
                <Select value={model?.id ?? ""} options={models.map((option) => ({ value: option.id, label: option.name }))} onChange={chooseModel} />
              </div>
            ) : (
              <span className="text-faint">—</span>
            )}
          </Line>
          <Line label="Thinking" last>
            {model ? (
              <div className="w-40">
                <Select
                  value={effort}
                  options={model.efforts.map((option) => ({ value: option, label: EFFORT_LABELS[option] ?? option }))}
                  onChange={chooseEffort}
                />
              </div>
            ) : (
              <span className="text-faint">—</span>
            )}
          </Line>
        </div>
        {state !== "ready" && status && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {state === "logged_out" ? "Run " : "Install with "}
            <code className="rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-fg">
              {state === "logged_out" ? "codex login" : "npm install -g @openai/codex"}
            </code>
            {state === "logged_out" ? "" : ", then "}
            {state === "logged_out" ? null : <code className="rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-fg">codex login</code>} on {machine}.
          </p>
        )}
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          className="mt-2 flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <RotateCw size={12} className={checking ? "animate-spin" : undefined} />
          {checking ? "Checking…" : "Check again"}
        </button>
      </Group>
      <Group title="Preview">
        <PreviewQualityRow />
        <p className="mt-2 text-[12px] leading-relaxed text-muted">Light streams a 720p copy (a quarter of the data) so playback keeps up over the internet. Export always uses the originals.</p>
      </Group>
      <Group title="Cloud">
        <CloudSettingsPanel />
      </Group>
      <Group title="Media drive">
        <MediaDriveSettings />
      </Group>
      <Group title="Transcription">
        <div className="rounded-xl bg-black ring-1 ring-line">
          <Line label="Model">ElevenLabs Scribe v2</Line>
          <Line label="Access" last>
            <span className="text-muted">Through Edit's relay · no key needed</span>
          </Line>
        </div>
      </Group>
    </div>
  );
}

/** Cloud projects: the team's token (pasted once, kept on this Mac), on/off, and whether it connects. */
function CloudSettingsPanel() {
  const machine = useMachine();
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cloudApi
      .settings()
      .then(setSettings)
      .catch((reason) => setError((reason as Error).message));
  }, []);

  const apply = async (body: Parameters<typeof cloudApi.setSettings>[0]) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await cloudApi.setSettings(body));
      setToken("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <div className="rounded-xl bg-black px-3 py-3 text-[12px] text-muted ring-1 ring-line">{error ?? "Checking…"}</div>;
  const [label, tone] = !settings.token
    ? ["Off · no token", "bg-hover text-muted"]
    : settings.connected === false
      ? ["Not connected", "bg-amber-500/15 text-amber-300"]
      : ["On", "bg-green-500/15 text-green-300"];
  return (
    <>
      <div className="rounded-xl bg-black ring-1 ring-line">
        <Line label="Status">
          <span className={cx("rounded-md px-1.5 py-0.5 text-[11px] font-medium", tone)}>{label}</span>
        </Line>
        <Line label="Token" last={!settings.token}>
          {settings.token === "env" ? (
            <span className="text-muted">Set by EDIT_RELAY_TOKEN</span>
          ) : (
            <form
              className="flex min-w-0 items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (token.trim()) void apply({ token: token.trim() });
              }}
            >
              <input
                type="password"
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
                placeholder={settings.token ? "Saved · paste a new one to replace it" : "Paste the team's cloud token"}
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-56 min-w-0 rounded-md border border-line bg-panel px-2 font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-faint focus:border-line-strong disabled:opacity-60"
              />
              {token.trim() ? (
                <button type="submit" disabled={busy} className="h-7 rounded-md bg-white px-2.5 text-[12px] font-medium text-black disabled:opacity-40">
                  Save
                </button>
              ) : (
                settings.token === "saved" && (
                  <button type="button" disabled={busy} onClick={() => void apply({ token: null })} className="h-7 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
                    Remove
                  </button>
                )
              )}
            </form>
          )}
        </Line>
        {settings.token && (
          <Line label="Teammates see" last>
            <span className="truncate">{settings.holder}</span>
          </Line>
        )}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Projects are kept in the team's cloud: close one here and a teammate opens it on their Mac where you left off. One Mac edits a project at a time; the others see it read-only. The token is kept in Edit's data folder on {machine}, readable only by you.
      </p>
      {(error || (settings.token && settings.problem)) && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber-300">{error ?? settings.problem}</p>
      )}
    </>
  );
}

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** Keeps big media files (downloads, uploads, exports) in a folder on another drive. */
function MediaDriveSettings() {
  const machine = useMachine();
  const [drive, setDrive] = useState<MediaDrive | null>(null);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const adopt = (next: MediaDrive) => {
    setDrive(next);
    setDir(next.dir ?? "");
  };
  const load = () =>
    void api
      .mediaDrive()
      .then(adopt)
      .catch((reason) => setError((reason as Error).message));
  useEffect(load, []);

  const apply = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      adopt(await api.setMediaDrive(next));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!drive) return <div className="rounded-xl bg-black px-3 py-3 text-[12px] text-muted ring-1 ring-line">{error ?? "Checking…"}</div>;
  const [label, tone] =
    drive.state === "connected"
      ? ["Connected", "bg-green-500/15 text-green-300"]
      : drive.state === "offline"
        ? ["Not connected", "bg-amber-500/15 text-amber-300"]
        : ["Off", "bg-hover text-muted"];
  const changed = dir.trim() !== (drive.dir ?? "");
  return (
    <>
      <div className="rounded-xl bg-black ring-1 ring-line">
        <Line label="Status">
          <span className={cx("rounded-md px-1.5 py-0.5 text-[11px] font-medium", tone)}>{label}</span>
        </Line>
        <Line label="Folder" last={!drive.volumes.length || drive.env}>
          <form
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (changed && dir.trim()) void apply(dir.trim());
            }}
          >
            <input
              value={dir}
              disabled={drive.env || busy}
              onChange={(event) => setDir(event.target.value)}
              placeholder={`Off · media stays in ${drive.home}`}
              spellCheck={false}
              className="h-7 w-56 min-w-0 rounded-md border border-line bg-panel px-2 font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-faint focus:border-line-strong disabled:opacity-60"
            />
            {!drive.env && changed && dir.trim() && (
              <button type="submit" disabled={busy} className="h-7 rounded-md bg-white px-2.5 text-[12px] font-medium text-black disabled:opacity-40">
                Use
              </button>
            )}
            {!drive.env && drive.dir && !changed && (
              <button type="button" disabled={busy} onClick={() => void apply(null)} className="h-7 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
                Turn off
              </button>
            )}
          </form>
        </Line>
        {!drive.env && drive.volumes.length > 0 && (
          <Line label="Drives" last>
            <span className="flex flex-wrap justify-end gap-1">
              {drive.volumes.map((volume) => (
                <button
                  key={volume.path}
                  type="button"
                  onClick={() => setDir(`${volume.path}/Edit`)}
                  className="h-6 rounded-md bg-raised px-2 text-[11px] text-muted hover:bg-hover hover:text-fg"
                >
                  {volume.name}
                </button>
              ))}
            </span>
          </Line>
        )}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Downloads, uploads and renders made into media go to this folder on {machine}, and exports to its Exports folder. Projects, previews and the cache stay in {drive.home}. While the drive is unplugged its footage shows as missing and new media is refused rather than put on this disk.
        {drive.env && " Set by EDIT_MEDIA_DIR."}
      </p>
      {(error || drive.problem) && <p className="mt-2 text-[12px] leading-relaxed text-amber-300">{error ?? drive.problem}</p>}
      {drive.dir && drive.move_command && drive.internal_bytes > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[12px] leading-relaxed text-muted">
            {formatSize(drive.internal_bytes)} of media is still in {drive.home}. To move it, quit Edit and run:
          </p>
          <button
            type="button"
            title="Copy"
            onClick={() => void copyText(drive.move_command ?? "").then(setCopied)}
            className="flex items-center gap-2 self-start rounded-md border border-line bg-black/40 px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
          >
            <span className="truncate">{drive.move_command}</span>
            {copied ? <Check size={12} className="shrink-0 text-green-400" /> : <Copy size={12} className="shrink-0" />}
          </button>
        </div>
      )}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">{title}</div>
      {children}
    </section>
  );
}

function Provider({
  icon,
  name,
  detail,
  selected,
  disabled,
  children,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  selected?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cx("flex flex-col gap-2 rounded-xl p-3 ring-1", selected ? "bg-raised ring-line-strong" : "ring-line", disabled && "opacity-50")}>
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-black text-fg ring-1 ring-line">{icon}</span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{name}</div>
          <div className="truncate text-[11px] text-faint">{detail}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function StatusPill({ state }: { state?: string }) {
  const [label, tone] =
    state === "ready"
      ? ["Ready", "bg-green-500/15 text-green-300"]
      : state === "logged_out"
        ? ["Signed out", "bg-amber-500/15 text-amber-300"]
        : state === "missing"
          ? ["Not installed", "bg-red-500/15 text-red-300"]
          : ["Checking…", "bg-hover text-muted"];
  return <span className={cx("self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium", tone)}>{label}</span>;
}

function Line({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cx("flex h-10 items-center justify-between gap-4 px-3 text-[12px]", !last && "border-b border-line")}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 justify-end text-fg">{children}</span>
    </div>
  );
}
