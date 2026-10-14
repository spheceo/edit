import { writeSetting } from "../lib/storage";
// The ⋯ menu at the top (shortcuts, settings) and the dialogs it opens.

import { Bug, Ellipsis, Keyboard, RotateCw, Settings } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { chooseEffort, chooseModel, currentEffort, currentModel, EFFORT_LABELS, useAgent, type AgentModel, type AgentStatus } from "../lib/agent";
import { fetchRetrying, useMachine } from "../lib/api";
import { closeDialog, openDialog, SHORTCUTS, useDialogs } from "../lib/dialogs";
import { buildReport, closeReport, copyText, openReport, useReport } from "../lib/diagnostics";
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
