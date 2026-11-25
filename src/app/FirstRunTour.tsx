import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { useMotionTier } from "../design/useMotionTier";
import { useLauncher } from "./controller/LauncherProvider";
import "./tour.css";

const steps = [
  { anchor: "library", titleKey: "shell:tour.steps.library.title", bodyKey: "shell:tour.steps.library.body" },
  { anchor: "discover", titleKey: "shell:tour.steps.discover.title", bodyKey: "shell:tour.steps.discover.body" },
  { anchor: "downloads", titleKey: "shell:tour.steps.downloads.title", bodyKey: "shell:tour.steps.downloads.body" },
  { anchor: "settings", titleKey: "shell:tour.steps.settings.title", bodyKey: "shell:tour.steps.settings.body" },
] as const;

function focusable(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
  )].filter((element) => element.tabIndex >= 0 && !element.closest("[inert], [hidden], [aria-hidden='true']"));
}

export function FirstRunTour({
  reopen = false,
  onDismissed,
}: {
  reopen?: boolean;
  onDismissed?: () => void;
}) {
  const { t } = useTranslation();
  const { bootstrapped, config, setTourCompleted } = useLauncher();
  const { tier } = useMotionTier();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const focusNextAfterBack = useRef(false);
  const bodyId = useId();
  const visible = bootstrapped && !dismissed && (reopen || !config.tourCompleted);
  const current = steps[step];
  const last = step === steps.length - 1;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const complete = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setDismissed(true);
    onDismissed?.();
    try {
      // A narrow command: it cannot be refused by a running install and it
      // leaves an unsaved appearance preview alone.
      void setTourCompleted(true).catch(() => {
        // A failed save must not trap the user in the tour this session.
      });
    } catch {
      // A synchronous save failure also leaves the tour closed for this session.
    }
  }, [onDismissed, setTourCompleted]);
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const goBack = () => {
    if (step === 0) return;
    focusNextAfterBack.current = step === 1;
    setStep(step - 1);
  };

  useLayoutEffect(() => {
    if (reopen) setDismissed(false);
  }, [reopen]);

  useLayoutEffect(() => {
    if (visible) setStep(0);
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    closing.current = false;
    const focusCard = () => {
      const current = cardRef.current;
      if (current?.isConnected) current.focus({ preventScroll: true });
    };
    focusCard();
    // "Show the tour again" closes the shortcut help dialog in a passive
    // effect of the same commit, and that close restores focus to the help's
    // trigger. The tour is not a native dialog, so focus the card once the
    // dialog's close event has run (including its own focus restore).
    const closingDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    const finishDialogClose = () => {
      if (document.querySelector("dialog[open]")) return;
      focusCard();
    };
    closingDialog?.addEventListener("close", finishDialogClose, { once: true });
    return () => {
      closingDialog?.removeEventListener("close", finishDialogClose);
      document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
    };
  }, [visible]);

  // Back becomes disabled on step 1. Native focus fixup then drops focus to
  // the body, so hand it to the primary action instead.
  useLayoutEffect(() => {
    if (!focusNextAfterBack.current) return;
    focusNextAfterBack.current = false;
    nextRef.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    if (!visible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        completeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const items = focusable(card);
      if (!items.length) {
        event.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : first).focus();
        return;
      }
      if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || active === card)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  const place = useCallback(() => {
    const card = cardRef.current;
    const anchor = document.querySelector<HTMLElement>(`[data-tour-anchor="${current.anchor}"]`);
    const rect = anchor?.getBoundingClientRect();
    const width = card?.offsetWidth || 340;
    const height = card?.offsetHeight || 220;
    const margin = 12;
    if (!anchor || !rect || rect.width <= 0 || rect.height <= 0
      || window.innerWidth < width + margin * 2 || window.innerHeight < height + margin * 2) {
      setPosition(null);
      return;
    }
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const top = rect.bottom + 14;
    setPosition(top + height <= window.innerHeight - margin ? { left, top } : null);
  }, [current.anchor]);

  useLayoutEffect(() => {
    if (!visible) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place, visible]);

  if (!visible) return null;

  return (
    <div className="vx-tour">
      <motion.div
        ref={cardRef}
        className="vx-tour__card"
        role="dialog"
        aria-label={t("shell:tour.title")}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-motion-tier={tier}
        data-position={position ? "anchored" : "centred"}
        data-tour-step={step + 1}
        data-tour-total={steps.length}
        style={position ? { left: position.left, top: position.top } : undefined}
        initial={tier === "none" ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: tier === "none" ? 0 : 0.18 }}
      >
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {t("shell:tour.announcement", {
            current: step + 1,
            total: steps.length,
            title: t(current.titleKey),
            body: t(current.bodyKey),
          })}
        </span>
        <div className="vx-tour__head">
          <span className="vx-tour__count">{t("shell:tour.step", { current: step + 1, total: steps.length })}</span>
          <Button variant="ghost" size="sm" onClick={complete}>{t("shell:tour.skip")}</Button>
        </div>
        <h2 className="vx-tour__heading">{t(current.titleKey)}</h2>
        <p className="vx-tour__body" id={bodyId}>{t(current.bodyKey)}</p>
        <div className="vx-tour__actions">
          <Button variant="ghost" disabled={step === 0} onClick={goBack}>{t("shell:tour.back")}</Button>
          <Button
            ref={nextRef}
            variant="primary"
            onClick={last ? complete : () => setStep(step + 1)}
          >
            {last ? t("shell:tour.finish") : t("shell:tour.next")}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
