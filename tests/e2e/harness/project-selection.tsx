// SPDX-License-Identifier: GPL-3.0-only
import "../../../src/design/fonts.css";
import "../../../src/design/tokens.css";
import "../../../src/design/global.css";
import "../../../src/design/surfaces.css";
import "../../../src/features/discover/discover.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppearanceProvider } from "../../../src/app/AppearanceProvider";
import { ProjectCard } from "../../../src/features/discover/ProjectCard";
import { createLauncherI18n } from "../../../src/i18n";
import { defaults } from "../../../src/lib/launcher";

const project = { project_id: "selection-fixture", slug: "selection-fixture", title: "Selected project",
  description: "Description retains regular weight when selected.", icon_url: null, downloads: 1200,
  author: "Fixture author", project_type: "mod", versions: ["1.21.1"] };
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
function Harness() {
  const [selected, setSelected] = useState(true);
  const [opens, setOpens] = useState(0);
  return <main className="vx-page-shell" style={{ margin: 40, padding: 24, width: 800 }}>
    <ProjectCard project={project} selected={selected} targetName="Fixture world"
      onOpen={() => setOpens(value => value + 1)} onInstall={() => undefined} />
    <button id="toggle-selected" onClick={() => setSelected(value => !value)}>Toggle selection</button>
    <output id="open-count">{opens}</output>
  </main>;
}
const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}>
  <AppearanceProvider config={{ ...defaults, theme, effects: "lite" }}><Harness /></AppearanceProvider>
</I18nextProvider>);
