import React from "react";
import { createRoot } from "react-dom/client";

import { ConsoleShell } from "./console/ConsoleShell";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element missing");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <ConsoleShell />
  </React.StrictMode>,
);
