import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { command, type JavaRuntime } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
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
        <label>
          {t("settings:fields.javaPath")}
          <span className="vx-settings-input-action">
            <input aria-label={t("settings:fields.javaPath")} value={config.javaPath} placeholder={t("settings:java.auto")} onChange={(event) => onChange({ ...config, javaPath: event.target.value })} />
            <Button variant="secondary" icon={<Search size={15} />} loading={busy} onClick={() => void detect()}>{t("settings:java.detect")}</Button>
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
        <div className="vx-settings-fields">
          <label>
            {t("settings:fields.maxMemory")}
            <input aria-label={t("settings:fields.maxMemory")} type="number" min={512} max={65536} step={512} value={config.maxMemoryMb} onChange={(event) => onChange({ ...config, maxMemoryMb: Number(event.target.value) })} />
          </label>
          <label>
            {t("settings:fields.jvmArguments")}
            <input aria-label={t("settings:fields.jvmArguments")} value={config.jvmArguments} onChange={(event) => onChange({ ...config, jvmArguments: event.target.value })} />
          </label>
        </div>
        <label className="vx-settings-check">
          <input type="checkbox" aria-label={t("settings:fields.javaAutoDownload")} checked={config.javaAutoDownload} onChange={(event) => onChange({ ...config, javaAutoDownload: event.target.checked })} />
          <span>{t("settings:fields.javaAutoDownload")}<small>{t("settings:java.autoDescription")}</small></span>
        </label>
      </section>
    </div>
  );
}
