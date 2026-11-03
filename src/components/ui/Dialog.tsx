import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { cn } from "../../lib/utils";
import { notifyDialogLayer } from "./ToastProvider";

function focusable(dialog: HTMLDialogElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
    ),
  ].filter(element => element.tabIndex >= 0 && !element.closest("[inert], [hidden], [aria-hidden='true']")
    && (element.checkVisibility?.({ visibilityProperty: true }) ?? true));
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  closeLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const focusFirst = useCallback((dialog: HTMLDialogElement) => {
    const items = focusable(dialog);
    const preferred = items.find(element => element.hasAttribute("data-dialog-autofocus"))
      ?? items.find(element => element.matches("input, select, textarea, button:not([data-dialog-close])"));
    (preferred ?? items[0] ?? dialog).focus();
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      notifyDialogLayer(dialog, true);
      focusFirst(dialog);
      return;
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      }
      notifyDialogLayer(dialog, false);
    }
  }, [focusFirst, open]);

  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog) notifyDialogLayer(dialog, false);
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    const dialog = ref.current;
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
    const last = items[items.length - 1];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey) {
      event.preventDefault();
      items[currentIndex <= 0 ? items.length - 1 : currentIndex - 1].focus();
    } else {
      event.preventDefault();
      items[currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1].focus();
    }
  }

  return (
    <dialog
      ref={ref}
      className={cn("vx-dialog", className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        // Native close events are queued: StrictMode or a rapid reopen may
        // already have returned this same dialog to the top layer.
        if (ref.current?.open) return;
        if (ref.current) notifyDialogLayer(ref.current, false);
        if (previousFocus.current?.isConnected) previousFocus.current.focus();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="vx-dialog__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <IconButton label={closeLabel ?? t("common:a11y.closeDialog")} icon={<X size={18} />} data-dialog-close="true" onClick={() => onOpenChange(false)} />
      </div>
      <div className="vx-dialog__body">{children}</div>
      {footer ? <div className="vx-dialog__footer">{footer}</div> : null}
    </dialog>
  );
}
