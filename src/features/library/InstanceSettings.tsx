import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickLauncherPath } from "../../lib/nativePaths";
import { command, type Instance } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { Field } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/Segmented";
import { MemoryOverviewHint } from "../settings/MemoryOverviewHint";
import { Select } from "../../components/ui/Select";
import { OptifineManualHint } from "./OptifineManualHint";
import type { Loader, LoaderResult, LoaderVersion } from "./types";
import { errorText } from "./utils";

function normalizeLoader(value?: string): Loader {
  const lower = (value ?? "").trim().toLowerCase();
  if (lower === "fabric" || lower === "quilt" || lower === "forge" || lower === "neoforge" || lower === "optifine") return lower;
  return "vanilla";
}

type MemoryMode = "auto" | "manual" | "inherit";
const fromInstance = (row: Instance): MemoryMode => row.memoryMode ?? (row.maxMemoryMb != null ? "manual" : "inherit");
/** The saved values of the instance as the form holds them, for reset and the unsaved-changes check. */
const formOf = (row: Instance) => ({
  name: row.name, category: row.category, notes: row.notes, iconPath: row.iconPath ?? "",
  memoryMode: fromInstance(row), maxMemoryMb: row.maxMemoryMb?.toString() ?? "", minMemoryMb: row.minMemoryMb?.toString() ?? "",
  javaPath: row.javaPath ?? "", jvmArguments: row.jvmArguments ?? "", gameProxyMode: row.gameProxyMode ?? "default",
  screenWidth: row.screenWidth?.toString() ?? "", screenHeight: row.screenHeight?.toString() ?? "",
});

export function InstanceSettings({ instance, onChanged }: { instance: Instance; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { run, busy, config } = useLauncher();
  const currentLoader = normalizeLoader(instance.loader);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>(fromInstance(instance));
  const [name, setName] = useState(instance.name);
  const [category, setCategory] = useState(instance.category);
  const [notes, setNotes] = useState(instance.notes);
  const [iconPath, setIconPath] = useState(instance.iconPath ?? "");
  const [maxMemoryMb, setMaxMemoryMb] = useState(instance.maxMemoryMb?.toString() ?? "");
  const [minMemoryMb, setMinMemoryMb] = useState(instance.minMemoryMb?.toString() ?? "");
  const [javaPath, setJavaPath] = useState(instance.javaPath ?? "");
  const [jvmArguments, setJvmArguments] = useState(instance.jvmArguments ?? "");
  const [gameProxyMode, setGameProxyMode] = useState(instance.gameProxyMode ?? "default");
  const [screenWidth, setScreenWidth] = useState(instance.screenWidth?.toString() ?? "");
  const [screenHeight, setScreenHeight] = useState(instance.screenHeight?.toString() ?? "");
  const [notice, setNotice] = useState("");

  const [baseGameVersion, setBaseGameVersion] = useState(currentLoader === "vanilla" ? instance.versionId : "");
  const [targetLoader, setTargetLoader] = useState<Loader>(currentLoader);
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[]>([]);
  const [targetLoaderVersion, setTargetLoaderVersion] = useState(instance.loaderVersion ?? "");
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [loaderFailed, setLoaderFailed] = useState(false);
  const [loaderAttempt, retryLoader] = useState(0);
  const loaderGen = useRef(0);

  const loadForm = (row: Instance) => {
    const form = formOf(row);
    setName(form.name);
    setCategory(form.category);
    setNotes(form.notes);
    setIconPath(form.iconPath);
    setMaxMemoryMb(form.maxMemoryMb);
    setMemoryMode(form.memoryMode);
    setMinMemoryMb(form.minMemoryMb);
    setJavaPath(form.javaPath);
    setJvmArguments(form.jvmArguments);
    setGameProxyMode(form.gameProxyMode);
    setScreenWidth(form.screenWidth);
    setScreenHeight(form.screenHeight);
  };
  useEffect(() => {
    loadForm(instance);
    setTargetLoader(normalizeLoader(instance.loader));
    setTargetLoaderVersion(instance.loaderVersion ?? "");
  }, [instance]);
  const current = { name, category, notes, iconPath, memoryMode, maxMemoryMb, minMemoryMb, javaPath, jvmArguments, gameProxyMode, screenWidth, screenHeight };
  const saved = formOf(instance);
  const dirty = (Object.keys(saved) as (keyof typeof saved)[]).some((key) => current[key] !== saved[key]);
  const discard = () => { loadForm(instance); setNotice(""); };
  // An empty override shows what the instance inherits from the global settings.
  const inherited = (value: string | number | null | undefined) => value === undefined || value === null || value === "" || value === 0
    ? t("library:inheritsGlobal") : t("library:inheritsValue", { value });
  const autoMemory = t("settings:memory.auto");
  const maxMemoryPlaceholder = memoryMode === "auto" ? autoMemory
    : inherited(config?.memoryMode === "auto" ? autoMemory : config?.maxMemoryMb);

  useEffect(() => {
    let active = true;
    const fallback = currentLoader === "vanilla" ? instance.versionId : "";
    setBaseGameVersion(fallback);
    void command<{ gameVersion: string; loader?: string | null }>("get_resource_context", {
      versionId: instance.versionId,
      instanceId: instance.id,
    }).then((ctx) => {
      if (active && ctx?.gameVersion) setBaseGameVersion(ctx.gameVersion);
    }).catch(() => {
      if (active && !fallback) setBaseGameVersion(instance.versionId);
    });
    return () => { active = false; };
  }, [currentLoader, instance.id, instance.versionId]);

  useEffect(() => {
    const request = ++loaderGen.current;
    // OptiFine is never installed online, so it has no version list here.
    if (targetLoader === "vanilla" || targetLoader === "optifine" || !baseGameVersion) {
      setLoaderVersions([]);
      setLoaderLoading(false);
      setLoaderFailed(false);
      return;
    }
    setLoaderLoading(true);
    setLoaderFailed(false);
    setLoaderVersions([]);
    void command<LoaderVersion[]>("list_loader_versions", {
      loader: targetLoader,
      gameVersion: baseGameVersion,
    }).then((versions) => {
      if (loaderGen.current !== request) return;
      const list = Array.isArray(versions) ? versions : [];
      setLoaderVersions(list);
      const preferred = (targetLoader === currentLoader && instance.loaderVersion && list.some((v) => v.id === instance.loaderVersion))
        ? instance.loaderVersion
        : (list.find((v) => v.recommended) ?? list.find((v) => v.stable) ?? list[0])?.id ?? "";
      setTargetLoaderVersion(preferred);
    }).catch(() => {
      if (loaderGen.current === request) setLoaderFailed(true);
    }).finally(() => {
      if (loaderGen.current === request) setLoaderLoading(false);
    });
    return () => { ++loaderGen.current; };
  }, [baseGameVersion, currentLoader, instance.loaderVersion, loaderAttempt, targetLoader]);

  const loaderUnchanged = targetLoader === currentLoader
    && (targetLoader === "vanilla" || targetLoaderVersion === (instance.loaderVersion ?? ""));
  const canApplyLoader = Boolean(
    baseGameVersion
    && targetLoader !== "optifine"
    && !loaderUnchanged
    && !busy
    && (targetLoader === "vanilla" || (!loaderLoading && !loaderFailed && targetLoaderVersion)),
  );

  const loaderNames: Record<Loader, string> = {
    vanilla: t("library:vanilla"),
    fabric: "Fabric",
    quilt: "Quilt",
    forge: "Forge",
    neoforge: "NeoForge",
    optifine: "OptiFine",
  };

  // A refused pre-switch backup names its reason. The user may then switch
  // without one, after a second confirmation that says what is at risk.
  const withBackupChoice = async <T,>(attempt: (skipBackup: boolean) => Promise<T>): Promise<T> => {
    try {
      return await attempt(false);
    } catch (error) {
      const refused = normalizeError(error);
      if (!refused.code.startsWith("loader.switchBackup")) throw error;
      const reason = errorText(refused.code, t, refused.params);
      if (!await confirm(t("library:loaderChange.skipBackupConfirm", { reason }), { tone: "danger" })) throw error;
      return attempt(true);
    }
  };

  // The backend takes the Minecraft version from the JAR and refuses one for
  // another version than this instance's.
  const importOptifineForInstance = async () => {
    if (busy || !baseGameVersion) return;
    if (currentLoader !== "optifine" && !await confirm(t("library:loaderChange.confirm", {
      name: instance.name,
      loader: loaderNames.optifine,
    }), { tone: "danger" })) {
      return;
    }
    void run("instance.loader", async () => {
      const path = await pickLauncherPath("optifineInstaller");
      if (!path) return;
      const result = await withBackupChoice((skipBackup) => command<LoaderResult>("install_optifine_installer", {
        path,
        instanceId: instance.id,
        skipBackup,
      }));
      setNotice(result?.backupId ? "loaderChangedBackup" : "loaderChanged");
      await onChanged();
    });
  };

  const applyLoaderChange = async () => {
    if (!canApplyLoader) return;
    if (targetLoader !== currentLoader && !await confirm(t("library:loaderChange.confirm", {
      name: instance.name,
      loader: loaderNames[targetLoader],
    }), { tone: "danger" })) {
      return;
    }
    void run("instance.loader", async () => {
      const result = await withBackupChoice((skipBackup) => command<Instance & { backupId?: string | null }>("change_instance_loader", {
        instanceId: instance.id,
        loader: targetLoader,
        loaderVersion: targetLoader === "vanilla" ? null : targetLoaderVersion,
        skipBackup,
      }));
      setNotice(result?.backupId ? "loaderChangedBackup" : "loaderChanged");
      await onChanged();
    });
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run("instance.settings", async () => {
      await command("update_instance", {
        instanceId: instance.id,
        name,
        category,
        notes,
        iconPath,
        memoryMode,
        minMemoryMb: minMemoryMb ? Number(minMemoryMb) : null,
        clearMinMemory: !minMemoryMb,
        maxMemoryMb: maxMemoryMb ? Number(maxMemoryMb) : null,
        javaPath,
        jvmArguments,
        gameProxyMode,
        screenWidth: screenWidth ? Number(screenWidth) : null,
        screenHeight: screenHeight ? Number(screenHeight) : null,
      });
      setNotice("settingsSaved");
      await onChanged();
    });
  };
  const resetRuntime = () => void run("instance.resetRuntime", async () => {
    await command("update_instance", { instanceId: instance.id, resetRuntime: true });
    setMaxMemoryMb("");
    setMemoryMode("inherit");
    setMinMemoryMb("");
    setJavaPath("");
    setJvmArguments("");
    setGameProxyMode("default");
    setScreenWidth("");
    setScreenHeight("");
    setNotice("runtimeReset");
    await onChanged();
  });

  return (
    <form className="vx-detail-stack" onSubmit={save}>
      <section className="vx-detail-section">
        <h2>{t("library:instanceInfo")}</h2>
        <div className="vx-form-two-columns">
          <Field label={t("library:instanceName")} htmlFor="instance-name"><input id="instance-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t("library:category")} htmlFor="instance-category"><input id="instance-category" value={category} onChange={(event) => setCategory(event.target.value)} /></Field>
        </div>
        <Field label={t("library:notes")} htmlFor="instance-notes"><textarea id="instance-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></Field>
        <div className="vx-action-row">
          <Button variant="secondary" onClick={() => void run("instance.settings", () => pickLauncherPath("instanceIcon").then((path) => { if (typeof path === "string") setIconPath(path); }))}>{t("library:chooseIcon")}</Button>
          {iconPath ? <small className="vx-path">{iconPath}</small> : null}
        </div>
      </section>
      <section className="vx-detail-section" aria-labelledby="instance-loader-heading">
        <h2 id="instance-loader-heading">{t("library:loaderChange.title")}</h2>
        <p>{t("library:loaderChange.current", {
          version: baseGameVersion || instance.versionId,
          loader: loaderNames[currentLoader],
          loaderVersion: instance.loaderVersion ? ` ${instance.loaderVersion}` : "",
        })}</p>
        <Segmented
          semantic="toggle"
          label={t("library:loader")}
          value={targetLoader}
          onChange={setTargetLoader}
          options={(["vanilla", "fabric", "quilt", "forge", "neoforge", "optifine"] as const).map((value) => ({
            value,
            label: loaderNames[value],
          }))}
        />
        {targetLoader === "optifine" ? <OptifineManualHint /> : null}
        {targetLoader !== "vanilla" && targetLoader !== "optifine" ? (
          <Field label={t("library:loaderVersion")} htmlFor="instance-loader-version">
            {loaderFailed ? (
              <div className="vx-action-row">
                <span>{t("library:createMetadata.failedLoader", { loader: loaderNames[targetLoader] })}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => retryLoader((n) => n + 1)}>{t("common:actions.retry")}</Button>
              </div>
            ) : (
              <Select
                id="instance-loader-version"
                aria-label={t("library:loaderVersion")}
                value={targetLoaderVersion}
                onChange={setTargetLoaderVersion}
                disabled={loaderLoading || loaderVersions.length === 0}
                options={loaderVersions.length > 0
                  ? loaderVersions.map((item) => ({
                    value: item.id,
                    label: item.id,
                    metadata: item.recommended ? t("library:recommended") : undefined,
                  }))
                  : [{ value: "", label: loaderLoading ? t("common:status.loading") : t("library:noLoaderVersions") }]}
              />
            )}
          </Field>
        ) : null}
        <p>{t("library:loaderChange.hint")}</p>
        <div className="vx-action-row">
          {targetLoader === "optifine" ? (
            <Button type="button" variant="secondary" disabled={Boolean(busy) || !baseGameVersion} loading={busy === "instance.loader"} onClick={importOptifineForInstance}>
              {t("library:optifineImportJar")}
            </Button>
          ) : (
            <Button type="button" variant="secondary" disabled={!canApplyLoader} loading={busy === "instance.loader"} onClick={applyLoaderChange}>
              {t("library:loaderChange.apply")}
            </Button>
          )}
        </div>
      </section>
      <section className="vx-detail-section">
        <div className="vx-section-heading">
          <h2>{t("library:runtimeOverrides")}</h2>
          <Button variant="ghost" onClick={resetRuntime}>{t("library:resetRuntime")}</Button>
        </div>
        <Segmented semantic="toggle" label={t("settings:memory.mode")} value={memoryMode}
          options={[
            { value: "inherit", label: t("settings:memory.inherit") },
            { value: "auto", label: t("settings:memory.auto") },
            { value: "manual", label: t("settings:memory.manual") },
          ]} onChange={setMemoryMode} />
        <MemoryOverviewHint instanceId={instance.id} />
        <div className="vx-form-two-columns">
          <Field label={t("library:maxMemory")} htmlFor="instance-memory"><input id="instance-memory" type="number" min={512} max={65536} disabled={memoryMode !== "manual"} placeholder={maxMemoryPlaceholder} value={maxMemoryMb} onChange={(event) => setMaxMemoryMb(event.target.value)} /></Field>
          <Field label={t("settings:memory.initial")} htmlFor="instance-min-memory"><input id="instance-min-memory" type="number" min={256} max={65536} placeholder={inherited(config?.minMemoryMb)} value={minMemoryMb} onChange={(event) => setMinMemoryMb(event.target.value)} /></Field>
          <Field label={t("library:windowWidth")} htmlFor="instance-width"><input id="instance-width" type="number" min={320} max={16384} placeholder={inherited(config?.screenWidth)} value={screenWidth} onChange={(event) => setScreenWidth(event.target.value)} /></Field>
          <Field label={t("library:windowHeight")} htmlFor="instance-height"><input id="instance-height" type="number" min={240} max={16384} placeholder={inherited(config?.screenHeight)} value={screenHeight} onChange={(event) => setScreenHeight(event.target.value)} /></Field>
        </div>
        <Field label={t("library:javaPath")} htmlFor="instance-java">
          <div className="vx-detail-input-action">
            <input id="instance-java" placeholder={inherited(config?.javaPath)} value={javaPath} onChange={(event) => setJavaPath(event.target.value)} />
            <Button variant="secondary" onClick={() => void run("instance.settings", () => pickLauncherPath("java").then((path) => { if (typeof path === "string") setJavaPath(path); }))}>{t("library:chooseJava")}</Button>
          </div>
        </Field>
        <Field label={t("library:jvmArguments")} htmlFor="instance-jvm"><input id="instance-jvm" placeholder={inherited(config?.jvmArguments)} value={jvmArguments} onChange={(event) => setJvmArguments(event.target.value)} /></Field>
        <Field label={t("settings:proxy.gameMode")} htmlFor="instance-game-proxy">
          <Select id="instance-game-proxy" aria-label={t("settings:proxy.gameMode")} value={gameProxyMode} onChange={setGameProxyMode}
            options={["default", "system", "off", "launcher"].map((value) => ({ value, label: t(`settings:proxy.gameModes.${value}`) }))} />
        </Field>
      </section>
      {notice ? <p className="vx-inline-notice">{t(`library:notice.${notice}`)}</p> : null}
      {/* One right-aligned save action that stays in reach, with discard and an unsaved mark. */}
      <div className="vx-detail-savebar">
        <span className="vx-detail-savebar__status" role="status">{dirty ? t("library:unsavedChanges") : ""}</span>
        <Button variant="ghost" disabled={!dirty} onClick={discard}>{t("library:discardChanges")}</Button>
        <Button variant="primary" type="submit">{t("common:actions.save")}</Button>
      </div>
    </form>
  );
}
