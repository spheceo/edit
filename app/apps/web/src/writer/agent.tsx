import { UserWords } from "../components/Quotes";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClaudeMark } from "../components/ClaudeMark";
import { openPage } from "./api";
import { clock } from "./clips";
import { Pulse } from "../components/ui";
import { Icon } from "./ui";
import { shownText } from "../lib/agentTurns";
import { useSettled } from "../lib/settled";

export function useChatDraft(id: string) {
  const key = `writer.chat-draft.${id}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  useEffect(() => { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); }, [key, text]);
  return [text, setText] as const;
}

/** Time since a moment, ticking each second. */
export function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [since]);
  return <>{clock(Math.max(0, now - (since ?? now)))}</>;
}

export async function copyMessage(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Plain HTTP uses the Mac's older clipboard command. */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  const done = document.execCommand("copy");
  area.remove();
  return done;
}

function MessageActions({ text, at, onRetry }: { text: string; at?: number; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="message-actions">
    {onRetry && <button type="button" className="icon-tool sm" aria-label="Retry message" title="Retry message" onClick={onRetry}><Icon name="reset" size={13} /></button>}
    <button type="button" className="icon-tool sm" aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"} onClick={() => void copyMessage(text).then((done) => { if (done) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } })}><Icon name={copied ? "check" : "copy"} size={13} /></button>
    {at && <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
  </div>;
}

/** Claude at work: what it is on, and for how long. */
export function Working({ stage, since, hint }: { stage: string; since: number | null; hint: string }) {
  return (
    <div className="turn working">
      <div className="thinking">
        <span className="dot live" />
        <span>{stage === "Editing the script" ? "Sonnet is editing the script" : stage && stage !== "Writing the script" ? (stage.includes("·") ? stage : `${stage}…`) : "Opus is writing the script"}</span>
        <span className="mono faint">
          <Elapsed since={since} />
        </span>
      </div>
      <small className="faint">{hint}</small>
    </div>
  );
}

/** What the producer asked, as their side of the conversation. */
export function Asked({ text, at, onRetry }: { text: string; at?: number; onRetry?: () => void }) {
  const shown = shownText(text);
  if (shown === "") return null;
  return (
    <div className="user">
      {/* Its quotes as chips among the words, where they were put (components/Quotes.tsx; Nov 12). */}
      <div className="bubble"><UserWords text={shown} /></div>
      <MessageActions text={text} at={at} onRetry={onRetry} />
    </div>
  );
}

const LINK = /(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g;

/** A paragraph with its web addresses made into links that open in the browser. */
function linked(text: string): ReactNode[] {
  return text.split(LINK).map((part, index) =>
    index % 2 ? (
      <a
        key={index}
        href={part}
        onClick={(event) => {
          event.preventDefault();
          void openPage(part);
        }}
      >
        {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * Claude asking to start the script over, answered here as Edit asks: a
 * line saying it waits for you, then the card. Nothing is cleared until the
 * producer accepts.
 */
export function ResetAsk({ state, busy, onAnswer }: { state: "pending" | "accepted" | "declined"; busy: boolean; onAnswer: (accept: boolean) => void }) {
  return (
    <>
      <p className="reset-status">
        {state === "pending" ? <Pulse size={13} /> : <Icon name={state === "accepted" ? "check" : "minus"} size={14} />}
        Reset the script · {state === "pending" ? "waiting for you" : state === "accepted" ? "done" : "rejected"}
      </p>
      {state === "pending" && (
        <div className="reset-ask" role="alertdialog" aria-label="Reset the script?">
          <b>
            <Icon name="reset" size={16} />
            Reset the script?
          </b>
          <p>Every clip and cut-in goes, and the script is laid out again as the import left it. The transcript, speakers, sources and research stay. The script before is kept in Versions.</p>
          <div className="reset-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => onAnswer(false)}>
              Reject
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => onAnswer(true)}>
              Accept and reset
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** What Claude said, a paragraph at a time. */
export function Said({ text, failed, at }: { text: string; costUsd?: number; failed?: boolean; at?: number }) {
  return (
    <div className={failed ? "turn failed" : "turn"}>
      {text.split(/\n{2,}/).map((part, index) => (
        <p key={index}>{linked(part)}</p>
      ))}
      <MessageActions text={text} at={at} />
    </div>
  );
}

/**
 * Repack's composer: a growing field, the model it runs on, and a send
 * button. Enter sends; Shift-Enter starts a new line.
 */
export function Composer({
  value,
  disabled,
  canSend,
  placeholder,
  hint,
  extra,
  label,
  model = "Opus 5.5",
  quote,
  onClearQuote,
  onStop,
  onNewChat,
  onChange,
  onSend,
}: {
  value: string;
  disabled: boolean;
  canSend: boolean;
  placeholder: string;
  hint?: string;
  /** More controls beside the model, such as the format. */
  extra?: ReactNode;
  label: string;
  /** The model the message goes to. */
  model?: string;
  quote?: string;
  onClearQuote?: () => void;
  onStop?: () => void;
  /** Starts the conversation again (Repack's New session, beside the model); absent while there's none. */
  onNewChat?: () => void;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  // Stop takes a click only once the work has run a moment: never the send's own second click.
  const stoppable = useSettled(onStop !== undefined);
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(200, Math.max(44, node.scrollHeight))}px`;
  }, [value]);
  return (
    <div className="composer">
      {quote && <div className="composer-quote"><blockquote>{quote}</blockquote><button type="button" className="icon-tool sm" aria-label="Remove quoted text" onClick={onClearQuote}><Icon name="close" size={13} /></button></div>}
      <textarea
        ref={area}
        rows={2}
        value={value}
        disabled={disabled}
        maxLength={8000}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="composer-footer">
        <span className="model" title={`${model} through your Claude login`}>
          {/* Anthropic's Claude mark, as in the editor's chat (Sphe, Nov 2), not a drawn asterisk. */}
          <ClaudeMark size={12} />
          {model}
        </span>
        {onNewChat && (
          <>
            <span className="tool-divider" />
            <button type="button" className="icon-tool sm" aria-label="New conversation" title="New conversation: clears this one; the script stays as it is" disabled={disabled} onClick={onNewChat}>
              <Icon name="new-chat" size={14} />
            </button>
          </>
        )}
        {extra}
        <span className="spacer" />
        {hint && <span className="faint composer-hint">{hint}</span>}
        {onStop ? <button type="button" className="send" aria-label="Stop response" title="Stop response" disabled={!stoppable} onClick={onStop}><span className="stop-square" /></button> : <button type="button" className="send" aria-label={label} title={label} disabled={!canSend} onClick={onSend}><Icon name="send" size={15} /></button>}
      </div>
    </div>
  );
}
