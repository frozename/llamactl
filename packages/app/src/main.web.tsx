// #410 P5a-3b, browser renderer entry: mounts the console shell on
// #root. The document guard keeps this module import-safe outside a
// browser so web-entry.test.ts can stub document + createRoot and pin
// exactly what gets mounted; in a browser a missing #root still throws.

import React from "react";
import { createRoot } from "react-dom/client";

import { ConsoleShell } from "./console/ConsoleShell";
import "./index.css";

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error("Root element missing");
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <ConsoleShell />
    </React.StrictMode>,
  );
}
