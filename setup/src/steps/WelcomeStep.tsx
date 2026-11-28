// SPDX-License-Identifier: GPL-3.0-only
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Scale } from "lucide-react";
import { Button } from "../../../src/components/ui/Button";
import type { DetectedInstall } from "../setupApi";

export interface WelcomeStepProps {
  version: string;
  detected: DetectedInstall;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpenLicense: () => void;
  onNext: () => void;
}

export function WelcomeStep({
  version,
  detected,
  headingRef,
  onOpenLicense,
  onNext,
}: WelcomeStepProps) {
  const { t } = useTranslation("setup");
  const { relation } = detected;

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("welcome.title")}
          </h1>
          <span className="vx-setup-badge">{t("welcome.version", { version })}</span>
        </div>

        <p className="vx-setup-lead">{t("welcome.summary")}</p>

        <div className="vx-setup-note">{t("welcome.perUserNote")}</div>

        {relation.kind === "update" ? (
          <div className="vx-setup-banner">
            <p>
              <strong>{t("app.productName")}</strong>{" "}
              {t("welcome.updateNotice", {
                installed: relation.installedVersion,
                target: relation.targetVersion,
              })}
            </p>
          </div>
        ) : null}

        {relation.kind === "reinstall" ? (
          <div className="vx-setup-banner">
            <p>
              <strong>{t("app.productName")}</strong>{" "}
              {t("welcome.reinstallNotice", { version: relation.version })}
            </p>
          </div>
        ) : null}

        {relation.kind === "downgradeBlocked" ? (
          <div className="vx-setup-banner vx-setup-banner--danger" role="alert">
            <strong>{t("location.modeDowngradeTitle", { installed: relation.installedVersion })}</strong>
            <p>{t("welcome.downgradeNotice", { installed: relation.installedVersion })}</p>
          </div>
        ) : null}

        <div className="vx-setup-license-row">
          <p>{t("welcome.licenseLead")}</p>
          <button
            type="button"
            className="vx-setup-link"
            onClick={onOpenLicense}
          >
            <Scale size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: "4px" }} />
            {t("actions.viewLicense")}
          </button>
        </div>
      </div>

      <div className="vx-setup-actions">
        <span />
        <div className="vx-setup-actions__group">
          <Button
            variant="primary"
            icon={<ArrowRight size={16} />}
            onClick={onNext}
          >
            {t("actions.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
