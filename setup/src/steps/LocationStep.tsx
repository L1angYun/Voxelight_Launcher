// SPDX-License-Identifier: GPL-3.0-only
import { useId, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, ArrowLeft, ArrowRight, FolderOpen } from "lucide-react";
import { Button } from "../../../src/components/ui/Button";
import { formatBytes } from "../formatBytes";
import type { DetectedInstall, PathValidation } from "../setupApi";

export interface LocationStepProps {
  detected: DetectedInstall;
  installDir: string;
  validation: PathValidation;
  checking: boolean;
  /** "opening" while the classic installer starts, "failed" if it could not. */
  classicInstaller: "idle" | "opening" | "failed";
  headingRef: RefObject<HTMLHeadingElement | null>;
  onChangePath: (value: string) => void;
  onBrowse: () => void;
  onOpenClassicInstaller: () => void;
  onBack: () => void;
  onNext: () => void;
}

const PATH_ERROR_KEYS = {
  "path.empty": "pathErrors.empty",
  "path.invalidChars": "pathErrors.invalidChars",
  "path.notAbsolute": "pathErrors.notAbsolute",
  "path.driveRoot": "pathErrors.driveRoot",
  "path.protectedLocation": "pathErrors.protectedLocation",
  "path.sharedLocation": "pathErrors.sharedLocation",
  "path.reparsePoint": "pathErrors.reparsePoint",
  "path.isFile": "pathErrors.isFile",
  "path.driveMissing": "pathErrors.driveMissing",
  "path.notWritable": "pathErrors.notWritable",
  "path.insufficientSpace": "pathErrors.insufficientSpace",
} as const;

export function LocationStep({
  detected,
  installDir,
  validation,
  checking,
  classicInstaller,
  headingRef,
  onChangePath,
  onBrowse,
  onOpenClassicInstaller,
  onBack,
  onNext,
}: LocationStepProps) {
  const { t } = useTranslation("setup");
  const inputId = useId();
  const feedbackId = useId();

  const { relation } = detected;
  const downgradeBlocked = relation.kind === "downgradeBlocked";
  // Only a folder that still holds the launcher is kept. A registered folder
  // whose launcher is gone (deleted, or on a drive that is not connected) is
  // only a suggestion, so the user can pick another one.
  const pathLocked = detected.pathLocked || downgradeBlocked;
  const canContinue = !downgradeBlocked && !checking && validation.valid;
  // The kept folder can no longer be used (ProgramData, a drive root, a
  // junction, ...). Installing elsewhere silently would leave the old copy
  // behind, so offer the classic installer, which can remove it first.
  const keptFolderUnusable =
    detected.pathLocked && !downgradeBlocked && !checking && !validation.valid;

  const errorKey = validation.errorCode && validation.errorCode in PATH_ERROR_KEYS
    ? PATH_ERROR_KEYS[validation.errorCode as keyof typeof PATH_ERROR_KEYS]
    : null;

  const errorMessage = errorKey
    ? t(errorKey, {
        required: formatBytes(validation.requiredBytes),
        available: formatBytes(validation.availableBytes ?? 0),
      })
    : null;

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("location.title")}
          </h1>
        </div>
        <p className="vx-setup-lead">{t("location.description")}</p>

        {relation.kind === "update" ? (
          <div className="vx-setup-banner">
            <strong>
              {t("location.modeUpdateTitle", {
                from: relation.installedVersion,
                to: relation.targetVersion,
              })}
            </strong>
            <p>
              {detected.pathLocked
                ? t("location.modeUpdateHint")
                : t("location.modeFolderMissingHint")}
            </p>
          </div>
        ) : null}

        {relation.kind === "reinstall" ? (
          <div className="vx-setup-banner">
            <strong>{t("location.modeReinstallTitle", { version: relation.version })}</strong>
            <p>
              {detected.pathLocked
                ? t("location.modeReinstallHint")
                : t("location.modeFolderMissingHint")}
            </p>
          </div>
        ) : null}

        {relation.kind === "downgradeBlocked" ? (
          <div className="vx-setup-banner vx-setup-banner--danger" role="alert">
            <strong>
              {t("location.modeDowngradeTitle", { installed: relation.installedVersion })}
            </strong>
            <p>
              {t("location.modeDowngradeHint", {
                installed: relation.installedVersion,
                target: relation.targetVersion,
              })}
            </p>
          </div>
        ) : null}

        <div className="vx-field">
          <label htmlFor={inputId}>{t("location.fieldLabel")}</label>
          <div className="vx-setup-path-row">
            <input
              id={inputId}
              type="text"
              value={installDir}
              readOnly={pathLocked}
              aria-invalid={!validation.valid || downgradeBlocked}
              aria-describedby={feedbackId}
              placeholder={t("location.placeholder")}
              onChange={(event) => onChangePath(event.target.value)}
            />
            <Button
              variant="secondary"
              icon={<FolderOpen size={15} />}
              disabled={pathLocked}
              onClick={onBrowse}
            >
              {t("actions.browse")}
            </Button>
          </div>

          <div id={feedbackId}>
            {checking ? (
              <p className="vx-setup-meta">{t("location.checking")}</p>
            ) : errorMessage ? (
              <p className="vx-setup-error-text" role="alert">
                {errorMessage}
              </p>
            ) : (
              <p className="vx-setup-meta">
                {validation.availableBytes !== null
                  ? t("location.spaceSummary", {
                      required: formatBytes(validation.requiredBytes),
                      available: formatBytes(validation.availableBytes),
                    })
                  : t("location.spaceRequiredOnly", {
                      required: formatBytes(validation.requiredBytes),
                    })}
              </p>
            )}
            {keptFolderUnusable ? (
              <p className="vx-setup-meta">{t("location.keptFolderUnusableHint")}</p>
            ) : null}
            {keptFolderUnusable && classicInstaller === "failed" ? (
              <p className="vx-setup-error-text" role="alert">
                {t("location.classicInstallerFailed")}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="vx-setup-actions">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t("actions.back")}
        </Button>
        <div className="vx-setup-actions__group">
          {keptFolderUnusable ? (
            <Button
              variant="secondary"
              icon={<AppWindow size={15} />}
              disabled={classicInstaller === "opening"}
              onClick={onOpenClassicInstaller}
            >
              {t("actions.classicInstaller")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={<ArrowRight size={16} />}
            disabled={!canContinue}
            onClick={onNext}
          >
            {t("actions.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
