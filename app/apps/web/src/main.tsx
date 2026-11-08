// First: React looks for its commit hook once, as it loads (reactCommits.ts).
import "./lib/reactCommits";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installDiagnostics, reactErrors } from "./lib/diagnostics";
import { installQuietInputs } from "./lib/quietInputs";
import { startScrollbars } from "./lib/scrollbars";
import { watchForFreezes } from "./lib/watchdog";
import "./index.css";

installDiagnostics();
installQuietInputs();
watchForFreezes();
startScrollbars();

// Show focus rings only after Tab (see index.css); any click hides them again.
const root = document.documentElement;
addEventListener("keydown", (event) => event.key === "Tab" && (root.dataset.keyboard = ""), true);
addEventListener("pointerdown", () => delete root.dataset.keyboard, true);

createRoot(document.getElementById("root")!, reactErrors).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
