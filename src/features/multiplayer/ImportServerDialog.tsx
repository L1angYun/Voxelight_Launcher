import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FileArchive, FolderOpen } from "lucide-react";
import { pickLauncherPath } from "../../lib/nativePaths";
import { catalogVersions, compareVersionIds } from "../library/versionCatalog";
import { formatBytes } from "../../i18n/format";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import type {
  ServerImportInspection,
  ServerImportKind,
  useMultiplayer,
} from "./useMultiplayer";

type ImportModel = Pick<
  ReturnType<typeof useMultiplayer>,
  "manifest" | "busy" | "error" | "report" | "inspectImport" | "importManaged"
>;

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

interface Detected {
  software: string | null;
  minecraftVersion: string | null;
}

/** What the chosen JAR says about itself; the folder's summary otherwise. */
function detectedFor(inspection: ServerImportInspection, jar: string): Detected {
  return inspection.details.find((detail) => detail.jar === jar) ?? inspection;
}

function suggestedName(detected: Detected, path: string) {
  const label = [detected.software, detected.minecraftVersion].filter(Boolean).join(" ");
  return (label || baseName(path)).slice(0, 80);
}

export function ImportServerDialog({
  open,
  onOpenChange,
  model,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ImportModel;
}) {
  const { t, i18n } = useTranslation();
  const { manifest, busy, error, report, inspectImport, importManaged } = model;
  const formId = useId();
  const generation = useRef(0);
  const [kind, setKind] = useState<ServerImportKind>("jar");
  const [path, setPath] = useState("");
  const [inspection, setInspection] = useState<ServerImportInspection | null>(null);
  const [jar, setJar] = useState("");
  const [name, setName] = useState("");
  const [versionId, setVersionId] = useState("");
  // The page shows errors behind this dialog; it repeats those of its own actions.
  const [ownError, setOwnError] = useState(false);
  // When the chosen path was last looked at: the choice lapses five minutes later.
  const inspectedAt = useRef(0);

  function resetSelection() {
    setOwnError(false);
    setPath("");
    setInspection(null);
    setJar("");
    setName("");
    setVersionId("");
  }

  useEffect(() => {
    generation.current++;
    setKind("jar");
    resetSelection();
    // A newly opened dialog always starts from an empty import.
  }, [open]);

  // A choice that lapsed has to be made again; any other failure keeps the
  // form, and the launcher gives the choice back for another try.
  useEffect(() => {
    if (!ownError || error?.code !== "storage.pathAuthorizationRequired") return;
    generation.current++;
    setPath("");
    setInspection(null);
    setJar("");
    setName("");
    setVersionId("");
  }, [error, ownError]);

  const visible = inspection?.kind === kind ? inspection : null;
  const selectedJar = visible?.jars.includes(jar) ? jar : "";
  const detected = visible ? detectedFor(visible, selectedJar) : null;
  const catalog = useMemo(() => catalogVersions(manifest ?? undefined), [manifest]);
  const versions = useMemo(() => {
    // The same list as creating an instance, with the latest release even
    // when the cached list does not name it yet.
    const releases = catalog
      .filter((version) => version.type === "release")
      .sort((a, b) => compareVersionIds(b.id, a.id));
    const found = detected?.minecraftVersion;
    const extra = found && !releases.some((version) => version.id === found)
      ? catalog.find((version) => version.id === found)
      : undefined;
    return extra ? [...releases, extra] : releases;
  }, [catalog, detected?.minecraftVersion]);
  const selectedVersion = versions.some((version) => version.id === versionId) ? versionId : "";
  const unsupported = visible?.unsupported ?? null;
  const valid = Boolean(
    path
    && visible
    && !unsupported
    && name.trim()
    && name.trim().length <= 80
    && selectedVersion
    && selectedJar,
  );
  const detection = detected
    ? detected.software
      ? detected.minecraftVersion
        ? t("multiplayer:importDetectedVersion", { software: detected.software, version: detected.minecraftVersion })
        : t("multiplayer:importDetected", { software: detected.software })
      : t("multiplayer:importUnknown")
    : "";
  const unsupportedText = unsupported === "installer"
    ? t("multiplayer:importUnsupported.installer")
    : unsupported === "argsFile"
      ? t("multiplayer:importUnsupported.argsFile")
      : unsupported === "noJar"
        ? t("multiplayer:importUnsupported.noJar")
        : unsupported === "needsFolder"
          ? t("multiplayer:importUnsupported.needsFolder")
          : "";
  const errorKey = error ? [`multiplayer:errors.${error.code}`, `shell:errors.${error.code}`].find((key) => i18n.exists(key)) : undefined;
  const errorText = ownError && error
    ? errorKey ? t(errorKey, error.params) : t("common:errors.internalUnexpected")
    : "";

  function chooseKind(next: ServerImportKind) {
    if (next === kind || busy) return;
    generation.current++;
    setKind(next);
    resetSelection();
  }

  async function choosePath() {
    if (busy) return;
    let picked: string | null;
    try {
      picked = await pickLauncherPath(kind === "jar" ? "serverJar" : "serverFolder");
    } catch (cause) {
      setOwnError(true);
      report(cause);
      return;
    }
    if (!picked) return;
    const request = ++generation.current;
    setOwnError(true);
    setPath(picked);
    setInspection(null);
    setJar("");
    setName("");
    setVersionId("");
    const result = await inspectImport(kind, picked);
    if (result === undefined || request !== generation.current) return;
    inspectedAt.current = Date.now();
    const first = result.jars.includes(result.defaultJar ?? "") ? result.defaultJar! : (result.jars[0] ?? "");
    const found = detectedFor(result, first);
    setInspection(result);
    setJar(first);
    setName(suggestedName(found, picked));
    setVersionId(offered(found.minecraftVersion));
  }

  /** A detected version the list offers, or none. */
  function offered(version: string | null) {
    return version && catalog.some((entry) => entry.id === version) ? version : "";
  }

  // Another JAR brings its own version and suggested name, unless the user
  // already changed them.
  function chooseJar(next: string) {
    if (!visible) return;
    const before = detectedFor(visible, selectedJar);
    const after = detectedFor(visible, next);
    setJar(next);
    if (name === suggestedName(before, path)) setName(suggestedName(after, path));
    if (!selectedVersion || selectedVersion === offered(before.minecraftVersion)) setVersionId(offered(after.minecraftVersion));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setOwnError(true);
    if (Date.now() - inspectedAt.current > 4 * 60_000) {
      // Looking again renews the choice, and shows what is there now.
      const request = ++generation.current;
      const again = await inspectImport(kind, path);
      if (request !== generation.current || !again) return;
      inspectedAt.current = Date.now();
      setInspection(again);
      if (again.unsupported || !again.jars.includes(selectedJar)) return;
    }
    const result = await importManaged({
      kind,
      path,
      name: name.trim(),
      versionId: selectedVersion,
      jar: selectedJar,
    });
    if (result !== undefined) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("multiplayer:importTitle")}
      closeLabel={t("common:actions.close")}
      className="vx-import-dialog"
      footer={<Button variant="primary" type="submit" form={formId} loading={busy === "import-managed"} disabled={!valid || Boolean(busy)}>{t("multiplayer:importAction")}</Button>}
    >
      <form id={formId} className="vx-form-stack" onSubmit={(event) => void submit(event)}>
        <Segmented semantic="toggle" fill label={t("multiplayer:importServer")} value={kind} onChange={chooseKind}
          options={[
            { value: "jar", label: t("multiplayer:importKindJar"), disabled: Boolean(busy) },
            { value: "folder", label: t("multiplayer:importKindFolder"), disabled: Boolean(busy) },
          ]} />
        <div className="vx-action-row">
          <Button
            variant="secondary"
            icon={kind === "jar" ? <FileArchive size={15} /> : <FolderOpen size={15} />}
            loading={busy === "inspect-import"}
            disabled={Boolean(busy)}
            onClick={() => void choosePath()}
          >
            {kind === "jar" ? t("multiplayer:importChooseJar") : t("multiplayer:importChooseFolder")}
          </Button>
        </div>
        {path || errorText ? (
          <div className="vx-import-summary">
            {path ? <p className="vx-path">{path}</p> : null}
            {errorText ? <p className="vx-multiplayer-error" role="alert">{errorText}</p> : null}
            {visible ? <p>{detection}</p> : null}
            {visible ? <p>{t("multiplayer:importCopy", {
              count: visible.fileCount,
              size: formatBytes(visible.totalBytes, i18n.language),
            })}</p> : null}
          </div>
        ) : null}
        {visible ? (
          <>
            {unsupportedText ? <p className="vx-multiplayer-inline-notice" role="alert">{unsupportedText}</p> : null}
            {visible.kind === "folder" && visible.jars.length > 1 ? (
              <Field label={t("multiplayer:importJar")} htmlFor={`${formId}-jar`}>
                <Select
                  id={`${formId}-jar`}
                  aria-label={t("multiplayer:importJar")}
                  value={selectedJar}
                  onChange={chooseJar}
                  disabled={Boolean(busy)}
                  options={visible.jars.map((value) => ({ value, label: value }))}
                />
              </Field>
            ) : null}
            <Field label={t("multiplayer:fields.serverName")} htmlFor={`${formId}-name`}>
              <input
                id={`${formId}-name`}
                aria-label={t("multiplayer:fields.serverName")}
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t("multiplayer:importVersion")} htmlFor={`${formId}-version`} description={t("multiplayer:importVersionHint")}>
              <Select
                id={`${formId}-version`}
                aria-label={t("multiplayer:importVersion")}
                value={selectedVersion}
                onChange={setVersionId}
                disabled={Boolean(busy)}
                required
                options={[
                  { value: "", label: t("library:selectVersion") },
                  ...versions.map((version) => ({ value: version.id, label: version.id })),
                ]}
              />
            </Field>
          </>
        ) : null}
        <p className="vx-multiplayer-inline-notice">{t("multiplayer:importWarning")}</p>
        <LoadingStatus active={busy === "inspect-import"}>{t("multiplayer:managedBusy")}</LoadingStatus>
      </form>
    </Dialog>
  );
}
