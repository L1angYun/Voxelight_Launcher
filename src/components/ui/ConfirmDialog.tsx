import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

// Under Tauri the dialog plugin replaces the browser's confirm with a call
// that does not block, so a synchronous `if (!confirm(...))` check always
// passes. Every confirmation in the launcher goes through this awaited dialog.

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  /** The question or consequence shown under the dialog title. */
  message: string;
  /** Defaults to the localized generic confirmation title. */
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" paints the confirm button with the danger fill. */
  tone?: ConfirmTone;
}

export type ConfirmDetails = Omit<ConfirmOptions, "message">;

/** Resolves true only when the user picked the confirm button. */
export type ConfirmFn = (message: string, details?: ConfirmDetails) => Promise<boolean>;

// Outside a provider every confirmation is declined, so a destructive command
// stays untouched instead of receiving an implicit "yes" (fail closed).
const declineConfirm: ConfirmFn = () => Promise.resolve(false);

export const ConfirmContext = createContext<ConfirmFn>(declineConfirm);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export interface ConfirmDialogProps {
  open: boolean;
  options: ConfirmOptions | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ open, options, onOpenChange, onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const danger = options?.tone === "danger";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={options?.title ?? t("common:confirm.title")}
      description={options?.message}
      className="vx-confirm-dialog"
      footer={
        <>
          {/* Cancel takes the first focus, so Enter right after opening declines. */}
          <Button variant="ghost" data-dialog-autofocus="true" data-confirm-cancel="true" onClick={() => onOpenChange(false)}>
            {options?.cancelLabel ?? t("common:actions.cancel")}
          </Button>
          <Button variant="primary" tone={danger ? "danger" : "default"} data-confirm-accept="true" onClick={onConfirm}>
            {options?.confirmLabel ?? t("common:actions.confirm")}
          </Button>
        </>
      }
    />
  );
}

export function ConfirmProvider({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  // The last request's text stays while the dialog fades out after closing.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const current = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message, details) => {
    const next: ConfirmOptions = { ...details, message };
    return new Promise<boolean>((resolve) => {
      // Only one modal confirmation can own the top layer. A newer request
      // declines the earlier one instead of leaving its caller waiting.
      current.current?.resolve(false);
      current.current = { options: next, resolve };
      setOptions(next);
      setOpen(true);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const request = current.current;
    if (!request) return;
    current.current = null;
    setOpen(false);
    request.resolve(confirmed);
  }, []);

  // A provider that goes away (window teardown, tests) declines what is open.
  useEffect(() => () => {
    current.current?.resolve(false);
    current.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={open}
        options={options}
        onOpenChange={(open) => { if (!open) settle(false); }}
        onConfirm={() => settle(true)}
      />
    </ConfirmContext.Provider>
  );
}
