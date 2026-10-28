import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { command, type Instance } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";

export function InstallVersionDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (versionId: string) => void;
}) {
  const { t } = useTranslation();
  const { manifest, run, reload, selectInstance, selectVersion, busy } = useLauncher();
  const [versionId, setVersionId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setVersionId((current) => current || manifest?.latestRelease || "");
  }, [manifest?.latestRelease, open]);

  async function install(event: FormEvent) {
    event.preventDefault();
    if (!versionId) return;
    await run("instance.install", async () => {
      await command("install_version", { versionId });
      let created: Instance | undefined;
      if (name.trim()) created = await command<Instance>("create_instance", { name: name.trim(), versionId });
      await reload();
      if (created) selectInstance(created.id);
      else selectVersion(versionId);
      onInstalled(versionId);
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("home:installTitle")}
      description={t("home:installDescription")}
      closeLabel={t("common:actions.close")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" type="submit" form="install-version-form" disabled={busy !== "" || !versionId}>
            {busy === "instance.install" ? t("home:installing") : t("home:install")}
          </Button>
        </>
      }
    >
      <form id="install-version-form" onSubmit={install} className="vx-form-stack">
        <Field label={t("home:version")} htmlFor="install-version">
          <select id="install-version" value={versionId} onChange={(event) => setVersionId(event.target.value)} required>
            <option value="" disabled>{t("home:noVersions")}</option>
            {manifest?.latestRelease ? <option value={manifest.latestRelease}>{manifest.latestRelease}</option> : null}
            {manifest?.versions.filter((version) => version.id !== manifest.latestRelease).map((version) => (
              <option key={version.id} value={version.id}>{version.id}</option>
            ))}
          </select>
        </Field>
        <Field label={t("home:instanceNameOptional")} htmlFor="install-instance-name">
          <input id="install-instance-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("home:instanceNamePlaceholder")} maxLength={80} />
        </Field>
      </form>
    </Dialog>
  );
}
