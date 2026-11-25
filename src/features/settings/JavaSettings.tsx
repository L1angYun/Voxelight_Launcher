import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { command, type JavaRuntime } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Segmented";
import { MemoryOverviewHint } from "./MemoryOverviewHint";
import type { SettingsSectionProps } from "./types";

export function JavaSettings({ config, onChange, onError, onNotice }: SettingsSectionProps) {
  const { t } = useTranslation();
  const [found, setFound] = useState<JavaRuntime[]>([]);
  const [busy, setBusy] = useState(false);

  async function detect() {
    setBusy(true);
    try {
      const result = await command<JavaRuntime[]>("detect_java");
      setFound(result);
      onNotice(result.length ? "javaDetected" : "javaNotFound", { count: result.length });
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.java")}</h2><p>{t("settings:javaDescription")}</p></header>
      <section className="vx-settings-group">
        <label data-settings-target="java-executable">
          {t("settings:fields.javaPath")}
          <span className="vx-settings-input-action">
            <input aria-label={t("settings:fields.javaPath")} value={config.javaPath} placeholder={t("settings:java.auto")} onChange={(event) => onChange({ ...config, javaPath: event.target.value })} />
            <Button variant="secondary" data-settings-target="java-detect" icon={<Search size={15} />} loading={busy} onClick={() => void detect()}>{t("settings:java.detect")}</Button>
          </span>
        </label>
        {found.length ? (
          <div className="vx-settings-java-results">
            {found.map((java) => (
              <button key={java.path} type="button" aria-label={`Java ${java.major}`} onClick={() => onChange({ ...config, javaPath: java.path })}>
                <strong>Java {java.major}</strong><small>{java.path}</small>
              </button>
            ))}
          </div>
        ) : null}
        <div data-settings-target="java-memory-mode">
          <Segmented semantic="toggle" label={t("settings:memory.mode")} value={config.memoryMode ?? "manual"}
            options={[{ value: "auto", label: t("settings:memory.auto") }, { value: "manual", label: t("settings:memory.manual") }]}
            onChange={(memoryMode) => onChange({ ...config, memoryMode })} />
        </div>
        <MemoryOverviewHint />
        <div className="vx-settings-fields">
          <label data-settings-target="java-max-memory">
            {t("settings:fields.maxMemory")}
            <input aria-label={t("settings:fields.maxMemory")} type="number" min={512} max={65536} step={512} disabled={config.memoryMode === "auto"} value={config.maxMemoryMb} onChange={(event) => onChange({ ...config, maxMemoryMb: Number(event.target.value) })} />
          </label>
          <label data-settings-target="java-initial-memory">
            {t("settings:memory.initial")}
            <input aria-label={t("settings:memory.initial")} type="number" min={256} max={65536}
              value={config.minMemoryMb ?? ""} onChange={(event) => onChange({ ...config,
                minMemoryMb: event.target.value === "" ? null : Number(event.target.value),
              })} />
            <small>{t("settings:memory.initialHint")}</small>
          </label>
          <label data-settings-target="java-jvm-arguments">
            {t("settings:fields.jvmArguments")}
            <input aria-label={t("settings:fields.jvmArguments")} value={config.jvmArguments} onChange={(event) => onChange({ ...config, jvmArguments: event.target.value })} />
          </label>
        </div>
        <label className="vx-settings-check" data-settings-target="java-auto-download">
          <input type="checkbox" aria-label={t("settings:fields.javaAutoDownload")} checked={config.javaAutoDownload} onChange={(event) => onChange({ ...config, javaAutoDownload: event.target.checked })} />
          <span>{t("settings:fields.javaAutoDownload")}<small>{t("settings:java.autoDescription")}</small></span>
        </label>
      </section>
    </div>
  );
}
