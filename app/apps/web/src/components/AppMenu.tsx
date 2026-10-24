// The account menu at the top right (your avatar: you, Manage account, Settings, Logs, Report a problem, Sign out; a ⋯ when signed out) and the dialogs it opens.

import { Bug, Ellipsis, LogIn, LogOut, ScrollText, Settings, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadAccount, signIn, signOut, useAccount } from "../lib/account";
import { closeDialog, openDialog, useDialogs } from "../lib/dialogs";
import { buildReport, closeReport, copyText, openReport, useReport } from "../lib/diagnostics";
import { chooseChannel, useUpdate, watchUpdates, type UpdateChannel } from "../lib/update";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { StartedBy } from "./StartedBy";
import { cx, IconButton, Modal, Select, Tabs } from "./ui";

export function AppMenu() {
  const account = useAccount((state) => state.account);
  useEffect(() => {
    void loadAccount();
  }, []);
  const person = account?.signed_in ? account.person : null;
  // The kit’s account menu, always in this order: who you are, Manage account, the app’s own items, then Sign out.
  const items: MenuItem[] = [
    ...(person !== null && account !== null
      ? ([
          { person: { name: person.name, email: person.email, picture: person.image } },
          { label: "Manage account", icon: <UserRound size={14} />, onSelect: () => window.open(account.accounts, "_blank", "noopener") },
          { separator: true },
        ] as MenuItem[])
      : []),
    { label: "Settings", icon: <Settings size={14} />, shortcut: "⌘,", onSelect: () => openDialog("settings") },
    { label: "Logs", icon: <ScrollText size={14} />, onSelect: () => openDialog("logs") },
    { label: "Report a problem…", icon: <Bug size={14} />, onSelect: () => openReport() },
    { separator: true },
    person !== null
      ? { label: "Sign out", icon: <LogOut size={14} />, onSelect: () => void signOut() }
      : { label: "Sign in…", icon: <LogIn size={14} />, disabled: account === null || !account.available, onSelect: () => void signIn() },
  ];
  const open = (event: React.MouseEvent<HTMLElement>) => toggleMenu(event.currentTarget, items, { width: 260 });
  if (person === null) {
    return (
      <IconButton label="More" onClick={open}>
        <Ellipsis size={16} />
      </IconButton>
    );
  }
  return (
    <button
      title={person.name || person.email}
      aria-label="Your account"
      onClick={open}
      className="ml-1 shrink-0 rounded-full shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_var(--color-line-strong)]"
    >
      <StartedBy by={{ sub: "", name: person.name || person.email, ...(person.image ? { picture: person.image } : {}) }} size={32} title={null} />
    </button>
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
        <div className="flex max-h-[72vh] flex-col gap-6 overflow-y-auto px-6 pb-6">
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

/** Edit’s log as it happens: what it’s doing (downloads, cuts, the agent, exports) and what went wrong, newest at the bottom. */
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
    <div className="flex flex-col gap-3 px-6 pb-6">
      <div className="flex items-center gap-2">
        <input
          value={words}
          onChange={(event) => setWords(event.target.value)}
          placeholder="Search the log"
          className="h-8 flex-1 rounded-lg border border-line bg-panel px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-muted"
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
              <span className={cx("w-14 shrink-0 truncate", line.level === "error" ? "text-danger" : line.level === "warn" ? "text-warning" : "text-muted")}>{line.area}</span>
              <span className={cx("min-w-0 flex-1 break-words whitespace-pre-wrap", line.level === "error" ? "text-danger" : line.level === "warn" ? "text-warning" : "text-fg/85")}>{line.message}</span>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-between text-[12px] text-faint">
        <span>
          {shown.length} of {lines.length} lines · the full log is kept in Edit’s data folder
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
      <div className="flex flex-col gap-3 px-6 pb-6">
        <p className="text-[13px] leading-relaxed text-muted">
          {trigger ? <span className="text-fg">{trigger}. </span> : null}
          Copy this report and paste it to whoever is fixing Edit: it has what went wrong, Edit’s recent log and how long things took. Nothing is sent anywhere.
        </p>
        <input
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="What were you doing? (optional)"
          className="h-8 rounded-lg border border-line bg-panel px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-muted"
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

/** This build and the update channel: Nightly (every nightly as it’s out) or Stable (releases only). */
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
          ? "This is a dev build: it doesn’t update itself. Pull and rebuild."
          : status?.latest
            ? `${status.latest} is out: update from the button at the top. Edit restarts itself; your work is saved.`
            : status?.channel === "stable"
              ? "Up to date. Stable moves only on a release; a nightly you’re on now waits for the next one."
              : "Up to date. Nightlies are pre-releases, out as soon as they’re built; one click at the top installs a new one."}
      </p>
      {error && <p className="mt-2 px-1 text-[12px] text-danger">{error}</p>}
    </Group>
  );
}

function DialogHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center px-6 pt-6 pb-4">
      <h2 className="text-[18px] font-semibold tracking-[-0.3px]">{title}</h2>
    </div>
  );
}

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="mb-2 flex h-6 items-center justify-between px-1">
        <span className="text-[13px] font-medium text-muted">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl bg-black ring-1 ring-line">{children}</div>;
}

function Line({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cx("flex h-11 items-center justify-between gap-4 px-3 text-[12px]", !last && "border-b border-line")}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 justify-end text-fg">{children}</span>
    </div>
  );
}
