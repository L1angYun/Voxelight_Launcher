// SPDX-License-Identifier: GPL-3.0-only
import { useTranslation } from "react-i18next";

export interface StepIndicatorProps {
  currentIndex: number;
  totalSteps: number;
  complete?: boolean;
}

export function StepIndicator({
  currentIndex,
  totalSteps,
  complete = false,
}: StepIndicatorProps) {
  const { t } = useTranslation("setup");
  return (
    <div className="vx-setup-head">
      <div className="vx-setup-head__row">
        <div className="vx-setup-brand">
          <span className="vx-setup-brand__dot" aria-hidden="true" />
          <span className="vx-setup-brand__wordmark">{t("app.wordmark")}</span>
        </div>
        {!complete ? (
          <span className="vx-setup-head__count">
            {t("app.stepCount", { current: currentIndex + 1, total: totalSteps })}
          </span>
        ) : null}
      </div>
      <div className="vx-setup-rail" aria-hidden="true">
        {Array.from({ length: totalSteps }, (_, index) => {
          const state = complete || index < currentIndex
            ? "done"
            : index === currentIndex
              ? "active"
              : "pending";
          return (
            <span
              key={index}
              className="vx-setup-rail__segment"
              data-state={state}
            />
          );
        })}
      </div>
    </div>
  );
}
