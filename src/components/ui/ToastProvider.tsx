import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { motionDuration, MOTION } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";

export interface ToastMessage { message: string; kind?: "info" | "error" | "success"; id?: string; onDismiss?: () => void }
const empty = { notify: (_message: ToastMessage) => {}, dismiss: (_id?: string) => {} };
const ToastContext = createContext(empty);
export const useToast = () => useContext(ToastContext);
const layerEvent = "vx:dialog-layer";
export function notifyDialogLayer(dialog: HTMLDialogElement, open: boolean) {
  document.dispatchEvent(new CustomEvent(layerEvent, { detail: { dialog, open } }));
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { tier } = useMotionTier();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const serial = useRef(0);
  const current = useRef(toast); current.current = toast;
  const notify = useCallback((next: ToastMessage) => setToast({ ...next, id: next.id ?? `toast-${++serial.current}` }), []);
  const dismiss = useCallback((id?: string) => {
    const active = current.current;
    if (id && active?.id !== id) return;
    setToast(null); active?.onDismiss?.();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.kind === "error" ? 11000 : 5000);
    return () => clearTimeout(timer);
  }, [dismiss, toast]);
  useLayoutEffect(() => {
    const layers: HTMLDialogElement[] = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
    const update = (event?: Event) => {
      if (event) {
        const { dialog, open } = (event as CustomEvent<{ dialog: HTMLDialogElement; open: boolean }>).detail;
        const index = layers.indexOf(dialog);
        if (index >= 0) layers.splice(index, 1);
        if (open) layers.push(dialog);
      }
      setHost(layers.filter(dialog => dialog.isConnected && dialog.open).at(-1) ?? root.current);
    };
    update(); document.addEventListener(layerEvent, update);
    return () => document.removeEventListener(layerEvent, update);
  }, []);
  return <ToastContext.Provider value={{ notify, dismiss }}>{children}<div ref={root} className="vx-toast-root" />
    {host ? createPortal(<div className="vx-toast-host"><AnimatePresence initial={false}>
      {toast ? <motion.div key="notification" className={`vx-toast vx-toast--${toast.kind ?? "info"}`}
        role={toast.kind === "error" ? "alert" : "status"} aria-atomic="true"
        initial={{ opacity: 0, transform: tier === "full" ? "translateY(8px)" : "none" }}
        animate={{ opacity: 1, transform: "none" }}
        exit={{ opacity: 0, transform: tier === "full" ? "translateY(8px)" : "none", transition: { duration: motionDuration(tier, "exit") } }}
        transition={{ duration: motionDuration(tier, "enter"), ease: MOTION.ease }}>
        <span>{toast.message}</span><IconButton label={t("common:a11y.dismissNotification")} icon={<X size={16} />} onClick={() => dismiss()} />
      </motion.div> : null}
    </AnimatePresence></div>, host) : null}
  </ToastContext.Provider>;
}
