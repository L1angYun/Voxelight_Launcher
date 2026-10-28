import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { command } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { normalizeError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { errorText, noticeText } from "./utils";
import type { Diagnosis } from "./types";

export function InstanceLogs({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t } = useTranslation();
  const { logs, run } = useLauncher();
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function analyze() {
    setBusy(true);
    setError("");
    try {
      const diagnosis = await command<Diagnosis | null>("diagnose_instance", { versionId, instanceId });
      setResult(diagnosis);
      if (!diagnosis) setNotice("noDiagnosis");
    } catch (cause) {
      setError(normalizeError(cause).code);
    } finally {
      setBusy(false);
    }
  }

  async function exportReport() {
    const outputPath = await save({ title: t("library:exportDiagnostics"), defaultPath: `minecraft-${versionId}-diagnostics.txt`, filters: [{ name: t("library:diagnosticsFileType"), extensions: ["txt"] }] });
    if (!outputPath) return;
    try {
      await command("export_diagnostics", { versionId, instanceId, outputPath });
      setNotice("diagnosticsExported");
    } catch (cause) {
      setError(normalizeError(cause).code);
    }
  }

  return (
    <div className="vx-detail-stack">
      <div className="vx-action-row">
        <Button variant="secondary" disabled={busy} onClick={() => void analyze()}>{busy ? t("common:status.loading") : t("library:analyze")}</Button>
        {result ? <Button variant="ghost" onClick={() => void exportReport()}>{t("library:exportDiagnostics")}</Button> : null}
        <Button variant="ghost" onClick={() => void run("logs.open", () => command("open_folder", { kind: "logs" }))}>{t("library:openLogs")}</Button>
      </div>
      {error ? <p role="alert">{errorText(error, t)}</p> : null}
      {notice ? <p className="vx-inline-notice">{noticeText(notice, t)}</p> : null}
      {result ? <section className="vx-detail-section"><h2>{result.title}</h2><p>{result.reason}</p><ul>{result.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>{result.excerpt ? <details><summary>{t("library:logExcerpt")}</summary><pre>{result.excerpt}</pre></details> : null}</section> : <EmptyState title={t("library:noDiagnosisYet")} description={t("library:noDiagnosisDescription")} />}
      <section className="vx-detail-section"><h2>{t("library:launcherLogs")}</h2><pre className="vx-log-view" role="log">{logs.length ? logs.map((entry, index) => `[${entry.timestamp}] ${entry.message}${index === logs.length - 1 ? "" : "\n"}`).join("") : t("library:noLogs")}</pre></section>
    </div>
  );
}
