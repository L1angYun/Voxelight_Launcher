// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button, IconButton } from "../../../src/components/ui/Button";

function focusable(dialog: HTMLDialogElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0
      && !element.closest("[inert], [hidden], [aria-hidden='true']")
      && (element.checkVisibility?.({ visibilityProperty: true }) ?? true),
  );
}

export interface LicenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  licenseText: string | null;
}

export function LicenseDialog({
  open,
  onOpenChange,
  licenseText,
}: LicenseDialogProps) {
  const { t } = useTranslation("setup");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const focusFirst = useCallback((dialog: HTMLDialogElement) => {
    const items = focusable(dialog);
    const preferred =
      items.find((element) => element.hasAttribute("data-dialog-autofocus"))
      ?? items.find((element) => !element.hasAttribute("data-dialog-close"));
    (preferred ?? items[0] ?? dialog).focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      focusFirst(dialog);
      return;
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      }
    }
  }, [focusFirst, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (event.shiftKey) {
      items[currentIndex <= 0 ? items.length - 1 : currentIndex - 1].focus();
    } else {
      items[currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1].focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="vx-dialog vx-setup-license-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (dialogRef.current?.open) return;
        const active = document.activeElement;
        if (
          (!active || active === document.body || dialogRef.current?.contains(active))
          && previousFocus.current?.isConnected
        ) {
          previousFocus.current.focus();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="vx-dialog__header">
        <div>
          <h2 id={titleId}>{t("license.title")}</h2>
          <p id={descriptionId}>{t("license.description")}</p>
        </div>
        <IconButton
          size="sm"
          label={t("license.close")}
          icon={<X size={16} />}
          data-dialog-close="true"
          onClick={() => onOpenChange(false)}
        />
      </div>
      <div className="vx-dialog__body vx-setup-license-dialog__body">
        <pre className="vx-setup-license-dialog__pre" tabIndex={0}>
          {licenseText ?? t("license.loading")}
        </pre>
      </div>
      <div className="vx-dialog__footer">
        <Button
          variant="primary"
          size="sm"
          data-dialog-autofocus="true"
          onClick={() => onOpenChange(false)}
        >
          {t("actions.close")}
        </Button>
      </div>
    </dialog>
  );
}
