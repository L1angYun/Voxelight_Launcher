import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { pickLauncherPath } from "../../lib/nativePaths";
import { command, type Instance, type ResourceProject, type VersionManifest } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import type { ResourceSource } from "../discover/types";
import type { Loader, LoaderResult, LoaderVersion, ModpackVersion, PackResult } from "./types";
import "./create-instance.css";

export function CreateInstanceDialog({
  open: isOpen,
  onOpenChange,
  onInstalled,
  initialMode = "version",
  project,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (versionId: string, instanceId?: string) => void | Promise<void>;
  initialMode?: "version" | "import";
  project?: ResourceProject;
  source?: ResourceSource;
}) {
  const { t } = useTranslation();
  const modeId = useId();
  const { manifest: initialManifest, run, reload, selectInstance, selectVersion, busy } = useLauncher();
  const [creationMode, setMode] = useState<"version" | "import">(initialMode);
  const packSource = source ?? "modrinth";
  const projectId = project?.project_id;
  const projectKey = projectId ? `${packSource}:${projectId}` : "";
  const mode = project ? "modpack" : creationMode;
  const projectName = project?.title;
  const [manifest, setManifest] = useState<VersionManifest | undefined>(initialManifest ?? undefined);
  const [channel, setChannel] = useState("release");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loaderResponseKey, setLoaderResponseKey] = useState("");
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [instanceName, setInstanceName] = useState(projectName ?? "");
  const [curseforgeKey, setCurseforgeKey] = useState("");
  const [packChoice, setPackChoice] = useState<{ key: string; versions: ModpackVersion[]; selected: string }>({ key: "", versions: [], selected: "" });
  const [includeOptional, setIncludeOptional] = useState(false);
  const [error, setError] = useState("");
  const [manifestState, setManifestState] = useState<"idle" | "pending" | "ready" | "failed">("idle");
  const [loaderFailure, setLoaderFailure] = useState("");
  const [packState, setPackState] = useState<"idle" | "pending" | "ready" | "failed">("idle");
  const [manifestAttempt, retryManifest] = useState(0);
  const [loaderAttempt, retryLoader] = useState(0);
  const [packAttempt, retryPack] = useState(0);
  const loaderGeneration = useRef(0);
  const packGeneration = useRef(0);
  const manifestGeneration = useRef(0);
  const loaderKey = `${loader}:${gameVersion}`;
  const requestContext = useRef({ isOpen, mode, loaderKey, projectKey });
  requestContext.current = { isOpen, mode, loaderKey, projectKey };
  // A different project, or the same id from another source, must never expose
  // the last dialog's install choice - including the render before its opening
  // effect has reset the request.
  const packVersions = packChoice.key === projectKey ? packChoice.versions : [];
  const packVersion = packChoice.key === projectKey ? packChoice.selected : "";
  const numericPackVersion = /^[1-9]\d*$/.test(packVersion) ? Number(packVersion) : 0;
  const validPackVersion = packSource === "curseforge"
    ? numericPackVersion > 0 && numericPackVersion <= 0xffff_ffff
    : Boolean(packVersion);
  const manifestChoices = manifest?.versions.some(version => version.type === channel) || Boolean(manifest?.latestRelease);
  const names: Record<Loader, string> = { vanilla: t("library:vanilla"), fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };
  const loaderReady = loaderResponseKey === loaderKey && !loaderLoading && loaderFailure !== loaderKey;
  // Keep the mounted control's previous text during its collapse; it remains inert and cannot submit.
  const displayLoaderChoice = loaderReady || loader === "vanilla";
  const validSelection = Boolean(gameVersion && (loader === "vanilla" || loaderReady && loaderVersion));
  const noManifestVersions = manifestState === "ready" && !manifestChoices;
  const noPackVersions = packState === "ready" && packVersions.length === 0;
  const retry = (handler: () => void) => <Button type="button" size="sm" variant="ghost" onClick={handler}>{t("common:actions.retry")}</Button>;

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setInstanceName(projectName ?? "");
    setError("");
    setGameVersion(current => current || initialManifest?.latestRelease || "");
  }, [initialMode, isOpen, projectName]);

  useEffect(() => {
    const request = ++manifestGeneration.current;
    if (!isOpen || mode !== "version") return;
    const current = () => request === manifestGeneration.current && requestContext.current.isOpen && requestContext.current.mode === "version";
    setManifestState("pending");
    void command<VersionManifest>("list_versions").then(value => {
      if (!current()) return;
      setManifest(value);
      setGameVersion(selected => selected || value.latestRelease || "");
      setManifestState("ready");
    }).catch(() => { if (current()) setManifestState("failed"); });
    return () => { ++manifestGeneration.current; };
  }, [isOpen, manifestAttempt, mode]);

  useEffect(() => {
    const request = ++packGeneration.current;
    if (!isOpen || !projectId || mode !== "modpack") return;
    const key = `${packSource}:${projectId}`;
    const current = () => request === packGeneration.current && requestContext.current.isOpen
      && requestContext.current.projectKey === key && requestContext.current.mode === "modpack";
    setPackState("pending");
    setPackChoice({ key, versions: [], selected: "" });
    const load = packSource === "curseforge"
      ? command<ModpackVersion[]>("list_curseforge_modpack_versions", { projectId })
      : command<ModpackVersion[]>("list_modpack_versions", { projectId });
    void load.then(versions => {
      if (!current()) return;
      setPackChoice({ key, versions, selected: versions[0]?.id ?? "" });
      setPackState("ready");
    }).catch(() => { if (current()) setPackState("failed"); });
    return () => { ++packGeneration.current; };
  }, [isOpen, mode, packAttempt, packSource, projectId]);

  useEffect(() => {
    const request = ++loaderGeneration.current;
    if (!isOpen || mode !== "version" || loader === "vanilla" || !gameVersion) return;
    const current = () => request === loaderGeneration.current && requestContext.current.isOpen
      && requestContext.current.mode === "version" && requestContext.current.loaderKey === loaderKey;
    setLoaderFailure("");
    setLoaderLoading(true);
    setLoaderVersions([]);
    setLoaderVersion("");
    void command<LoaderVersion[]>("list_loader_versions", { loader, gameVersion }).then(versions => {
      if (!current()) return;
      setLoaderVersions(versions);
      setLoaderVersion((versions.find((version) => version.recommended) ?? versions.find((version) => version.stable) ?? versions[0])?.id ?? "");
    }).catch(() => { if (current()) setLoaderFailure(loaderKey); })
      .finally(() => {
        if (current()) {
          setLoaderResponseKey(loaderKey);
          setLoaderLoading(false);
        }
      });
    return () => { ++loaderGeneration.current; };
  }, [gameVersion, isOpen, loader, loaderAttempt, loaderKey, mode]);

  async function install(event: FormEvent) {
    event.preventDefault();
    if (busy || !validSelection) return;
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
    setError("");
    await run("instance.import", async () => {
      const path = await pickLauncherPath("packRead");
      if (!path) return;
      if (project && packSource === "curseforge" && !/\.zip$/i.test(path)) { setError(t("discover:curseforgeZipRequired")); return; }
      const result = await command<PackResult>("import_modpack", {
        path,
        name: instanceName.trim() || undefined,
        // From Discover's modpack dialog the key field is not shown: the saved
        // or built-in key is used, never one typed earlier in another mode.
        curseforgeApiKey: project ? undefined : curseforgeKey.trim() || undefined,
        includeOptional: project ? includeOptional : false,
      });
      await onInstalled(result.instance.versionId, result.instance.id);
      onOpenChange(false);
    });
  }

  async function installModpack(event: FormEvent) {
    event.preventDefault();
    if (!isOpen || busy || !project || packState !== "ready" || !validPackVersion || !instanceName.trim()) return;
    const name = instanceName.trim();
    await run("instance.modpack", async () => {
      let result: PackResult;
      if (packSource === "curseforge") {
        result = await command<PackResult>("install_curseforge_modpack", {
          projectId: project.project_id,
          fileId: Number(packVersion),
          name,
          includeOptional,
        });
      } else {
        result = await command<PackResult>("install_modrinth_modpack", {
          projectId: project.project_id,
          modpackVersionId: packVersion,
          name,
          includeOptional,
        });
      }
      await onInstalled(result.instance.versionId, result.instance.id);
      onOpenChange(false);
    });
  }

  const title = mode === "modpack" ? t("library:installModpack") : mode === "import" ? t("library:importPack") : t("library:createInstance");
  const packInstallDisabled = busy !== "" || packState !== "ready" || !validPackVersion || !instanceName.trim();
  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      description={t("library:createDescription")}
      closeLabel={t("common:actions.close")}
      className="vx-create-dialog"
      footer={mode === "version" ? <Button variant="primary" type="submit" form={`${modeId}-create-instance-form`} onClick={install} disabled={busy !== "" || !validSelection}>{t("library:installPrepare")}</Button> : mode === "modpack" ? (
        packSource === "curseforge" ? <>
          <Button variant="secondary" disabled={busy !== ""} onClick={() => void importPack()}>{t("discover:importCurseforgeZip")}</Button>
          <Button variant="primary" type="submit" form={`${modeId}-create-modpack-form`} onClick={installModpack} disabled={packInstallDisabled}>{t("library:installModpack")}</Button>
        </> : <Button variant="primary" type="submit" form={`${modeId}-create-modpack-form`} onClick={installModpack} disabled={packInstallDisabled}>{t("library:installModpack")}</Button>
      ) : <Button variant="secondary" onClick={() => void importPack()}>{t("library:importPack")}</Button>}
    >
      {!projectName ? <Segmented semantic="tabs" label={t("library:createModes")} value={creationMode} onChange={setMode}
        idPrefix={`${modeId}-mode`} panelId={`${modeId}-panel`}
        options={[{ value: "version", label: t("library:versionMode") }, { value: "import", label: t("library:importMode") }]} />
        : <p className="vx-create-project">{projectName}</p>}
      {error ? <p role="alert">{error}</p> : null}
      <SectionPanel selectionKey={mode} className="vx-create-panel" role={!projectName ? "tabpanel" : undefined}
        id={`${modeId}-panel`} aria-labelledby={!projectName ? `${modeId}-mode-${mode}` : undefined}>
      {mode === "version" ? (
        <form id={`${modeId}-create-instance-form`} className="vx-form-stack" onSubmit={install}>
          <Segmented semantic="toggle" label={t("library:channel")} value={channel}
            options={["release", "snapshot"].map((value) => ({ value, label: t(`library:${value}`) }))}
            onChange={(value) => { setChannel(value); setGameVersion(manifest?.versions.find((version) => version.type === value)?.id ?? manifest?.latestRelease ?? ""); }} />
          <Field label={t("library:version")} htmlFor={`${modeId}-create-game-version`}>
            <Select id={`${modeId}-create-game-version`} aria-label={t("library:version")} value={gameVersion} onChange={setGameVersion} required options={[
              { value: "", label: t("library:selectVersion") },
              ...(manifest?.latestRelease ? [{ value: manifest.latestRelease, label: manifest.latestRelease }] : []),
              ...(manifest?.versions.filter((version) => version.type === channel && version.id !== manifest.latestRelease).map((version) => ({ value: version.id, label: version.id })) ?? []),
            ]} />
          </Field>
          {manifestState === "pending" && !manifestChoices
            ? <LoadingStatus active>{t("library:createMetadata.loadingGame")}</LoadingStatus> : null}
          {manifestState === "failed" || noManifestVersions ? <div className="vx-action-row">
            <span role={manifestState === "failed" ? "alert" : "status"}>{t(manifestState === "failed" ? "library:createMetadata.failedGame" : "library:createMetadata.emptyGame")}</span>
            {retry(() => retryManifest(value => value + 1))}</div> : null}
          <div className="vx-create-loader-group">
          <Field label={t("library:loader")}>
            <Segmented semantic="toggle" label={t("library:loader")} value={loader} onChange={setLoader}
              options={(["vanilla", "fabric", "quilt", "forge", "neoforge"] as const).map((value) => ({ value, label: value === "vanilla" ? t("library:vanilla") : value === "neoforge" ? "NeoForge" : value[0].toUpperCase() + value.slice(1) }))} />
          </Field>
          <div className="vx-create-loader-slot" data-expanded={loader !== "vanilla"}
            inert={loader === "vanilla" || !isOpen || undefined} aria-hidden={loader === "vanilla" || !isOpen || undefined}>
          <div className="vx-create-loader-slot__content">
          <Field label={t("library:loaderVersion")} htmlFor={`${modeId}-create-loader-version`}><Select id={`${modeId}-create-loader-version`} aria-label={t("library:loaderVersion")} value={displayLoaderChoice ? loaderVersion : ""} onChange={setLoaderVersion} disabled={!isOpen || loader === "vanilla" || !loaderReady || !loaderVersions.length} required options={[
            { value: "", label: displayLoaderChoice ? t("library:noLoaderVersions") : "\u00a0" },
            ...(displayLoaderChoice ? loaderVersions.map((version) => ({ value: version.id, label: `${version.id}${version.recommended ? ` / ${t("library:recommended")}` : ""}` })) : []),
          ]} /></Field>
          <LoadingStatus active={loader !== "vanilla" && loaderLoading} className="vx-create-loader-status">{t("common:status.loading")}</LoadingStatus>
          {loader !== "vanilla" && (loaderFailure === loaderKey || loaderReady && !loaderVersions.length) ? <div className="vx-action-row">
            {loaderFailure === loaderKey ? <span role="alert">{t("library:createMetadata.failedLoader", { loader: names[loader] })}</span> : null}
            {retry(() => retryLoader(value => value + 1))}</div> : null}
          </div>
          </div>
          </div>
          <Field label={t("library:instanceNameOptional")} htmlFor={`${modeId}-create-instance-name`}><input id={`${modeId}-create-instance-name`} maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder={t("library:instanceNamePlaceholder")} /></Field>
        </form>
      ) : null}
      {mode === "import" ? (
        <div className="vx-form-stack">
          <Field label={t("library:instanceNameOptional")} htmlFor={`${modeId}-create-instance-name`}><input id={`${modeId}-create-instance-name`} maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} placeholder={t("library:instanceNamePlaceholder")} /></Field>
          <Field label={t("library:curseforgeKeyOptional")} htmlFor={`${modeId}-create-curseforge-key`}><input id={`${modeId}-create-curseforge-key`} type="password" autoComplete="off" value={curseforgeKey} onChange={(event) => setCurseforgeKey(event.target.value)} /></Field>
          <p className="vx-muted">{t("library:importHint")}</p>
        </div>
      ) : null}
      {mode === "modpack" && project ? (
        <form id={`${modeId}-create-modpack-form`} className="vx-form-stack" onSubmit={installModpack}>
          <Field label={t("library:modpackVersion")} htmlFor={`${modeId}-create-pack-version`}><Select id={`${modeId}-create-pack-version`} aria-label={t("library:modpackVersion")} value={packVersion} disabled={!isOpen || packState !== "ready" || noPackVersions} onChange={(selected) => setPackChoice((current) => current.key === projectKey && current.versions.some((version) => version.id === selected) ? { ...current, selected } : current)} required options={packVersions.map((version) => ({ value: version.id, label: `${version.name || version.versionNumber} / ${version.gameVersions.join(", ")}` }))} /></Field>
          {packSource === "curseforge" ? <p className="vx-muted">{t("library:curseforgePackHint")}</p> : null}
          {packState === "pending" ? <LoadingStatus active>{t("library:createMetadata.loadingPack")}</LoadingStatus> : null}
          {packState === "failed" || noPackVersions ? <div className="vx-action-row">
            <span role={packState === "failed" ? "alert" : "status"}>{t(packState === "failed" ? "library:createMetadata.failedPack" : "library:createMetadata.emptyPack")}</span>
            {retry(() => retryPack(value => value + 1))}</div> : null}
          <Field label={t("library:instanceName")} htmlFor={`${modeId}-create-instance-name`}><input id={`${modeId}-create-instance-name`} required maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} /></Field>
          <label className="vx-check-row"><input type="checkbox" checked={includeOptional} onChange={(event) => setIncludeOptional(event.target.checked)} /> {t("library:includeOptional")}</label>
        </form>
      ) : null}
      </SectionPanel>
    </Dialog>
  );
}
