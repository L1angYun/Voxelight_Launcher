// SPDX-License-Identifier: GPL-3.0-only
import React from "react";
import ReactDOM from "react-dom/client";
import "../../src/design/fonts.css";
import "../../src/design/tokens.css";
import "../../src/design/global.css";
import "../../src/design/surfaces.css";
import "./setup.css";
import { SetupApp } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SetupApp />
  </React.StrictMode>,
);
