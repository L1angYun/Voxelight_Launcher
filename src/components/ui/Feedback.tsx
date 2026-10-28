import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { cn } from "../../lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section className={cn("vx-empty", className)} aria-labelledby={titleId}>
      {icon ? <div className="vx-empty__icon" aria-hidden="true">{icon}</div> : null}
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
  kind?: "info" | "error";
  onDismiss: () => void;
  closeLabel: string;
}) {
  if (!message) return null;
  return (
    <div className={cn("vx-toast", `vx-toast--${kind}`)} role={kind === "error" ? "alert" : "status"}>
      <span>{message}</span>
      <IconButton label={closeLabel} icon={<X size={16} />} onClick={onDismiss} />
    </div>
  );
}
