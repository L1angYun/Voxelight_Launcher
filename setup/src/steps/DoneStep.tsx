// SPDX-License-Identifier: GPL-3.0-only
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, Play } from "lucide-react";
import { Button } from "../../../src/components/ui/Button";

export interface DoneStepProps {
  version: string;
  installedDir: string;
  launching: boolean;
  launchFailed: boolean;
  launchAvailable: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onLaunch: () => void;
  onClose: () => void;
}

export function DoneStep({
  version,
  installedDir,
  launching,
  launchFailed,
  launchAvailable,
  headingRef,
  onLaunch,
  onClose,
}: DoneStepProps) {
  const { t } = useTranslation("setup");

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-done-emblem" aria-hidden="true">
          <Check size={22} strokeWidth={2.2} />
        </div>
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("done.title")}
          </h1>
        </div>
        <p className="vx-setup-lead">{t("done.description", { version })}</p>

        <div className="vx-setup-summary">
          <span>
            {t("done.installedAt", { path: "" })}
            <code>{installedDir}</code>
          </span>
        </div>

        {launching ? (
          <p className="vx-setup-meta" aria-live="polite">
            {t("done.launchingNote")}
          </p>
        ) : null}

        {launchFailed ? (
          <p className="vx-setup-error-text" role="alert">
            {t("done.launchFailed")}
          </p>
        ) : null}

        {!launchAvailable ? (
          <p className="vx-setup-meta">{t("done.launchBlockedElevated")}</p>
        ) : null}
      </div>

      <div className="vx-setup-actions">
        <Button variant="secondary" onClick={onClose}>
          {t("actions.close")}
        </Button>
        {launchAvailable ? (
          <div className="vx-setup-actions__group">
            <Button
              variant="primary"
              icon={<Play size={15} />}
              onClick={onLaunch}
            >
              {t("actions.launch")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
