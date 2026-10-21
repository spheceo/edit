// The ⋯ menu at the top (settings, reporting a problem) and the dialogs it opens.

import { Bug, Check, Copy, Ellipsis, RotateCw, Settings } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { chooseProvider, useAgent, type AgentModel, type AgentProvider, type AgentStatus } from "../lib/agent";
import { fetchRetrying } from "../lib/api";
import { closeDialog, openDialog, useDialogs } from "../lib/dialogs";
import { buildReport, closeReport, copyText, openReport, useReport } from "../lib/diagnostics";
import { writeSetting } from "../lib/storage";
import { chooseChannel, useUpdate, watchUpdates, type UpdateChannel } from "../lib/update";
import { ClaudeMark, OpenAIMark } from "./AgentPanel";
import { toggleMenu } from "./ContextMenu";
import { cx, IconButton, Modal, Select, Tabs } from "./ui";

export function AppMenu() {
  return (
    <IconButton
      label="More"
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          [
            { label: "Settings", icon: <Settings size={14} />, shortcut: "⌘,", onSelect: () => openDialog("settings") },
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

/** Mount once at the root: the dialogs, and ⌘, for Settings. */
export function AppDialogs() {
  const open = useDialogs((state) => state.open);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openDialog("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <Modal open={open === "settings"} onClose={closeDialog} width={480}>
        <DialogHeader title="Settings" />
        <div className="flex max-h-[72vh] flex-col gap-6 overflow-y-auto px-5 pb-5">
          <ToolSettings />
          <UpdateSettings />
        </div>
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

interface Clis {
  claude?: AgentStatus;
  codex?: AgentStatus;
  provider?: AgentProvider;
}

/** The CLIs Edit drives: whether each is installed and signed in, and which one runs the agent. */
function ToolSettings() {
  const [clis, setClis] = useState<Clis | null>(null);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    try {
      const next = (await (await fetchRetrying("/api/agent/clis")).json()) as Clis;
      setClis(next);
      const status = next.provider === "codex" ? next.codex : next.claude;
      if (status) useAgent.setState({ status });
      if (status?.ready) {
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

  const provider: AgentProvider = clis?.provider === "codex" ? "codex" : "claude";
  const pick = (next: AgentProvider) => {
    if (next === provider || switching) return;
    setSwitching(true);
    setProblem(null);
    void chooseProvider(next)
      .then(() => setClis((current) => ({ ...current, provider: next })))
      .catch((thrown: Error) => setProblem(thrown.message))
      .finally(() => setSwitching(false));
  };
  return (
    <Group
      title="Tools"
      action={
        <button
          type="button"
          title="Check again"
          onClick={() => void check()}
          disabled={checking}
          className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <RotateCw size={12} className={checking ? "animate-spin" : undefined} />
        </button>
      }
    >
      <Card>
        <Tool
          icon={<ClaudeMark size={15} />}
          name="Claude Code"
          role={provider === "claude" ? "Runs the agent, names speakers" : "Names speakers"}
          status={clis?.claude}
          detail={[clis?.claude?.email, clis?.claude?.plan].filter(Boolean).join(" · ")}
          login="claude auth login"
          install="curl -fsSL https://claude.ai/install.sh | bash"
        />
        <Tool
          icon={<OpenAIMark size={16} />}
          name="Codex"
          role={provider === "codex" ? "Runs the agent, checks subtitles against the footage" : "Checks subtitles against the footage"}
          status={clis?.codex}
          login="codex login"
          install="npm install -g @openai/codex"
        />
        <Line label="Agent" last>
          <Tabs
            id="agent-provider"
            value={provider}
            tabs={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
            ]}
            onChange={pick}
          />
        </Line>
      </Card>
      {problem && <p className="mt-2 text-[12px] text-red-300">{problem}</p>}
    </Group>
  );
}

/** One CLI: its version and sign-in, or the command that fixes it. */
function Tool({
  icon,
  name,
  role,
  status,
  detail,
  login,
  install,
}: {
  icon: ReactNode;
  name: string;
  role: string;
  status?: AgentStatus;
  detail?: string;
  login: string;
  install: string;
}) {
  const state = status?.state ?? (status?.ready ? "ready" : status ? "missing" : undefined);
  const version = status?.version?.match(/\d+(\.\d+)+/)?.[0];
  const fix = state === "logged_out" ? login : state === "missing" ? `${install} && ${login}` : null;
  return (
    <div className="flex flex-col gap-2 border-b border-line px-3 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-fg ring-1 ring-line">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium">{name}</span>
            {version && <span className="font-mono text-[11px] text-faint">{version}</span>}
          </div>
          <div className="truncate text-[11px] text-muted">{[role, state === "ready" ? detail : ""].filter(Boolean).join(" · ")}</div>
        </div>
        <StatusPill state={state} />
      </div>
      {fix && <Fix command={fix} />}
    </div>
  );
}

/** A command to run in Terminal, copied on click. */
function Fix({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => void copyText(command).then(setCopied)}
      className="ml-11 flex min-w-0 items-center gap-2 self-start rounded-md border border-line bg-black/40 px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
    >
      <span className="truncate">{command}</span>
      {copied ? <Check size={12} className="shrink-0 text-green-400" /> : <Copy size={12} className="shrink-0" />}
    </button>
  );
}

/** This build and the update channel: Nightly (every nightly as it's out) or Stable (releases only). */
function UpdateSettings() {
  const status = useUpdate((state) => state.status);
  const [error, setError] = useState<string | null>(null);
  useEffect(watchUpdates, []);
  const pick = (channel: UpdateChannel) => {
    setError(null);
    chooseChannel(channel).catch((reason: Error) => setError(reason.message));
  };
  return (
    <Group title="Updates">
      <Card>
        <Line label="Version">
          <span className="font-mono text-[12px]">{status?.current ?? "—"}</span>
        </Line>
        <Line label="Channel" last>
          <div className="w-44">
            <Select
              value={status?.channel ?? "nightly"}
              options={[
                { value: "nightly", label: "Nightly" },
                { value: "stable", label: "Stable (releases only)" },
              ]}
              onChange={pick}
            />
          </div>
        </Line>
      </Card>
      <p className="mt-2 px-1 text-[12px] leading-relaxed text-muted">
        {status && !status.enabled
          ? "This is a dev build: it doesn't update itself. Pull and rebuild."
          : status?.latest
            ? `${status.latest} is out: update from the button at the top. Edit restarts itself; your work is saved.`
            : status?.channel === "stable"
              ? "Up to date. Stable moves only on a release; a nightly you're on now waits for the next one."
              : "Up to date. Nightlies are pre-releases, out as soon as they're built; one click at the top installs a new one."}
      </p>
      {error && <p className="mt-2 px-1 text-[12px] text-red-300">{error}</p>}
    </Group>
  );
}

function DialogHeader({ title }: { title: string }) {
  return (
    <div className="flex h-12 items-center px-5">
      <span className="text-[15px] font-semibold">{title}</span>
    </div>
  );
}

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="mb-2 flex h-6 items-center justify-between px-1">
        <span className="text-[11px] font-medium tracking-wide text-faint uppercase">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl bg-black ring-1 ring-line">{children}</div>;
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
  return <span className={cx("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium", tone)}>{label}</span>;
}

function Line({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cx("flex h-11 items-center justify-between gap-4 px-3 text-[12px]", !last && "border-b border-line")}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 justify-end text-fg">{children}</span>
    </div>
  );
}
