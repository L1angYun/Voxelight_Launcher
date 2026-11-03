import { type HTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "../../lib/utils";

export function PageShell({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("vx-page-shell", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, children, className, titleRef }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode;
  className?: string; titleRef?: Ref<HTMLHeadingElement>;
}) {
  return <header className={cn("vx-page-header", className)}>
    {title !== undefined ? <div className="vx-page-header__text">
      <h1 tabIndex={-1} ref={titleRef}>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div> : null}
    {actions ? <div className="vx-page-header__actions">{actions}</div> : null}
    {children}
  </header>;
}
