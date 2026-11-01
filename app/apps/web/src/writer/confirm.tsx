// Asking before something that can't be undone, in Edit's own dialog: the
// desktop app's webview has no window.confirm (it answered nothing, so
// Approve, Make this v1 and deleting a note never went through there).

import { create } from "zustand";
import { Dialog } from "./ui";

type Ask = { title: string; text: string; ok: string; danger: boolean; answer: (yes: boolean) => void };

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Asks; true when the person said yes. One at a time: a new ask answers the old one no. */
export function askConfirm(text: string, options: { title?: string; ok?: string; danger?: boolean } = {}): Promise<boolean> {
  useAsk.getState().ask?.answer(false);
  return new Promise((resolve) =>
    useAsk.setState({
      ask: {
        title: options.title ?? "Are you sure?",
        text,
        ok: options.ok ?? "OK",
        danger: options.danger ?? false,
        answer: (yes) => {
          useAsk.setState({ ask: null });
          resolve(yes);
        },
      },
    }),
  );
}

/** Where the asks show: once, inside Script mode's root (its styles). */
export function ConfirmHost() {
  const ask = useAsk((state) => state.ask);
  return (
    <Dialog
      open={ask !== null}
      onClose={() => ask?.answer(false)}
      title={ask?.title ?? ""}
      description={ask?.text}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => ask?.answer(false)}>
            Cancel
          </button>
          <button type="button" className={ask?.danger ? "danger-fill" : "primary"} data-autofocus onClick={() => ask?.answer(true)}>
            {ask?.ok ?? "OK"}
          </button>
        </>
      }
    />
  );
}
