import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { command, type Instance, type ResourceProject, type VersionManifest } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import type { Loader, LoaderResult, LoaderVersion, ModpackVersion, PackResult } from "./types";
import "./create-instance.css";

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
  const modeId = useId();
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
  const [packChoice, setPackChoice] = useState<{ projectId: string; versions: ModpackVersion[]; selected: string }>({ projectId: "", versions: [], selected: "" });
  const [includeOptional, setIncludeOptional] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const metadataGeneration = useRef(0);
  const metadataContext = useRef({ open: isOpen, projectId: project?.project_id });
  metadataContext.current = { open: isOpen, projectId: project?.project_id };
  // A different project must never expose the last dialog's install choice,
  // including the render before its opening effect has reset the request.
  const packVersions = packChoice.projectId === project?.project_id ? packChoice.versions : [];
  const packVersion = packChoice.projectId === project?.project_id ? packChoice.selected : "";

  useEffect(() => {
    const request = ++metadataGeneration.current;
    if (!isOpen) return;
    const current = () => request === metadataGeneration.current && metadataContext.current.open
      && metadataContext.current.projectId === project?.project_id;
    setMode(project ? "modpack" : initialMode);
    setInstanceName(project?.title ?? "");
    setError("");
    setGameVersion((current) => current || initialManifest?.latestRelease || "");
    void command<VersionManifest>("list_versions").then((value) => {
      if (current()) setManifest(value);
    }).catch((cause) => { if (current()) setError(String(cause)); });
    if (project) {
      // Reopening the same project intentionally fetches a fresh list. Closing
      // preserves the current display for exit; opening disables old choices.
      setPackChoice({ projectId: project.project_id, versions: [], selected: "" });
      void command<ModpackVersion[]>("list_modpack_versions", { projectId: project.project_id }).then((versions) => {
        if (current()) setPackChoice({ projectId: project.project_id, versions, selected: versions[0]?.id ?? "" });
      }).catch((cause) => { if (current()) setError(String(cause)); });
    }
    return () => { metadataGeneration.current++; };
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
    if (!isOpen || busy || !project || !packVersion || !instanceName.trim()) return;
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
      className="vx-create-dialog"
      footer={mode === "version" ? <Button variant="primary" type="submit" form={`${modeId}-create-instance-form`} onClick={install} disabled={busy !== "" || !gameVersion || (loader !== "vanilla" && !loaderVersion)}>{t("library:installPrepare")}</Button> : mode === "modpack" ? <Button variant="primary" type="submit" form={`${modeId}-create-modpack-form`} onClick={installModpack} disabled={busy !== "" || !packVersion || !instanceName.trim()}>{t("library:installModpack")}</Button> : <Button variant="secondary" onClick={() => void importPack()}>{t("library:importPack")}</Button>}
    >
      {!project ? <Segmented semantic="tabs" label={t("library:createModes")} value={mode} onChange={setMode}
        idPrefix={`${modeId}-mode`} panelId={`${modeId}-panel`}
        options={[{ value: "version", label: t("library:versionMode") }, { value: "import", label: t("library:importMode") }]} />
        : <p className="vx-create-project">{project.title}</p>}
      {error ? <p role="alert">{error}</p> : null}
      <SectionPanel selectionKey={mode} className="vx-create-panel" role={!project ? "tabpanel" : undefined}
        id={`${modeId}-panel`} aria-labelledby={!project ? `${modeId}-mode-${mode}` : undefined}>
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
          <div className="vx-create-loader-group">
          <Field label={t("library:loader")}>
            <Segmented semantic="toggle" label={t("library:loader")} value={loader} onChange={setLoader}
              options={(["vanilla", "fabric", "quilt", "forge", "neoforge"] as const).map((value) => ({ value, label: value === "vanilla" ? t("library:vanilla") : value === "neoforge" ? "NeoForge" : value[0].toUpperCase() + value.slice(1) }))} />
          </Field>
          <div className="vx-create-loader-slot" data-expanded={loader !== "vanilla"}
            inert={loader === "vanilla" || !isOpen || undefined} aria-hidden={loader === "vanilla" || !isOpen || undefined}>
          <div className="vx-create-loader-slot__content">
          <Field label={t("library:loaderVersion")} htmlFor={`${modeId}-create-loader-version`}><Select id={`${modeId}-create-loader-version`} aria-label={t("library:loaderVersion")} value={loaderVersion} onChange={setLoaderVersion} disabled={!isOpen || loader === "vanilla" || loaderLoading || !loaderVersions.length} required options={[
            { value: "", label: loaderLoading ? "\u00a0" : t("library:noLoaderVersions") },
            ...loaderVersions.map((version) => ({ value: version.id, label: `${version.id}${version.recommended ? ` / ${t("library:recommended")}` : ""}` })),
          ]} /></Field>
          <LoadingStatus active={loader !== "vanilla" && loaderLoading} className="vx-create-loader-status">{t("common:status.loading")}</LoadingStatus>
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
          <Field label={t("library:modpackVersion")} htmlFor={`${modeId}-create-pack-version`}><Select id={`${modeId}-create-pack-version`} aria-label={t("library:modpackVersion")} value={packVersion} onChange={(selected) => setPackChoice((current) => current.projectId === project.project_id && current.versions.some((version) => version.id === selected) ? { ...current, selected } : current)} required options={packVersions.map((version) => ({ value: version.id, label: `${version.name || version.versionNumber} / ${version.gameVersions.join(", ")}` }))} /></Field>
          <Field label={t("library:instanceName")} htmlFor={`${modeId}-create-instance-name`}><input id={`${modeId}-create-instance-name`} required maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} /></Field>
          <label className="vx-check-row"><input type="checkbox" checked={includeOptional} onChange={(event) => setIncludeOptional(event.target.checked)} /> {t("library:includeOptional")}</label>
        </form>
      ) : null}
      </SectionPanel>
    </Dialog>
  );
}
