// SPDX-License-Identifier: GPL-3.0-only
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "../../../src/components/ui/Button";
import type { DetectedInstall } from "../setupApi";

export interface OptionsStepProps {
  version: string;
  detected: DetectedInstall;
  installDir: string;
  createShortcuts: boolean;
  launchAfterInstall: boolean;
  launchAvailable: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onChangeShortcuts: (value: boolean) => void;
  onChangeLaunchAfterInstall: (value: boolean) => void;
  onBack: () => void;
  onInstall: () => void;
}

export function OptionsStep({
  version,
  detected,
  installDir,
  createShortcuts,
  launchAfterInstall,
  launchAvailable,
  headingRef,
  onChangeShortcuts,
  onChangeLaunchAfterInstall,
  onBack,
  onInstall,
}: OptionsStepProps) {
  const { t } = useTranslation("setup");
  const { relation } = detected;
  // Only an in-place update keeps the existing shortcuts. A registration whose
  // folder no longer holds the launcher installs into a new folder, so the user
  // decides about shortcuts as for a fresh installation.
  const keepsShortcuts = relation.kind === "update" && detected.pathLocked;

  const installLabel =
    relation.kind === "update"
      ? t("actions.update")
      : relation.kind === "reinstall"
        ? t("actions.reinstall")
        : t("actions.install");

  const summaryAction =
    relation.kind === "update"
      ? t("options.summaryActionUpdate", {
          from: relation.installedVersion,
          to: relation.targetVersion,
        })
      : relation.kind === "reinstall"
        ? t("options.summaryActionReinstall", { version: relation.version })
        : t("options.summaryActionInstall", { version });

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("options.title")}
          </h1>
        </div>
        <p className="vx-setup-lead">{t("options.description")}</p>

        <div className="vx-setup-options">
          <label className="vx-setup-option" data-disabled={keepsShortcuts}>
            <input
              type="checkbox"
              checked={createShortcuts}
              disabled={keepsShortcuts}
              onChange={(event) => onChangeShortcuts(event.target.checked)}
            />
            <span className="vx-setup-option__copy">
              <strong>{t("options.shortcutsTitle")}</strong>
              <span>
                {keepsShortcuts ? t("options.shortcutsUpdateHint") : t("options.shortcutsHint")}
              </span>
            </span>
          </label>

          <label className="vx-setup-option" data-disabled={!launchAvailable}>
            <input
              type="checkbox"
              checked={launchAvailable && launchAfterInstall}
              disabled={!launchAvailable}
              onChange={(event) => onChangeLaunchAfterInstall(event.target.checked)}
            />
            <span className="vx-setup-option__copy">
              <strong>{t("options.launchTitle")}</strong>
              <span>
                {launchAvailable
                  ? t("options.launchHint")
                  : t("options.launchElevatedHint")}
              </span>
            </span>
          </label>
        </div>

        <div className="vx-setup-summary" aria-label={t("options.summaryLabel")}>
          <span>{summaryAction}</span>
          <span>
            {t("options.summaryTarget", { path: "" })}
            <code>{installDir}</code>
          </span>
        </div>
      </div>

      <div className="vx-setup-actions">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t("actions.back")}
        </Button>
        <div className="vx-setup-actions__group">
          <Button
            variant="primary"
            icon={<Download size={16} />}
            onClick={onInstall}
          >
            {installLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
