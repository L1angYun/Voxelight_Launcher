import { useTranslation } from "react-i18next";
import { Download, Image, Upload, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { useWorlds } from "./useInstanceContent";
import { errorText, noticeText, sizeText } from "./utils";

export function InstanceWorlds({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const manager = useWorlds(versionId, instanceId);
  const { worlds, screenshots, preview, worldName, setWorldName, busy, error, notice } = manager;
  return (
    <div className="vx-detail-stack">
      <div className="vx-toolbar">
        <div className="vx-action-row">
          <input aria-label={t("library:worldName")} value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder={t("library:worldNamePlaceholder")} maxLength={80} />
          <Button variant="secondary" icon={<Upload size={15} />} onClick={() => void manager.importWorld()}>{t("library:importWorld")}</Button>
          <Button variant="ghost" icon={<Download size={15} />} onClick={() => void manager.refresh()}>{t("common:actions.retry")}</Button>
        </div>
      </div>
      {busy ? <p role="status">{t("common:status.loading")}</p> : null}
      {error ? <p role="alert">{errorText(error, t)}</p> : null}
      {notice ? <p className="vx-inline-notice">{noticeText(notice, t)}</p> : null}
      <section className="vx-detail-section">
        <h2>{t("library:worlds")}</h2>
        {worlds.length ? <div className="vx-resource-list">{worlds.map((world) => (
          <div className="vx-resource-row" key={world.folderName}>
            <div><strong>{world.name}</strong><small>{world.folderName} · {sizeText(world.sizeBytes, i18n.language)}</small></div>
            <Button variant="secondary" onClick={() => void manager.backupWorld(world)}>{t("library:backupWorld")}</Button>
          </div>
        ))}</div> : <EmptyState title={t("library:noWorlds")} description={t("library:noWorldsDescription")} />}
      </section>
      <section className="vx-detail-section">
        <h2>{t("library:screenshots")}</h2>
        {screenshots.length ? <div className="vx-screenshot-grid">{screenshots.map((screenshot) => (
          <button key={screenshot.fileName} className="vx-screenshot" onClick={() => void manager.readScreenshot(screenshot.fileName)} title={screenshot.fileName}>
            <Image size={20} /><span>{screenshot.fileName}</span><small>{sizeText(screenshot.sizeBytes, i18n.language)}</small>
          </button>
        ))}</div> : <EmptyState title={t("library:noScreenshots")} />}
      </section>
      {preview ? <div className="vx-screenshot-preview"><IconButton label={t("common:actions.close")} icon={<X size={16} />} onClick={manager.clearPreview} /><img src={preview.dataUrl} alt={preview.fileName} /></div> : null}
    </div>
  );
}
