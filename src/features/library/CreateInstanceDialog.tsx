import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { command, type Instance, type ResourceProject, type VersionManifest } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import type { Loader, LoaderResult, LoaderVersion, ModpackVersion, PackResult } from "./types";

export function CreateInstanceDialog({
  open: isOpen,
  onOpenChange,
  onInstalled,
  initialMode = "version",
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (versionId: string, instanceId?: string) => void | Promise<void>;
  initialMode?: "version" | "import";
  project?: ResourceProject;
}) {
  const { t } = useTranslation();
  const { manifest: initialManifest, run, reload, selectInstance, selectVersion, busy } = useLauncher();
  const [mode, setMode] = useState<"version" | "import" | "modpack">(project ? "modpack" : initialMode);
  const [manifest, setManifest] = useState<VersionManifest | undefined>(initialManifest ?? undefined);
  const [channel, setChannel] = useState("release");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [instanceName, setInstanceName] = useState(project?.title ?? "");
  const [curseforgeKey, setCurseforgeKey] = useState("");
  const [packVersions, setPackVersions] = useState<ModpackVersion[]>([]);
  const [packVersion, setPackVersion] = useState("");
  const [includeOptional, setIncludeOptional] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setMode(project ? "modpack" : initialMode);
    setInstanceName(project?.title ?? "");
    setError("");
    setGameVersion((current) => current || initialManifest?.latestRelease || "");
    void command<VersionManifest>("list_versions").then(setManifest).catch((cause) => setError(String(cause)));
    if (project) {
      void command<ModpackVersion[]>("list_modpack_versions", { projectId: project.project_id }).then((versions) => {
        setPackVersions(versions);
        setPackVersion(versions[0]?.id ?? "");
      }).catch((cause) => setError(String(cause)));
    }
  }, [initialManifest?.latestRelease, initialMode, isOpen, project]);

  useEffect(() => {
    if (loader === "vanilla" || !gameVersion) return;
    const request = ++generation.current;
    setLoaderLoading(true);
    setLoaderVersions([]);
    setLoaderVersion("");
    void command<LoaderVersion[]>("list_loader_versions", { loader, gameVersion }).then((versions) => {
      if (request !== generation.current) return;
      setLoaderVersions(versions);
      setLoaderVersion((versions.find((version) => version.recommended) ?? versions.find((version) => version.stable) ?? versions[0])?.id ?? "");
      setLoaderLoading(false);
    }).catch((cause) => {
      if (request === generation.current) {
        setError(String(cause));
        setLoaderLoading(false);
      }
    });
    return () => {
      generation.current++;
    };
  }, [gameVersion, loader]);

  async function install(event: FormEvent) {
    event.preventDefault();
    if (busy || !gameVersion || (loader !== "vanilla" && !loaderVersion)) return;
    await run("instance.install", async () => {
      let versionId = gameVersion;
      if (loader === "vanilla") await command("install_version", { versionId: gameVersion });
      else versionId = (await command<LoaderResult>("install_loader", { loader, gameVersion, loaderVersion })).versionId;
      let instance: Instance | undefined;
      if (instanceName.trim()) instance = await command<Instance>("create_instance", { name: instanceName.trim(), versionId });
      await reload();
      if (instance) selectInstance(instance.id);
      else selectVersion(versionId);
      await onInstalled(versionId, instance?.id);
      onOpenChange(false);
    });
  }

  async function importPack() {
    const path = await open({ title: t("library:importPack"), multiple: false, filters: [{ name: t("library:modpackFileType"), extensions: ["mrpack", "zip"] }] });
    if (typeof path !== "string") return;
    await run("instance.import", async () => {
      const result = await command<PackResult>("import_modpack", {
        path,
        name: instanceName.trim() || undefined,
        curseforgeApiKey: curseforgeKey.trim() || undefined,
        includeOptional: false,
      });
      await onInstalled(result.instance.versionId, result.instance.id);
      onOpenChange(false);
    });
  }

  async function installModpack(event: FormEvent) {
    event.preventDefault();
    if (!project || !packVersion || !instanceName.trim()) return;
    await run("instance.modpack", async () => {
      const result = await command<PackResult>("install_modrinth_modpack", {
        projectId: project.project_id,
        modpackVersionId: packVersion,
        name: instanceName.trim(),
        includeOptional,
      });
      await onInstalled(result.instance.versionId, result.instance.id);
      onOpenChange(false);
    });
  }

  const title = mode === "modpack" ? t("library:installModpack") : mode === "import" ? t("library:importPack") : t("library:createInstance");
  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      description={t("library:createDescription")}
      closeLabel={t("common:actions.close")}
      footer={mode === "version" ? <Button variant="primary" type="submit" form="create-instance-form" onClick={install} disabled={busy !== "" || !gameVersion || (loader !== "vanilla" && !loaderVersion)}>{t("library:installPrepare")}</Button> : mode === "modpack" ? <Button variant="primary" type="submit" form="create-modpack-form" onClick={installModpack} disabled={busy !== "" || !packVersion || !instanceName.trim()}>{t("library:installModpack")}</Button> : <Button variant="secondary" onClick={() => void importPack()}>{t("library:importPack")}</Button>}
    >
      <div className="vx-segmented" role="tablist" aria-label={t("library:createModes")}>
        {!project ? <button role="tab" aria-selected={mode === "version"} className={mode === "version" ? "is-selected" : ""} onClick={() => setMode("version")}>{t("library:versionMode")}</button> : null}
        {!project ? <button role="tab" aria-selected={mode === "import"} className={mode === "import" ? "is-selected" : ""} onClick={() => setMode("import")}>{t("library:importMode")}</button> : null}
        {project ? <span>{project.title}</span> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {mode === "version" ? (
        <form id="create-instance-form" className="vx-form-stack" onSubmit={install}>
          <div className="vx-segmented" role="group" aria-label={t("library:channel")}>
            {["release", "snapshot"].map((value) => <button key={value} type="button" aria-pressed={channel === value} className={channel === value ? "is-selected" : ""} onClick={() => { setChannel(value); setGameVersion(manifest?.versions.find((version) => version.type === value)?.id ?? manifest?.latestRelease ?? ""); }}>{t(`library:${value}`)}</button>)}
          </div>
          <Field label={t("library:version")} htmlFor="create-game-version">
            <select id="create-game-version" value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} required>
              <option value="">{t("library:selectVersion")}</option>
              {manifest?.latestRelease ? <option value={manifest.latestRelease}>{manifest.latestRelease}</option> : null}
              {manifest?.versions.filter((version) => version.type === channel && version.id !== manifest.latestRelease).map((version) => <option key={version.id} value={version.id}>{version.id}</option>)}
            </select>
          </Field>
          <Field label={t("library:loader")}>
            <div className="vx-segmented" role="group" aria-label={t("library:loader")}>
              {(["vanilla", "fabric", "quilt", "forge", "neoforge"] as const).map((value) => <button key={value} type="button" aria-pressed={loader === value} className={loader === value ? "is-selected" : ""} onClick={() => setLoader(value)}>{value === "vanilla" ? t("library:vanilla") : value === "neoforge" ? "NeoForge" : value[0].toUpperCase() + value.slice(1)}</button>)}
            </div>
          </Field>
          {loader !== "vanilla" ? <Field label={t("library:loaderVersion")} htmlFor="create-loader-version"><select id="create-loader-version" value={loaderVersion} onChange={(event) => setLoaderVersion(event.target.value)} disabled={loaderLoading || !loaderVersions.length} required><option value="">{loaderLoading ? t("common:status.loading") : t("library:noLoaderVersions")}</option>{loaderVersions.map((version) => <option key={version.id} value={version.id}>{version.id}{version.recommended ? ` / ${t("library:recommended")}` : ""}</option>)}</select></Field> : null}
          <Field label={t("library:instanceNameOptional")} htmlFor="create-instance-name"><input id="create-instance-name" maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder={t("library:instanceNamePlaceholder")} /></Field>
        </form>
      ) : null}
      {mode === "import" ? (
        <div className="vx-form-stack">
          <Field label={t("library:instanceNameOptional")} htmlFor="create-instance-name"><input id="create-instance-name" maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder={t("library:instanceNamePlaceholder")} /></Field>
          <Field label={t("library:curseforgeKeyOptional")} htmlFor="create-curseforge-key"><input id="create-curseforge-key" type="password" autoComplete="off" value={curseforgeKey} onChange={(event) => setCurseforgeKey(event.target.value)} /></Field>
          <p className="vx-muted">{t("library:importHint")}</p>
        </div>
      ) : null}
      {mode === "modpack" && project ? (
        <form id="create-modpack-form" className="vx-form-stack" onSubmit={installModpack}>
          <Field label={t("library:modpackVersion")} htmlFor="create-pack-version"><select id="create-pack-version" value={packVersion} onChange={(event) => setPackVersion(event.target.value)} required>{packVersions.map((version) => <option key={version.id} value={version.id}>{version.name || version.versionNumber} / {version.gameVersions.join(", ")}</option>)}</select></Field>
          <Field label={t("library:instanceName")} htmlFor="create-instance-name"><input id="create-instance-name" required maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} /></Field>
          <label className="vx-check-row"><input type="checkbox" checked={includeOptional} onChange={(event) => setIncludeOptional(event.target.checked)} /> {t("library:includeOptional")}</label>
        </form>
      ) : null}
    </Dialog>
  );
}
