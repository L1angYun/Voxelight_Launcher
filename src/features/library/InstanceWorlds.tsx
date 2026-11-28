import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Package, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Field } from "../../components/ui/Field";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { ICON } from "../../design/icons";
import { ResourceSwitch } from "./InstanceContent";
import { useWorlds } from "./useInstanceContent";
import { useWorldDatapacks } from "./useWorldDatapacks";
import { errorText, noticeText, sizeText } from "./utils";

export function InstanceWorlds({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const manager = useWorlds(versionId, instanceId);
  const { worlds, screenshots, preview, worldName, setWorldName, busy, error, notice } = manager;
  const [datapackWorldFolder, setDatapackWorldFolder] = useState<string | null>(null);
  const importNameId = useId();

  useEffect(() => {
    setDatapackWorldFolder(null);
  }, [versionId, instanceId]);

  useEffect(() => {
    if (datapackWorldFolder && !worlds.some((world) => world.folderName === datapackWorldFolder)) {
      setDatapackWorldFolder(null);
    }
  }, [datapackWorldFolder, worlds]);

  const activeWorld = worlds.find((world) => world.folderName === datapackWorldFolder) ?? null;
  const datapackManager = useWorldDatapacks(versionId, instanceId, activeWorld?.folderName ?? null);

  return (
    <div className="vx-detail-stack">
      <section className="vx-detail-section">
        <div className="vx-section-heading">
          <h2>{t("library:worlds")}</h2>
          <IconButton label={t("library:refresh")} icon={<RefreshCw />} disabled={Boolean(busy)} onClick={() => void manager.refresh()} />
        </div>
        {/* The optional name belongs to the import, so the two share one labelled control. */}
        <Field className="vx-world-import" label={t("library:worldName")} htmlFor={importNameId}>
          <div className="vx-detail-input-action">
            <input id={importNameId} value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder={t("library:worldNamePlaceholder")} maxLength={80} />
            <Button variant="secondary" icon={<Upload />} onClick={() => void manager.importWorld()}>{t("library:importWorld")}</Button>
          </div>
        </Field>
        <LoadingStatus active={Boolean(busy)}>{t("common:status.loading")}</LoadingStatus>
        {error ? <p role="alert">{errorText(error, t)}</p> : null}
        {notice ? <p className="vx-inline-notice">{noticeText(notice, t)}</p> : null}
        {worlds.length ? <div className="vx-resource-list">{worlds.map((world) => {
          const open = activeWorld?.folderName === world.folderName;
          return (
            <div className="vx-resource-row" key={world.folderName}>
              <div><strong>{world.name}</strong><small className="vx-resource-meta"><span>{world.folderName}</span>{" "}<span>{sizeText(world.sizeBytes, i18n.language)}</span></small></div>
              <div className="vx-action-row">
                <Button
                  variant="secondary"
                  icon={<Package />}
                  aria-expanded={open}
                  onClick={() => setDatapackWorldFolder(open ? null : world.folderName)}
                >
                  {t("library:datapacks")}
                </Button>
                <Button variant="secondary" onClick={() => void manager.backupWorld(world)}>{t("library:backupWorld")}</Button>
              </div>
            </div>
          );
        })}</div> : !busy && !error ? <EmptyState variant="inline" title={t("library:noWorlds")} description={t("library:noWorldsDescription")} /> : null}
      </section>
      {activeWorld ? (
        <section className="vx-detail-section" aria-label={t("library:datapacksForWorld", { world: activeWorld.name })}>
          <div className="vx-section-heading">
            <h2>{t("library:datapacksForWorld", { world: activeWorld.name })}</h2>
            <div className="vx-action-row">
              <Button variant="secondary" icon={<Upload />} disabled={Boolean(datapackManager.busy)} onClick={() => void datapackManager.importDatapacks()}>
                {t("library:importDatapacks")}
              </Button>
              <IconButton label={t("library:refresh")} icon={<RefreshCw />} disabled={Boolean(datapackManager.busy)} onClick={() => void datapackManager.refresh()} />
              <IconButton label={t("common:actions.close")} icon={<X />} onClick={() => setDatapackWorldFolder(null)} />
            </div>
          </div>
          <LoadingStatus active={Boolean(datapackManager.busy)}>{t("common:status.loading")}</LoadingStatus>
          {datapackManager.error ? <p role="alert">{errorText(datapackManager.error, t)}</p> : null}
          {datapackManager.notice ? <p className="vx-inline-notice">{noticeText(datapackManager.notice, t)}</p> : null}
          {datapackManager.datapacks.length ? (
            <div className="vx-resource-list">
              {datapackManager.datapacks.map((pack) => {
                const meta = [
                  pack.fileName,
                  pack.isDirectory ? t("library:datapackFolder") : null,
                  sizeText(pack.sizeBytes, i18n.language),
                  pack.packFormat != null ? t("library:datapackFormat", { format: pack.packFormat }) : null,
                ].filter((item): item is string => Boolean(item));
                return (
                  <div className="vx-resource-row" key={pack.fileName}>
                    <div>
                      <strong>{pack.name}</strong>
                      <small className="vx-resource-meta">{meta.map((item, index) => <span key={`${item}:${index}`}>{index > 0 ? " " : ""}{item}</span>)}</small>
                      {pack.description ? <small>{pack.description}</small> : null}
                    </div>
                    <div className="vx-action-row">
                      <ResourceSwitch checked={pack.enabled} disabled={Boolean(datapackManager.busy)}
                        onToggle={() => void datapackManager.toggleDatapack(pack)} />
                      <Button
                        variant="ghost"
                        tone="danger"
                        icon={<Trash2 />}
                        disabled={Boolean(datapackManager.busy)}
                        onClick={() => void datapackManager.deleteDatapack(pack, t("library:deleteDatapackConfirm", { name: pack.name }))}
                      >
                        {t("library:deleteDatapack")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !datapackManager.busy && !datapackManager.error ? (
            <EmptyState variant="inline" title={t("library:noDatapacks")} description={t("library:noDatapacksDescription")} />
          ) : null}
        </section>
      ) : null}
      <section className="vx-detail-section">
        <h2>{t("library:screenshots")}</h2>
        {screenshots.length ? <div className="vx-screenshot-grid">{screenshots.map((screenshot) => (
          <button key={screenshot.fileName} className="vx-screenshot" onClick={() => void manager.readScreenshot(screenshot.fileName)} title={screenshot.fileName}>
            <Image size={ICON.lg} aria-hidden="true" /><span>{screenshot.fileName}</span><small>{sizeText(screenshot.sizeBytes, i18n.language)}</small>
          </button>
        ))}</div> : !busy && !error ? <EmptyState variant="inline" title={t("library:noScreenshots")} /> : null}
      </section>
      {preview ? <div className="vx-screenshot-preview"><IconButton label={t("common:actions.close")} icon={<X />} onClick={manager.clearPreview} /><img src={preview.dataUrl} alt={preview.fileName} /></div> : null}
    </div>
  );
}
