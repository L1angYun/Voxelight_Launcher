import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Image, RotateCcw, Upload, UserRound } from "lucide-react";
import { command, type Account, type Config } from "../../lib/launcher";
import type { useAccountSkin } from "../../lib/accountSkin";
import { useDefaultSkin, type DefaultSkinId } from "../../lib/defaultSkin";
import { useAppearance } from "../../app/AppearanceProvider";
import type { PlayerProfile } from "../../lib/playerProfile";
import { CharacterCanvas, type CharacterAnimation } from "../../visual/character/CharacterCanvas";
import type { SkinModel } from "../../components/skinTexture";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { accountErrorCodeText, accountErrorText } from "./utils";

const defaultChoices: DefaultSkinId[] = ["steve", "alex"];

export function AppearancePanel({
  account,
  appearance,
  config,
  versionId,
  onChanged,
}: {
  account?: Account;
  appearance: ReturnType<typeof useAccountSkin>;
  config: Config;
  versionId?: string;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { reducedMotion } = useAppearance();
  const online = account?.type === "microsoft" || account?.type === "authlib";
  const editable = account?.type === "microsoft";
  const [previewMode, setPreviewMode] = useState<"account" | "local">(online ? "account" : "local");
  const [localSource, setLocalSource] = useState<{ url: string; label: string } | null>(null);
  const [localModel, setLocalModel] = useState<SkinModel>("auto");
  const [uploadModel, setUploadModel] = useState<"classic" | "slim">(appearance.model === "slim" ? "slim" : "classic");
  const [animation, setAnimation] = useState<CharacterAnimation>("idle");
  const [rotating, setRotating] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const localUrl = useRef<string | null>(null);
  const localFile = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const clearLocal = useCallback(() => {
    if (localUrl.current) {
      URL.revokeObjectURL(localUrl.current);
      localUrl.current = null;
    }
    setLocalSource(null);
  }, []);

  useEffect(() => () => {
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
  }, []);

  useEffect(() => {
    generation.current++;
    clearLocal();
    setPreviewMode(online ? "account" : "local");
    setUploadModel(account?.skinModel === "slim" ? "slim" : "classic");
    setError("");
    setNotice("");
    setBusy(false);
  }, [account?.id, account?.skinModel, online, clearLocal]);

  const { skin: defaultSkin, loading: defaultLoading, error: defaultError, refresh: refreshDefault } = useDefaultSkin(
    config.defaultSkin,
    versionId,
    previewMode === "local" && !localSource,
  );
  const currentSkin = previewMode === "account"
    ? appearance.skinUrl
    : localSource?.url ?? defaultSkin.dataUrl;
  const currentModel = previewMode === "account"
    ? appearance.model
    : localModel !== "auto"
      ? localModel
      : localSource
        ? "auto"
        : defaultSkin.model;
  const sourceName = previewMode === "account"
    ? account?.username ?? t("accounts:preview.account")
    : localSource?.label ?? defaultSkin.name;
  const profile = appearance.profile;
  const activeCape = profile?.capes.find((cape) => cape.state.toUpperCase() === "ACTIVE")?.id ?? "";
  const profileError = appearance.errorCode
    ? accountErrorCodeText(appearance.errorCode, t)
    : appearance.error
      ? accountErrorText(appearance.error, t)
      : "";

  function changeMode(mode: "account" | "local") {
    setPreviewMode(mode);
    setError("");
    setNotice("");
  }

  async function change(
    commandName: string,
    args: Record<string, unknown>,
    noticeKey: string,
  ) {
    if (!account || !editable) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await command<PlayerProfile>(commandName, { accountId: account.id, ...args });
      if (generation.current !== current) return;
      appearance.setProfile(value);
      setNotice(t(`accounts:notice.${noticeKey}`));
      await onChanged();
    } catch (cause) {
      if (generation.current === current) setError(accountErrorText(cause, t));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  async function upload() {
    if (!editable || busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: t("accounts:appearance.uploadPicker"),
        filters: [{ name: t("accounts:appearance.pngFilter"), extensions: ["png"] }],
      });
      if (generation.current !== current || typeof path !== "string") return;
      await change("upload_account_skin", { path, model: uploadModel }, "skinUpdated");
    } catch (cause) {
      if (generation.current === current) setError(accountErrorText(cause, t));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  function chooseLocal(url: string, label: string) {
    if (localUrl.current && localUrl.current !== url) URL.revokeObjectURL(localUrl.current);
    localUrl.current = url.startsWith("blob:") ? url : null;
    setLocalSource({ url, label });
    setPreviewMode("local");
    setError("");
    setNotice("");
  }

  function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if ((!/\.png$/i.test(file.name) && file.type !== "image/png") || file.size > 16 * 1024 * 1024) {
      setError(t("accounts:errors.preview.fileInvalid"));
      return;
    }
    chooseLocal(URL.createObjectURL(file), file.name);
  }

  function loadUrl() {
    try {
      const parsed = new URL(urlInput.trim());
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("invalid protocol");
      chooseLocal(parsed.href, t("accounts:preview.urlSource"));
    } catch {
      setError(t("accounts:errors.preview.urlInvalid"));
    }
  }

  async function changeDefault(id: DefaultSkinId) {
    if (busy || id === config.defaultSkin) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await command<Config>("save_config", { config: { ...config, defaultSkin: id } });
      clearLocal();
      await onChanged();
      setNotice(t("accounts:notice.defaultSaved"));
    } catch (cause) {
      setError(accountErrorText(cause, t));
    } finally {
      setBusy(false);
    }
  }

  const modeError = error || (previewMode === "account" ? profileError : defaultError ? accountErrorText(defaultError, t) : "");
  const errorBelowPreview = previewMode === "account" && !currentSkin ? error : modeError;

  return (
    <section className="vx-appearance-panel" aria-labelledby="appearance-panel-title">
      <header className="vx-account-section-heading">
        <h2 id="appearance-panel-title">{t("accounts:appearance.title")}</h2>
        <GlassSurface className="vx-appearance-mode" variant="control">
          <div role="tablist" aria-label={t("accounts:preview.source")} onKeyDown={(event) => {
            const next = event.key === "Home" ? (online ? "account" : "local") : event.key === "End" ? "local" : ["ArrowLeft", "ArrowRight"].includes(event.key) ? (online && previewMode === "local" ? "account" : "local") : undefined;
            if (next) { event.preventDefault(); changeMode(next); document.getElementById("appearance-tab-" + next)?.focus(); }
          }}>
            <button type="button" role="tab" id="appearance-tab-account" aria-controls="appearance-workspace" tabIndex={previewMode === "account" ? 0 : -1} aria-selected={previewMode === "account"} disabled={!online} onClick={() => changeMode("account")}>{t("accounts:preview.account")}</button>
            <button type="button" role="tab" id="appearance-tab-local" aria-controls="appearance-workspace" tabIndex={previewMode === "local" ? 0 : -1} aria-selected={previewMode === "local"} onClick={() => changeMode("local")}>{t("accounts:preview.local")}</button>
          </div>
        </GlassSurface>
      </header>
      <div className="vx-appearance-workspace" id="appearance-workspace" role="tabpanel" aria-labelledby={"appearance-tab-" + previewMode} data-preview-mode={previewMode}>
      <div className="vx-appearance-stage">
      <div className="vx-appearance-preview" role="region" aria-label={t(previewMode === "local" ? "accounts:preview.localNotice" : "accounts:preview.accountNotice")}>
        {currentSkin ? (
          <CharacterCanvas
            skinUrl={currentSkin}
            capeUrl={previewMode === "account" ? appearance.capeUrl : null}
            model={currentModel}
            interactive
            autoRotate={rotating && !reducedMotion}
            animation={reducedMotion ? "none" : animation}
            resetToken={resetToken}
            label={t("accounts:preview.canvasLabel")}
            retryLabel={t("accounts:actions.retryAppearance")}
            errorLabel={t("accounts:preview.unavailable")}
          />
        ) : (
          <div className="vx-appearance-placeholder" role="status">
            <UserRound size={42} strokeWidth={1.3} />
            <strong>{appearance.loading ? t("accounts:preview.loading") : t("accounts:preview.noAccountSkin")}</strong>
            {previewMode === "account" && profileError ? <p>{profileError}</p> : null}
            {previewMode === "account" && profileError ? (
              <Button variant="ghost" onClick={appearance.refresh}>{t("accounts:actions.retryAppearance")}</Button>
            ) : null}
          </div>
        )}
        <div className="vx-appearance-preview__source">
          <strong>{sourceName}</strong>
          <span>{previewMode === "local" ? t("accounts:preview.localNotice") : t("accounts:preview.accountNotice")}</span>
        </div>
      </div>

      {errorBelowPreview ? <p className="vx-appearance-error" role="alert">{errorBelowPreview}</p> : null}
      {notice ? <p className="vx-appearance-notice" role="status">{notice}</p> : null}
      </div>
      <div className="vx-appearance-wardrobe">
      {previewMode === "account" && online ? (
        <div className="vx-appearance-controls">
          <div className="vx-action-row">
            <Button variant="secondary" disabled={busy} onClick={appearance.refresh}>{t("accounts:appearance.refresh")}</Button>
          </div>
          {profile ? (
            <div className="vx-appearance-current">
              <strong>{profile.name}</strong>
              <span>{profile.skins.some((skin) => skin.state.toUpperCase() === "ACTIVE") ? t("accounts:appearance.customSkin") : t("accounts:appearance.defaultSkin")}</span>
            </div>
          ) : null}
          {editable ? (
            <>
              <label>
                {t("accounts:appearance.uploadModel")}
                <select aria-label={t("accounts:appearance.uploadModel")} value={uploadModel} disabled={busy} onChange={(event) => setUploadModel(event.target.value as "classic" | "slim")}>
                  <option value="classic">{t("accounts:model.classic")}</option>
                  <option value="slim">{t("accounts:model.slim")}</option>
                </select>
              </label>
              <div className="vx-action-row">
                <Button variant="primary" icon={<Upload size={15} />} loading={busy} onClick={() => void upload()}>{t("accounts:appearance.upload")}</Button>
                <Button variant="secondary" disabled={busy || !profile} onClick={() => void change("reset_account_skin", {}, "skinReset")}>{t("accounts:appearance.reset")}</Button>
              </div>
              {profile?.capes.length ? (
                <label>
                  {t("accounts:appearance.cape")}
                  <select
                    aria-label={t("accounts:appearance.cape")}
                    disabled={busy}
                    value={activeCape}
                    onChange={(event) => void change("select_account_cape", { capeId: event.target.value || null }, event.target.value ? "capeShown" : "capeHidden")}
                  >
                    <option value="">{t("accounts:appearance.noCape")}</option>
                    {profile.capes.map((cape) => <option key={cape.id} value={cape.id}>{cape.alias || cape.id}</option>)}
                  </select>
                </label>
              ) : <p className="vx-appearance-muted">{t("accounts:appearance.noCapes")}</p>}
            </>
          ) : <p className="vx-appearance-muted">{t("accounts:appearance.authlibReadonly")}</p>}
        </div>
      ) : null}

      {previewMode === "local" ? (
        <div className="vx-appearance-controls">
          <div className="vx-action-row">
            <Button variant="primary" icon={<Image size={15} />} onClick={() => localFile.current?.click()}>{t("accounts:preview.import")}</Button>
            <input ref={localFile} id="local-skin-file" className="sr-only" tabIndex={-1} aria-label={t("accounts:fields.importLocalPng")} type="file" accept="image/png,.png" onChange={importFile} />
            <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => setResetToken((value) => value + 1)}>{t("accounts:preview.resetView")}</Button>
            <Button variant="ghost" onClick={() => { clearLocal(); setLocalModel("auto"); }}>{t("accounts:preview.restoreDefault")}</Button>
          </div>
          <form
            className="vx-preview-url"
            onSubmit={(event) => {
              event.preventDefault();
              loadUrl();
            }}
          >
            <input aria-label={t("accounts:fields.onlineSkinUrl")} type="url" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="https://…/skin.png" />
            <Button variant="secondary" type="submit">{t("accounts:preview.loadUrl")}</Button>
          </form>
          <div className="vx-preview-control-grid">
            <label>
              {t("accounts:preview.model")}
              <select aria-label={t("accounts:preview.model")} value={localModel} onChange={(event) => setLocalModel(event.target.value as SkinModel)}>
                <option value="auto">{t("accounts:model.auto")}</option>
                <option value="classic">{t("accounts:model.classic")}</option>
                <option value="slim">{t("accounts:model.slim")}</option>
              </select>
            </label>
            <label>
              {t("accounts:preview.animation")}
              <select aria-label={t("accounts:preview.animation")} value={reducedMotion ? "none" : animation} disabled={reducedMotion} onChange={(event) => setAnimation(event.target.value as CharacterAnimation)}>
                {(["idle", "walk", "run", "none"] as const).map((mode) => <option key={mode} value={mode}>{t(`accounts:animation.${mode}`)}</option>)}
              </select>
            </label>
            <Button variant="secondary" aria-pressed={rotating && !reducedMotion} disabled={reducedMotion} onClick={() => setRotating((value) => !value)}>{t("accounts:preview.autoRotate")}</Button>
          </div>
          {reducedMotion ? <p className="vx-appearance-muted">{t("accounts:preview.reducedMotion")}</p> : null}

          <fieldset className="vx-default-skins" disabled={busy}>
            <legend>{t("accounts:default.title")}</legend>
            <p>{t("accounts:default.description")}</p>
            <div className="vx-default-skins__choices">
              {defaultChoices.map((id) => (
                <label key={id} data-selected={config.defaultSkin === id || undefined}>
                  <input type="radio" name="default-skin" aria-label={t(`accounts:default.${id}.name`)} checked={config.defaultSkin === id} onChange={() => void changeDefault(id)} />
                  <span><strong>{t(`accounts:default.${id}.name`)}</strong><small>{t(`accounts:default.${id}.description`)}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          {defaultLoading ? <p role="status">{t("common:status.loading")}</p> : null}
          {defaultError ? <Button variant="ghost" onClick={refreshDefault}>{t("accounts:actions.retryDefault")}</Button> : null}
          {defaultSkin.sourceVersion ? <p className="vx-appearance-muted">{t("accounts:default.sourceVersion", { version: defaultSkin.sourceVersion })}</p> : null}
          {defaultSkin.isFallback ? <p className="vx-appearance-muted">{t("accounts:default.fallback")}</p> : null}
        </div>
      ) : null}
      </div>
      </div>
    </section>
  );
}
