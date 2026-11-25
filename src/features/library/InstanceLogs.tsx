import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { pickLauncherPath } from "../../lib/nativePaths";
import { command } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useLumen } from "../assistant/LumenContext";
import { normalizeError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Segmented } from "../../components/ui/Segmented";
import { errorText, noticeText } from "./utils";
import type { Diagnosis, GameLog } from "./types";
import "./game-log.css";

type LogLevelFilter = "all" | "error" | "warn" | "info";
const GAME_LOG_REFRESH_MS = 3000;

export function InstanceLogs({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t } = useTranslation();
  const { logs, run, running = [] } = useLauncher();
  const lumen = useLumen();
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [gameLog, setGameLog] = useState<GameLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const logRequest = useRef(0);

  const kind = result?.kind ?? "unknown";
  const diagnosis = result ? {
    title: t(`library:diagnosis.${kind}.title`),
    reason: t(`library:diagnosis.${kind}.reason`),
    suggestions: [t(`library:diagnosis.${kind}.firstSuggestion`),
      ...(kind === "empty" ? [] : [t(`library:diagnosis.${kind}.secondSuggestion`)])],
  } : null;

  const runningThisInstance = running.some((game) => instanceId
    ? game.instanceId === instanceId
    : game.instanceId == null && game.versionId === versionId);

  const loadGameLog = useCallback(async () => {
    const request = ++logRequest.current;
    setLogLoading(true);
    try {
      const next = await command<GameLog | null>("read_game_log", { versionId, instanceId });
      if (request !== logRequest.current) return;
      setGameLog(next);
      setLogError("");
    } catch (cause) {
      if (request !== logRequest.current) return;
      setLogError(normalizeError(cause).code);
    } finally {
      if (request === logRequest.current) setLogLoading(false);
    }
  }, [versionId, instanceId]);

  useEffect(() => {
    setGameLog(null);
    setLogError("");
    setSearch("");
    setLevel("all");
    void loadGameLog();
  }, [loadGameLog]);

  useEffect(() => {
    if (!runningThisInstance) return;
    const timer = window.setInterval(() => void loadGameLog(), GAME_LOG_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadGameLog, runningThisInstance]);

  useEffect(() => () => { logRequest.current += 1; }, []);

  const searchedLines = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (gameLog?.lines ?? []).filter((line) => !query
      || line.message.toLocaleLowerCase().includes(query)
      || (line.thread ?? "").toLocaleLowerCase().includes(query));
  }, [gameLog, search]);

  const counts = useMemo(() => ({
    all: searchedLines.length,
    error: searchedLines.filter((line) => line.level === "error").length,
    warn: searchedLines.filter((line) => line.level === "warn").length,
    info: searchedLines.filter((line) => line.level === "info").length,
  }), [searchedLines]);

  const visibleLines = level === "all"
    ? searchedLines
    : searchedLines.filter((line) => line.level === level);

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
    try {
      const outputPath = await pickLauncherPath("diagnostics", `minecraft-${versionId}-diagnostics.txt`);
      if (!outputPath) return;
      await command("export_diagnostics", { versionId, instanceId, outputPath });
      setNotice("diagnosticsExported");
    } catch (cause) {
      setError(normalizeError(cause).code);
    }
  }

  const filters = [
    { value: "all" as const, label: t("library:gameLogFilterAll", { count: counts.all }) },
    { value: "error" as const, label: t("library:gameLogFilterErrors", { count: counts.error }) },
    { value: "warn" as const, label: t("library:gameLogFilterWarnings", { count: counts.warn }) },
    { value: "info" as const, label: t("library:gameLogFilterInfo", { count: counts.info }) },
  ];

  return (
    <div className="vx-detail-stack">
      <div className="vx-action-row">
        <Button variant="secondary" disabled={busy} onClick={() => void analyze()}>{busy ? t("common:status.loading") : t("library:analyze")}</Button>
        {result ? <Button variant="ghost" onClick={() => void exportReport()}>{t("library:exportDiagnostics")}</Button> : null}
        <Button variant="ghost" onClick={() => void run("logs.open", () => command("open_folder", { kind: "logs" }))}>{t("library:openLogs")}</Button>
        {lumen.configured && (Boolean(result && result.kind !== "empty") || counts.error > 0) ? (
          <Button
            variant="ghost"
            icon={<Sparkles size={14} />}
            onClick={() => lumen.openLumen({
              reason: t("shell:assistant.wake.logReason", { target: instanceId ?? versionId }),
              prompt: t("shell:assistant.wake.logPrompt", { target: instanceId ?? versionId }),
              autoSend: true,
            })}
          >
            {t("shell:assistant.wake.askLogs")}
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert">{errorText(error, t)}</p> : null}
      {notice ? <p className="vx-inline-notice">{noticeText(notice, t)}</p> : null}
      {result && diagnosis ? <section className="vx-detail-section"><h2>{diagnosis.title}</h2><p>{diagnosis.reason}</p><ul>{diagnosis.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>{result.excerpt ? <details><summary>{t("library:logExcerpt")}</summary><pre>{result.excerpt}</pre></details> : null}</section> : <EmptyState title={t("library:noDiagnosisYet")} description={t("library:noDiagnosisDescription")} />}
      <section className="vx-detail-section vx-game-log">
        <div className="vx-game-log__heading">
          <h2>{t("library:gameLog")}</h2>
          <Button variant="ghost" disabled={logLoading} onClick={() => void loadGameLog()}>{t("library:refreshGameLog")}</Button>
        </div>
        <div className="vx-game-log__toolbar">
          <input type="search" className="vx-game-log__search" value={search}
            aria-label={t("library:gameLogSearch")} placeholder={t("library:gameLogSearchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)} />
          <Segmented semantic="toggle" label={t("library:gameLogLevelFilter")}
            value={level} options={filters} onChange={setLevel} className="vx-game-log__levels" />
        </div>
        {logError ? <p role="alert">{errorText(logError, t)}</p> : null}
        {gameLog?.path ? (
          <>
            <p className="vx-game-log__path vx-path">{t("library:gameLogPath", { path: gameLog.path })}</p>
            {gameLog.truncated ? <p className="vx-inline-notice">{t("library:gameLogTruncated", { count: gameLog.lines.length })}</p> : null}
            {visibleLines.length ? (
              <div className="vx-game-log__lines" role="log" aria-label={t("library:gameLog")}>
                {visibleLines.map((line, index) => (
                  <div className="vx-game-log__line" data-level={line.level} key={`${line.time ?? ""}-${index}`}>
                    <span className="vx-game-log__time">{line.time ?? ""}</span>
                    <span className="vx-game-log__level" data-level={line.level}>{t(`library:gameLogLevel.${line.level}`)}</span>
                    {line.thread ? <span className="vx-game-log__thread">{line.thread}</span> : null}
                    <span className="vx-game-log__message">{line.message}</span>
                  </div>
                ))}
              </div>
            ) : gameLog.lines.length ? (
              <p className="vx-game-log__no-match">{t("library:gameLogNoMatch")}</p>
            ) : (
              <EmptyState title={t("library:gameLogEmpty")} description={t("library:gameLogEmptyDescription")} />
            )}
          </>
        ) : logLoading ? <p role="status">{t("common:status.loading")}</p> : !logError ? (
          <EmptyState title={t("library:gameLogEmpty")} description={t("library:gameLogEmptyDescription")} />
        ) : null}
      </section>
      <section className="vx-detail-section"><h2>{t("library:launcherLogs")}</h2><pre className="vx-log-view" role="log">{logs.length ? logs.map((entry, index) => `[${entry.timestamp}] ${entry.message}${index === logs.length - 1 ? "" : "\n"}`).join("") : t("library:noLogs")}</pre></section>
    </div>
  );
}
