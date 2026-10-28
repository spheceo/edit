// The account menu at the top right (your avatar: you, Manage account, Settings, Logs, Report a problem, Sign out; a ⋯ when signed out) and the dialogs it opens.

import { Bug, Ellipsis, LogIn, LogOut, ScrollText, Settings, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadAccount, signIn, signOut, useAccount } from "../lib/account";
import { closeDialog, openDialog, useDialogs } from "../lib/dialogs";
import { buildReport, closeReport, copyText, openReport, useReport } from "../lib/diagnostics";
import { chooseChannel, useUpdate, watchUpdates, type UpdateChannel } from "../lib/update";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { api, type YoutubeSignIn } from "../lib/api";
import { ProblemView } from "./ProblemView";
import { StartedBy } from "./StartedBy";
import { Button, cx, IconButton, Modal, Select, Tabs } from "./ui";

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
      <Modal open={open === "settings"} onClose={closeDialog} width={500}>
        <SettingsDialog />
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

/**
 * The YouTube sign-in from Chrome: what it's for, how it stands, and what to
 * do next, step by step (the team: "give clear instructions on how to do it
 * and how to give Edit the permissions"). Check brings up the Mac's Keychain
 * dialog now, while these words are on screen, not in the middle of an import.
 */
function YoutubeGroup() {
  const [state, setState] = useState<YoutubeSignIn | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => {
    void api.youtubeSignIn().then(setState).catch(setFailed);
  }, []);
  const check = () => {
    setChecking(true);
    setFailed(null);
    void api
      .checkYoutubeSignIn()
      .then(setState)
      .catch(setFailed)
      .finally(() => setChecking(false));
  };
  const steps: ReactNode = !state ? null : !state.chrome ? (
    <>Install Google Chrome, open youtube.com in it and sign in (top right), then press Check.</>
  ) : !state.profile ? (
    <>Open Chrome, go to youtube.com and sign in (top right) with the team’s YouTube account. Then press Check.</>
  ) : state.allowed === true ? (
    <>Ready: Edit uses the YouTube sign-in of Chrome’s “{state.profile.name}” profile when a video needs one.</>
  ) : (
    <>
      {state.problem && <span className="text-danger">{state.problem} </span>}
      Chrome’s “{state.profile.name}” profile is signed in to YouTube. Press Check: your Mac asks whether “security” may use “Chrome Safe
      Storage”. Type your Mac’s password and choose <b>Always Allow</b> (not Allow or Deny). That’s all: it won’t ask again.
    </>
  );
  return (
    <Group title="YouTube">
      <Row
        name="Sign-in from Chrome"
        detail={
          <>
            Some videos (age-restricted, members-only, or when YouTube asks for a sign-in) only download for a signed-in account.
            {steps && (
              <>
                <br />
                {steps}
              </>
            )}
          </>
        }
      >
        <Button onClick={check} disabled={checking || !state?.chrome}>
          {checking ? "Waiting for your Mac…" : "Check"}
        </Button>
      </Row>
      {failed !== null && (
        <div className="border-t border-line px-3 py-2.5">
          <ProblemView error={failed} doing="check the YouTube sign-in" onRetry={check} />
        </div>
      )}
    </Group>
  );
}

/** Edit's settings, laid out as Writer's: who's signed in, then updates; the build and Done at the foot. */
function SettingsDialog() {
  const person = useAccount((state) => (state.account?.signed_in ? state.account.person : null));
  const status = useUpdate((state) => state.status);
  const [error, setError] = useState<string | null>(null);
  useEffect(watchUpdates, []);
  const pick = (channel: UpdateChannel) => {
    setError(null);
    chooseChannel(channel).catch((reason: Error) => setError(reason.message));
  };
  const said =
    status && !status.enabled
      ? "A dev build: it doesn’t update itself. Pull and rebuild."
      : status?.latest
        ? `${status.latest} is out: update from the button at the top. Edit restarts itself; your work is saved.`
        : status?.channel === "stable"
          ? "Up to date. Stable moves only on a release."
          : "Up to date. Edit looks for a new build every minute.";
  return (
    <>
      <DialogHeader title="Settings" />
      <div className="flex max-h-[72vh] flex-col gap-[18px] overflow-y-auto px-6">
        {person && <p className="text-[13px] text-muted">Signed in as {person.email}</p>}
        <YoutubeGroup />
        <Group title="Updates">
          <Row name="Channel" detail={said} bad={error ?? undefined}>
            <Select
              value={status?.channel ?? "nightly"}
              options={[
                { value: "nightly", label: "Nightly" },
                { value: "stable", label: "Stable" },
              ]}
              onChange={pick}
              className="h-[34px] min-w-[128px] shrink-0 justify-between rounded-lg border border-line-strong bg-bg pr-2.5 pl-3 text-[13px] hover:border-muted"
            />
          </Row>
        </Group>
      </div>
      <div className="flex items-center gap-3 px-6 pt-5 pb-6">
        <span className="text-[13px] text-faint" title={status?.enabled ? "Built by the release workflow" : "A dev build: it never updates itself"}>
          Edit {status?.current ?? ""}
        </span>
        <Button variant="primary" className="ml-auto" onClick={closeDialog}>
          Done
        </Button>
      </div>
    </>
  );
}

function DialogHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center px-6 pt-6 pb-4">
      <h2 className="text-[18px] font-semibold tracking-[-0.3px]">{title}</h2>
    </div>
  );
}

/** A titled group of rows, as Writer's Settings lays them out. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-2 text-[12px] font-medium text-muted">{title}</h3>
      <div className="flex flex-col rounded-[10px] border border-line bg-panel">{children}</div>
    </section>
  );
}

/** One setting: what it is and how it stands on the left, its control on the right. */
function Row({ name, detail, bad, children }: { name: string; detail?: ReactNode; bad?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-3.5 px-3 py-2.5 [&+&]:border-t [&+&]:border-line">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
        <span className="font-medium">{name}</span>
        {detail && <span className="text-[12px] leading-[1.45] text-muted">{detail}</span>}
        {bad && <span className="text-[12px] leading-[1.45] text-danger">{bad}</span>}
      </div>
      {children}
    </div>
  );
}
