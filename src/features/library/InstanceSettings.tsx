import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { command, type Instance } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";

export function InstanceSettings({ instance, onChanged }: { instance: Instance; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const { run } = useLauncher();
  const [name, setName] = useState(instance.name);
  const [category, setCategory] = useState(instance.category);
  const [notes, setNotes] = useState(instance.notes);
  const [iconPath, setIconPath] = useState(instance.iconPath ?? "");
  const [maxMemoryMb, setMaxMemoryMb] = useState(instance.maxMemoryMb?.toString() ?? "");
  const [javaPath, setJavaPath] = useState(instance.javaPath ?? "");
  const [jvmArguments, setJvmArguments] = useState(instance.jvmArguments ?? "");
  const [screenWidth, setScreenWidth] = useState(instance.screenWidth?.toString() ?? "");
  const [screenHeight, setScreenHeight] = useState(instance.screenHeight?.toString() ?? "");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setName(instance.name);
    setCategory(instance.category);
    setNotes(instance.notes);
    setIconPath(instance.iconPath ?? "");
    setMaxMemoryMb(instance.maxMemoryMb?.toString() ?? "");
    setJavaPath(instance.javaPath ?? "");
    setJvmArguments(instance.jvmArguments ?? "");
    setScreenWidth(instance.screenWidth?.toString() ?? "");
    setScreenHeight(instance.screenHeight?.toString() ?? "");
  }, [instance]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run("instance.settings", async () => {
      await command("update_instance", {
        instanceId: instance.id,
        name,
        category,
        notes,
        iconPath,
        maxMemoryMb: maxMemoryMb ? Number(maxMemoryMb) : null,
        javaPath,
        jvmArguments,
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
    setJavaPath("");
    setJvmArguments("");
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
          <Button variant="secondary" onClick={() => void open({ title: t("library:chooseIcon"), multiple: false, filters: [{ name: t("library:imageFileType"), extensions: ["png", "jpg", "jpeg", "webp", "ico"] }] }).then((path) => { if (typeof path === "string") setIconPath(path); })}>{t("library:chooseIcon")}</Button>
          {iconPath ? <small className="vx-path">{iconPath}</small> : null}
        </div>
      </section>
      <section className="vx-detail-section">
        <h2>{t("library:runtimeOverrides")}</h2>
        <div className="vx-form-two-columns">
          <Field label={t("library:maxMemory")} htmlFor="instance-memory"><input id="instance-memory" type="number" min={512} max={65536} value={maxMemoryMb} onChange={(event) => setMaxMemoryMb(event.target.value)} /></Field>
          <Field label={t("library:javaPath")} htmlFor="instance-java"><input id="instance-java" value={javaPath} onChange={(event) => setJavaPath(event.target.value)} /></Field>
          <Field label={t("library:windowWidth")} htmlFor="instance-width"><input id="instance-width" type="number" min={320} max={16384} value={screenWidth} onChange={(event) => setScreenWidth(event.target.value)} /></Field>
          <Field label={t("library:windowHeight")} htmlFor="instance-height"><input id="instance-height" type="number" min={240} max={16384} value={screenHeight} onChange={(event) => setScreenHeight(event.target.value)} /></Field>
        </div>
        <Field label={t("library:jvmArguments")} htmlFor="instance-jvm"><input id="instance-jvm" value={jvmArguments} onChange={(event) => setJvmArguments(event.target.value)} /></Field>
        <div className="vx-action-row">
          <Button variant="secondary" onClick={() => void open({ title: t("library:chooseJava"), multiple: false, filters: [{ name: t("library:javaFileType"), extensions: ["exe"] }] }).then((path) => { if (typeof path === "string") setJavaPath(path); })}>{t("library:chooseJava")}</Button>
          <Button variant="ghost" onClick={resetRuntime}>{t("library:resetRuntime")}</Button>
        </div>
      </section>
      {notice ? <p className="vx-inline-notice">{t(`library:notice.${notice}`)}</p> : null}
      <Button variant="primary" type="submit">{t("common:actions.save")}</Button>
    </form>
  );
}
