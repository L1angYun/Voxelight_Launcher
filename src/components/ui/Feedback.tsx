import { useId, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { IconButton } from "./Button";
import { cn } from "../../lib/utils";
import "./Feedback.css";

export type EmptyStateVariant = "panel" | "inline";
export type ToastKind = "info" | "success" | "warning" | "error";

const TOAST_ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const;

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "panel",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: EmptyStateVariant;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section
      className={cn("vx-empty", `vx-empty--${variant}`, className)}
      data-variant={variant}
      aria-labelledby={titleId}
    >
      {icon ? (
        <div
          className={cn("vx-empty__icon", variant === "panel" && "vx-icon-tile")}
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <h2 id={titleId}>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="vx-empty__action">{action}</div> : null}
    </section>
  );
}

export function ToastRegion({
  message,
  kind = "info",
  onDismiss,
  closeLabel,
}: {
  message?: string;
  kind?: ToastKind;
  onDismiss: () => void;
  closeLabel: string;
}) {
  if (!message) return null;
  const Icon = TOAST_ICONS[kind];
  return (
    <div
      className={cn("vx-toast", `vx-toast--${kind}`)}
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
    >
      <Icon className="vx-toast__icon" size={16} aria-hidden="true" />
      <span className="vx-toast__body">{message}</span>
      <IconButton label={closeLabel} icon={<X size={16} />} onClick={onDismiss} />
    </div>
  );
}
