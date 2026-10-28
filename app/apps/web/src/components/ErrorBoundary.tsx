import { Component, type ReactNode } from "react";

import { buildReport, copyText, note } from "../lib/diagnostics";
import { Button } from "./ui";

/** Last line of defence: a broken component shows this instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    note("error", "ui", `The editor crashed: ${error.stack ?? error.message}\n${info.componentStack ?? ""}`);
  }

  private copyReport = async () => {
    const error = this.state.error;
    const report = await buildReport(`The editor crashed: ${error?.message ?? "unknown error"}`);
    if (await copyText(report)) this.setState({ copied: true });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-[15px] font-medium">Something went wrong in the editor</div>
        <p className="max-w-[460px] text-[13px] leading-relaxed text-muted">
          Your project is saved. Reload to carry on. If it happens again, copy the problem report and send it to whoever looks after Edit (it has the details).
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void this.copyReport()}>
            {this.state.copied ? "Report copied" : "Copy problem report"}
          </Button>
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
