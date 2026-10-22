import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installDiagnostics, reactErrors } from "./lib/diagnostics";
import { watchForFreezes } from "./lib/watchdog";
import "./index.css";

installDiagnostics();
watchForFreezes();

// Show focus rings only after Tab (see index.css); any click hides them again.
const root = document.documentElement;
addEventListener("keydown", (event) => event.key === "Tab" && (root.dataset.keyboard = ""), true);
addEventListener("pointerdown", () => delete root.dataset.keyboard, true);

createRoot(document.getElementById("root")!, reactErrors).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
