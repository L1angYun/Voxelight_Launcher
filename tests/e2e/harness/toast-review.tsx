// SPDX-License-Identifier: GPL-3.0-only
import "../../../src/design/tokens.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppearanceProvider } from "../../../src/app/AppearanceProvider";
import { Dialog } from "../../../src/components/ui/Dialog";
import { ToastProvider, useToast } from "../../../src/components/ui/ToastProvider";
import { createLauncherI18n } from "../../../src/i18n";
import type { Config } from "../../../src/lib/launcher";
import "../../../src/design/global.css";
import "../../../src/design/surfaces.css";

const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
const config: Config = {
  gameDirectory: "C:\\ToastReview", javaPath: "", maxMemoryMb: 4096, jvmArguments: "", versionIsolation: true,
  theme, downloadConcurrency: 6, microsoftClientId: "", downloadLimitKib: 0, downloadSource: "official",
  screenWidth: 1280, screenHeight: 720, language: "en-US", accentColor: "#b4f17a", effects: "full",
  worldScene: "horizon", worldMaterial: "lattice", accentSource: "voxelight", soundEnabled: false,
  javaAutoDownload: false, defaultSkin: "steve",
};

function Harness() {
  const { notify, dismiss } = useToast();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(0);
  const onDismiss = () => setDismissed(value => value + 1);
  return <main style={{ padding: 32, display: "grid", gap: 16, justifyItems: "start" }}>
    <h1>Toast and dialog motion acceptance</h1>
    <button id="notify-long" onClick={() => notify({ id: "launcher", kind: "info", onDismiss,
      message: "Preparing a large launcher installation with several additional downloads. This long notification must keep its original right and bottom alignment while a shorter launcher message replaces it." })}>Long launcher message</button>
    <button id="notify-short" onClick={() => notify({ id: "launcher", kind: "error", onDismiss, message: "Failed." })}>Short launcher message</button>
    <button id="notify-info-update" onClick={() => notify({ id: "launcher", kind: "info", onDismiss, message: "Still preparing." })}>Update launcher progress</button>
    <button id="dismiss-launcher" onClick={() => dismiss("launcher")}>Dismiss launcher</button>
    <button id="open-dialog" onClick={() => setOpen(true)}>Open dialog</button>
    <output id="dismissed-count">{dismissed}</output>
    <Dialog open={open} onOpenChange={setOpen} title="Notification host" description="A real modal dialog hosts the active notification.">
      <button id="dialog-first">First dialog control</button>
      <button id="close-dialog" onClick={() => setOpen(false)}>Close dialog</button>
    </Dialog>
  </main>;
}

const i18n = createLauncherI18n("en-US", "en-US");
await i18n.initPromise;
createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}>
  <AppearanceProvider config={config}><ToastProvider><Harness /></ToastProvider></AppearanceProvider>
</I18nextProvider>);
