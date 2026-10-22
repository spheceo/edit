// The ⋯ menu at the top (settings, reporting a problem) and the dialogs it opens.

import { Bug, Check, Copy, Ellipsis, RotateCw, ScrollText, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
            { label: "Logs", icon: <ScrollText size={14} />, onSelect: () => openDialog("logs") },
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
      <Modal open={open === "logs"} onClose={closeDialog} width={920}>
        <DialogHeader title="Logs" />
        <LogsView />
      </Modal>
      <ReportDialog />
    </>
  );
}

interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  area: string;
  message: string;
}

/** Edit's log as it happens: what it's doing (downloads, cuts, the agent, exports) and what went wrong, newest at the bottom. */
function LogsView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [problems, setProblems] = useState(false);
  const [area, setArea] = useState("all");
  const [words, setWords] = useState("");
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    let since = 0;
    let alive = true;
    const pull = async () => {
      try {
        const answer = (await (await fetch(`/api/logs?since=${since}`)).json()) as { lines: LogLine[] };
        if (!alive || answer.lines.length === 0) return;
        since = answer.lines.at(-1)!.at;
        setLines((old) => [...old, ...answer.lines].slice(-2000));
      } catch {
        // The server restarting: the next look catches up.
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const areas = useMemo(() => ["all", ...[...new Set(lines.map((line) => line.area))].sort()], [lines]);
  const shown = lines.filter(
    (line) => (!problems || line.level !== "info") && (area === "all" || line.area === area) && (words === "" || line.message.toLowerCase().includes(words.toLowerCase())),
  );
  // Follows the newest line unless scrolled up to read.
  useEffect(() => {
    if (stuck.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length]);
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const copy = async () => {
    const text = shown.map((line) => `${new Date(line.at).toISOString()} ${line.level.toUpperCase()} [${line.area}] ${line.message}`).join("\n");
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-3 px-5 pb-5">
      <div className="flex items-center gap-2">
        <input
          value={words}
          onChange={(event) => setWords(event.target.value)}
          placeholder="Search the log"
          className="h-8 flex-1 rounded-lg border border-line bg-panel px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-line-strong"
        />
        <Select value={area} onChange={setArea} options={areas.map((one) => ({ value: one, label: one === "all" ? "Everything" : one }))} />
        <Tabs<"all" | "problems">
          id="log-level"
          value={problems ? "problems" : "all"}
          onChange={(value) => setProblems(value === "problems")}
          tabs={[
            { value: "all", label: "All" },
            { value: "problems", label: "Problems" },
          ]}
        />
      </div>
      <div
        ref={box}
        onScroll={(event) => {
          const el = event.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[460px] overflow-y-auto rounded-lg border border-line bg-black/40 py-1.5 font-mono text-[11px] leading-[1.6]"
      >
        {shown.length === 0 ? (
          <div className="px-3 py-2 text-faint">{lines.length === 0 ? "Reading the log…" : "Nothing matches."}</div>
        ) : (
          shown.map((line, index) => (
            <div key={`${line.at}-${index}`} className="flex gap-3 px-3 hover:bg-white/[0.03]">
              <span className="shrink-0 text-faint tabular">{time(line.at)}</span>
              <span className={cx("w-14 shrink-0 truncate", line.level === "error" ? "text-red-300" : line.level === "warn" ? "text-amber-300" : "text-muted")}>{line.area}</span>
              <span className={cx("min-w-0 flex-1 break-words whitespace-pre-wrap", line.level === "error" ? "text-red-200" : line.level === "warn" ? "text-amber-100" : "text-fg/85")}>{line.message}</span>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-between text-[12px] text-faint">
        <span>
          {shown.length} of {lines.length} lines · the full log is kept in Edit's data folder
        </span>
        <div className="flex gap-2">
          <button className="h-8 rounded-lg px-3 text-[13px] text-muted hover:text-fg" onClick={() => void fetch("/api/logs/reveal", { method: "POST" })}>
            Show in Finder
          </button>
          <button className="h-8 rounded-lg bg-white px-3 text-[13px] font-medium text-black" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
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
