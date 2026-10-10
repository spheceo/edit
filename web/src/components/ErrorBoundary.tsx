import { Component, type ReactNode } from "react";

import { Button } from "./ui";

/** Last line of defence: a broken component shows this instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("edit: UI crashed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-[15px] font-medium">Something went wrong in the editor</div>
        <p className="max-w-[460px] font-mono text-[12px] text-muted">{this.state.error.message}</p>
        <p className="text-[12px] text-faint">Your project is saved on the server.</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
