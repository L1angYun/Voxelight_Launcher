// SPDX-License-Identifier: GPL-3.0-only
import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, Copy, RotateCcw } from "lucide-react";
import { Button } from "../../../src/components/ui/Button";
import type { InstallFailure } from "../setupApi";

export interface ErrorStepProps {
  version: string;
  installDir: string;
  failure: InstallFailure;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onRetry: () => void;
}

const FAILURE_REASON_KEYS = {
  nsisExit1: "error.reasons.nsisExit1",
  nsisExit2: "error.reasons.nsisExit2",
  nsisExit5: "error.reasons.nsisExit5",
  nsisExit112: "error.reasons.nsisExit112",
  nsisExit1223: "error.reasons.nsisExit1223",
  nsisExit1602: "error.reasons.nsisExit1602",
  nsisExit1618: "error.reasons.nsisExit1618",
  nsisExitOther: "error.reasons.nsisExitOther",
  hashMismatch: "error.reasons.hashMismatch",
  extractFailed: "error.reasons.extractFailed",
  spawnFailed: "error.reasons.spawnFailed",
  verifyFailed: "error.reasons.verifyFailed",
  downgradeBlocked: "error.reasons.downgradeBlocked",
  alreadyInstalling: "error.reasons.alreadyInstalling",
  launcherRunning: "error.reasons.launcherRunning",
} as const;

export function ErrorStep({
  version,
  installDir,
  failure,
  headingRef,
  onBack,
  onRetry,
}: ErrorStepProps) {
  const { t } = useTranslation("setup");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const reasonKey =
    failure.code in FAILURE_REASON_KEYS
      ? FAILURE_REASON_KEYS[failure.code as keyof typeof FAILURE_REASON_KEYS]
      : "error.reasons.nsisExitOther";

  const reasonText = t(reasonKey, {
    code: failure.exitCode ?? failure.code,
  });

  const detailLines = [
    t("error.detailVersion", { value: version }),
    t("error.detailTarget", { value: installDir }),
    t("error.detailPhase", { value: failure.phase }),
    t("error.detailExitCode", {
      value: failure.exitCode !== null ? String(failure.exitCode) : t("error.detailNone"),
    }),
    t("error.detailCode", { value: failure.code }),
  ];

  async function handleCopy() {
    const payload = [...detailLines, failure.detail].filter(Boolean).join("\n");
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        setCopyState("copied");
        return;
      }
      setCopyState("failed");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="vx-setup-stage">
      <div className="vx-setup-body">
        <div className="vx-setup-error-emblem" aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <div className="vx-setup-heading">
          <h1 ref={headingRef} tabIndex={-1}>
            {t("error.title")}
          </h1>
        </div>
        <p className="vx-setup-lead">{reasonText}</p>
        <p className="vx-setup-meta">{t("error.summary")}</p>

        <div className="vx-setup-details" aria-label={t("error.detailsLabel")}>
          {detailLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>

        {copyState === "copied" ? (
          <p className="vx-setup-meta" aria-live="polite">
            {t("actions.copied")}
          </p>
        ) : null}
        {copyState === "failed" ? (
          <p className="vx-setup-error-text" role="alert">
            {t("actions.copyFailed")}
          </p>
        ) : null}
      </div>

      <div className="vx-setup-actions">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t("actions.back")}
        </Button>
        <div className="vx-setup-actions__group">
          <Button
            variant="secondary"
            icon={<Copy size={15} />}
            onClick={() => void handleCopy()}
          >
            {t("actions.copyDetails")}
          </Button>
          <Button
            variant="primary"
            icon={<RotateCcw size={15} />}
            onClick={onRetry}
          >
            {t("actions.retry")}
          </Button>
        </div>
      </div>
    </div>
  );
}
