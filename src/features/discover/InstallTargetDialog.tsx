import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight } from "lucide-react";
import { ExternalLink } from "../../components/ui/ExternalLink";
import { command } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { downloadStageRegistry } from "../../app/registry";
import { formatNumber } from "../../i18n/format";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/Feedback";
import { Field } from "../../components/ui/Field";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { Segmented } from "../../components/ui/Segmented";
import { Select } from "../../components/ui/Select";
import { ICON } from "../../design/icons";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import type { Loader, LoaderVersion } from "../library/types";
import { errorText, loaderDisplayName } from "../library/utils";
import type { ResourceCreateRequest, ResourceTargetFlow, TargetRow } from "./types";

const rowKey = (row: TargetRow) => row.instanceId ? "instance:" + row.instanceId : "version:" + row.versionId;

export function InstallTargetDialog({ flow, onClose, onInstall, onCreate, onCancel, onCreateInstance, onDownloads }: {
  flow?: ResourceTargetFlow;
  onClose: () => void;
  onInstall: (row: TargetRow) => Promise<void>;
  onCreate: (request: ResourceCreateRequest) => Promise<void>;
  onCancel: (flowId: number) => Promise<void>;
  onCreateInstance: () => void;
  onDownloads?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { resourceProgress, manifest, selectedVersionId, selectedInstance } = useLauncher();
  const progress = flow?.taskId && resourceProgress?.taskId === flow.taskId ? resourceProgress : null;
  const id = useId();
  const [choice, setChoice] = useState("");
  const [loader, setLoader] = useState<Loader>("fabric");
  const [gameVersion, setGameVersion] = useState("");
  const [name, setName] = useState("");
  const [loaderState, setLoaderState] = useState<{ key: string; loading: boolean; versions: LoaderVersion[]; selected: string; error?: string }>({ key: "", loading: false, versions: [], selected: "" });
  const [actionError, setActionError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const generation = useRef(0);
  const compatible = flow?.plan?.targets.filter(row => row.compatible) ?? [];
  const incompatible = flow?.plan?.targets.filter(row => !row.compatible) ?? [];
  const suggestion = flow?.plan?.suggestion;
  const matrix = suggestion?.matrix ?? [];
  const row = compatible.find(row => rowKey(row) === choice);
  const working = flow?.status === "creating" || flow?.status === "installing";
  const progressStage = downloadStageRegistry.ids().find(stage => stage === progress?.stage);
  const progressLabel = progressStage && progressStage !== "unknown"
    ? t(downloadStageRegistry.get(progressStage).labelKey, { ns: "downloads" })
    : t("discover:installTarget.creating");
  const total = progress && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 0;
  const completed = progress && Number.isFinite(progress.completed)
    ? Math.max(0, total > 0 ? Math.min(progress.completed, total) : progress.completed) : 0;
  const progressCount = total > 0
    ? t("downloads:progress.files", { completed: formatNumber(completed, i18n.language), total: formatNumber(total, i18n.language) })
    : completed > 0 ? t("downloads:progress.completedUnknown", { completed: formatNumber(completed, i18n.language) }) : "";
  const progressSuffix = progressCount
    ? /^(?:zh|ja)/i.test(i18n.language) ? `（${progressCount}）` : ` (${progressCount})`
    : "";
  const versionsKey = [flow?.id, loader, gameVersion].join(":");
  const loaderReady = loader === "vanilla" || loaderState.key === versionsKey && !loaderState.loading && Boolean(loaderState.selected);
  const external = flow?.project.external_url || (flow?.source === "curseforge"
    ? "https://www.curseforge.com/projects/" + flow.project.project_id
    : "https://modrinth.com/" + (flow?.plan?.unsupportedReason === "datapack" ? "datapack" : flow?.project.project_type) + "/" + flow?.project.slug);
  const manual = Boolean(flow?.plan?.manualOnly);
  const manualDownload = flow?.plan?.manualDownload;
  const manualUrl = manualDownload?.url || external;
  const manualFolder = flow?.resourceType === "resourcepack" ? "resourcepacks"
    : flow?.resourceType === "shader" ? "shaderpacks" : "mods";
  // The folder note names a target only when there is one: the selected
  // target, or else the only compatible one.
  const manualTarget = compatible.find(target => target.versionId === selectedVersionId && (target.instanceId ?? undefined) === selectedInstance?.id)
    ?? (compatible.length === 1 ? compatible[0] : undefined);

  useEffect(() => {
    if (!flow) return;
    const targets = flow.plan?.targets.filter(row => row.compatible) ?? [];
    setChoice(targets[0] ? rowKey(targets[0]) : "create");
    setLoader(flow.plan?.suggestion?.loader ?? "fabric");
    setGameVersion(flow.plan?.suggestion?.gameVersion ?? "");
    setName(flow.plan?.suggestion?.name ?? flow.project.title);
    setActionError(""); setCancelling(false);
  }, [flow?.id, flow?.plan]);

  useEffect(() => {
    const request = ++generation.current;
    if (!flow?.open || manual || !suggestion || choice !== "create" || loader === "vanilla" || !gameVersion || working) return;
    setLoaderState({ key: versionsKey, loading: true, versions: [], selected: "" });
    void command<LoaderVersion[]>("list_loader_versions", { loader, gameVersion }).then(versions => {
      if (request !== generation.current) return;
      setLoaderState({ key: versionsKey, loading: false, versions, selected: (versions.find(version => version.recommended) ?? versions.find(version => version.stable) ?? versions[0])?.id ?? "" });
    }).catch(cause => {
      const err = normalizeError(cause);
      if (request === generation.current) setLoaderState({ key: versionsKey, loading: false, versions: [], selected: "", error: errorText(err.code, t, err.params) });
    });
    return () => { ++generation.current; };
  }, [choice, flow?.open, gameVersion, loader, manual, suggestion, t, versionsKey, working]);

  function changeLoader(next: Loader) {
    setLoader(next);
    const supported = matrix.find(entry => entry.loader === next)?.gameVersions ?? [];
    const releases = manifest?.versions.filter(version => version.type === "release").map(version => version.id) ?? [];
    setGameVersion(releases.find(version => supported.includes(version)) ?? supported[0] ?? "");
  }

  async function cancel() {
    if (!flow || cancelling) return;
    setCancelling(true); setActionError("");
    try {
      await onCancel(flow.id);
    } catch (cause) { const err = normalizeError(cause); setActionError(errorText(err.code, t, err.params)); }
    finally { setCancelling(false); }
  }

  if (!flow) return null;
  const options = [
    ...compatible.map(target => ({ key: rowKey(target), name: target.name, gameVersion: target.gameVersion, loader: loaderDisplayName(target.loader, t) })),
    ...(suggestion ? [{ key: "create", name: t("discover:installTarget.newInstance"), gameVersion: gameVersion || suggestion.gameVersion, loader: loaderDisplayName(loader, t) }] : []),
  ];
  const choiceListed = options.some(option => option.key === choice);
  const unsupported = flow.plan?.unsupportedReason ?? (flow.status === "choose" && flow.plan && !compatible.length && !suggestion
    ? flow.plan.manifestUnavailable ? "manifestUnavailable" : "noReleaseVersions"
    : undefined);
  const shaderWarning = flow.resourceType === "shader";
  const ready = flow.status === "choose" && !unsupported;
  const footer = working ? <>
    {onDownloads ? <Button variant="ghost" onClick={() => { onClose(); onDownloads(); }}>{t("discover:installTarget.downloads")}</Button> : null}
    <Button tone="danger" disabled={cancelling} onClick={() => void cancel()}>{t("discover:installTarget.cancel")}</Button>
  </> : flow.status === "curseforge" ? <Button variant="primary" onClick={() => { onClose(); onCreateInstance(); }}>{t("discover:installTarget.newInstance")}</Button>
    : manual && flow.status === "choose" ? <ExternalLink url={manualUrl} variant="primary">{t("discover:installTarget.manual.open")}</ExternalLink>
    : ready && (row || suggestion) ? <Button variant="primary" disabled={!row && (!loaderReady || !name.trim() || name.trim().length > 80 || !gameVersion)}
      onClick={() => row ? void onInstall(row) : void onCreate({ loader, gameVersion, loaderVersion: loader === "vanilla" ? undefined : loaderState.selected, name: name.trim() })}>
      {row ? t("discover:installTarget.installInto", { name: row.name }) : t("discover:installTarget.createAndInstall")}
    </Button> : undefined;

  return <Dialog open={flow.open && flow.status !== "resolving"} onOpenChange={open => { if (!open) onClose(); }}
    title={t("discover:installTarget.title", { title: flow.project.title })} className="vx-install-target" footer={footer}>
    <LoadingStatus active={flow.status === "resolving"}>{t("common:status.loading")}</LoadingStatus>
    {flow.error ? <p role="alert">{errorText(flow.error.code, t, flow.error.params)}</p> : null}
    {actionError ? <p role="alert">{actionError}</p> : null}
    {flow.status === "curseforge" ? <p>{t("discover:installTarget.curseforge")}</p> : null}
    {manual ? <section className="vx-install-target__section" role="note">
      <h3>{t("discover:installTarget.manual.title")}</h3>
      <p>{t("discover:installTarget.manual.reason." + (manualDownload?.reason ?? "noDownloadUrl"))}</p>
      {manualDownload ? <p className="vx-install-target__summary">{manualDownload.displayName && manualDownload.displayName !== manualDownload.fileName
        ? t("discover:installTarget.manual.fileNamed", { name: manualDownload.displayName, fileName: manualDownload.fileName })
        : t("discover:installTarget.manual.file", { fileName: manualDownload.fileName })}</p> : null}
      <p className="vx-install-target__summary">{manualTarget
        ? t("discover:installTarget.manual.folderTarget", { folder: manualFolder, name: manualTarget.name })
        : t("discover:installTarget.manual.folder", { folder: manualFolder })}</p>
    </section> : null}
    {unsupported && !manual ? <EmptyState title={t("discover:installTarget.unsupported." + unsupported)}
      action={<ExternalLink url={external} variant="ghost">{t("discover:external")}</ExternalLink>} /> : null}
    {flow.plan && !unsupported && !manual ? <>
      <div inert={working || undefined}>
        {options.length ? <section className="vx-install-target__section">
          <h3>{t("discover:installTarget.compatible")}</h3>
          {/* "New instance" is the last option of the same radio group, so the
              arrow keys move through every place the resource can go. */}
          <div role="radiogroup" aria-label={t("discover:installTarget.compatible")} className="vx-install-target__rows">
            {options.map((option, index) => {
              const checked = option.key === choice;
              return <button type="button" role="radio" key={option.key} aria-checked={checked} data-visual-owner="lattice"
                tabIndex={checked || (!choiceListed && index === 0) ? 0 : -1} className="vx-install-target__row" onClick={() => setChoice(option.key)}
                onKeyDown={event => {
                  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
                  event.preventDefault();
                  const next = (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : options.length - 1)) % options.length;
                  setChoice(options[next].key);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
                }}>
                <LatticeFrame selected={checked} signature={option.key} />
                <strong>{option.name}</strong>
                <span className="vx-install-target__meta"><span>{option.gameVersion}</span><span>{option.loader}</span></span>
                <Check className="vx-install-target__check" size={ICON.md} aria-hidden="true" />
              </button>;
            })}
          </div>
          {choice === "create" && suggestion ? <div className="vx-install-target__create">
            <Field label={t("library:loader")}><Segmented semantic="toggle" label={t("library:loader")} value={loader} onChange={changeLoader}
              options={matrix.map(entry => ({ value: entry.loader, label: loaderDisplayName(entry.loader, t) }))} /></Field>
            <Field label={t("discover:installTarget.gameVersion")}><Select aria-label={t("discover:installTarget.gameVersion")} value={gameVersion} onChange={setGameVersion}
              options={(matrix.find(entry => entry.loader === loader)?.gameVersions ?? []).map(value => ({ value, label: value }))} /></Field>
            {loader !== "vanilla" ? <Field label={t("discover:installTarget.loaderVersion")} error={loaderState.error}>
              <Select aria-label={t("discover:installTarget.loaderVersion")} value={loaderState.key === versionsKey ? loaderState.selected : ""} disabled={loaderState.loading || working}
                onChange={selected => setLoaderState(current => ({ ...current, selected }))}
                options={loaderState.versions.map(version => ({ value: version.id, label: version.id, metadata: version.recommended ? t("discover:installTarget.recommended") : undefined }))} />
            </Field> : null}
            <LoadingStatus active={loader !== "vanilla" && loaderState.loading}>{t("common:status.loading")}</LoadingStatus>
            {loader !== "vanilla" && loaderState.key === versionsKey && !loaderState.loading && !loaderState.versions.length ? <p role="status">{t("discover:installTarget.noLoaderVersions")}</p> : null}
            <Field label={t("discover:installTarget.name")} htmlFor={id + "-name"}>
              <input id={id + "-name"} name="resource-instance-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
            </Field>
            <p className="vx-install-target__summary">{t("discover:installTarget.summary", { loader: loaderDisplayName(loader, t), loaderVersion: loader === "vanilla" ? "" : loaderState.selected, gameVersion, title: flow.project.title })}</p>
          </div> : null}
        </section> : null}
        {incompatible.length ? <details className="vx-install-target__section">
          <summary><ChevronRight size={ICON.sm} aria-hidden="true" />{t("discover:installTarget.incompatible", { count: incompatible.length })}</summary>
          <div className="vx-install-target__rows">{incompatible.map(target => <div className="vx-install-target__row" key={rowKey(target)} aria-disabled="true">
            <strong>{target.name}</strong><span className="vx-install-target__meta"><span>{target.gameVersion}</span><span>{loaderDisplayName(target.loader, t)}</span></span>
            <small>{t("discover:installTarget.reason." + (target.reason ?? "metadataMissing"))}</small>
          </div>)}</div>
        </details> : null}
      </div>
    </> : null}
    {flow.plan && (manual || !unsupported) && shaderWarning ? <p className="vx-install-target__warning" role="note">{t("discover:installTarget.shaderWarning")}</p> : null}
    <LoadingStatus active={Boolean(working)}>{progressLabel}{progressSuffix}</LoadingStatus>
  </Dialog>;
}
