// SPDX-License-Identifier: GPL-3.0-only
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { LatticeProgress } from "../../../src/visual/lattice/LatticeProgress";
import { formatBytes } from "../formatBytes";
import type { InstallPhase, InstallProgress } from "../setupApi";

export interface InstallingStepProps {
  progress: InstallProgress;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

const PHASES: readonly InstallPhase[] = ["extract", "install", "verify"];

export function InstallingStep({ progress, headingRef }: InstallingStepProps) {
  const { t } = useTranslation("setup");
  const activeIndex = Math.max(0, PHASES.indexOf(progress.phase));

  const statusText =
    progress.phase === "extract"
      ? t("installing.status.extract")
      : progress.phase === "verify"
        ? t("installing.status.verify")
        : progress.indeterminate
          ? t("installing.status.installOverwrite")
          : t("installing.status.install");

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("installing.title")}
          </h1>
        </div>
        <p className="vx-setup-lead">{t("installing.subtitle")}</p>

        <div className="vx-setup-phases" role="list">
          {PHASES.map((phase, index) => {
            const state =
              index < activeIndex
                ? "done"
                : index === activeIndex
                  ? "active"
                  : "pending";
            return (
              <div
                key={phase}
                role="listitem"
                className="vx-setup-phase"
                data-state={state}
                aria-current={state === "active" ? "step" : undefined}
              >
                {state === "done" ? (
                  <Check size={14} aria-hidden="true" />
                ) : state === "active" ? (
                  <LoaderCircle size={14} aria-hidden="true" />
                ) : (
                  <Circle size={12} aria-hidden="true" />
                )}
                <span>{t(`installing.phases.${phase}`)}</span>
              </div>
            );
          })}
        </div>

        <div className="vx-setup-progress-box">
          <LatticeProgress
            completed={progress.indeterminate ? 0 : progress.completed}
            total={progress.indeterminate ? 0 : progress.total}
            status={progress.indeterminate ? "unknown" : "active"}
            label={t("installing.progressLabel")}
            unit="bytes"
          />
          <div className="vx-setup-progress-box__meta" aria-live="polite">
            <span>{statusText}</span>
            {!progress.indeterminate && progress.expectedBytes > 0 && progress.phase === "install" ? (
              <span>
                {t("installing.bytesWritten", {
                  written: formatBytes(progress.bytesWritten),
                  expected: formatBytes(progress.expectedBytes),
                })}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="vx-setup-actions">
        <span />
      </div>
    </div>
  );
}
