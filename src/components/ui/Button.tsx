import { cloneElement, forwardRef, isValidElement, Fragment, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  tone?: "default" | "danger";
  icon?: ReactNode;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", tone = "default", icon, loading = false, size = "md", className, children, disabled, type = "button", ...props },
  ref,
) {
  const iconSize = size === "sm" ? 14 : size === "lg" ? 18 : 16;
  const sizedIcon = isValidElement<{ width?: number; height?: number }>(icon) && icon.type !== Fragment
    ? cloneElement(icon, { width: iconSize, height: iconSize }) : icon;
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn("vx-button", `vx-button--${variant}`, `vx-button--tone-${tone}`, `vx-button--${size}`, className)}
      data-variant={variant}
      data-tone={tone}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {icon ? <span className="vx-button__icon" aria-hidden="true">{sizedIcon}</span> : null}
      <span className="vx-button__label">{children}</span>
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string; icon: ReactNode }>(
  function IconButton({ label, icon, ...props }, ref) {
    return (
      <Button {...props} className={cn("vx-button--icon", props.className)} ref={ref} variant={props.variant ?? "ghost"} icon={icon} aria-label={label} title={label}>
        <span className="sr-only">{label}</span>
      </Button>
    );
  },
);
