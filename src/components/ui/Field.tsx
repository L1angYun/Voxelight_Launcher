import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Field({
  label,
  description,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  description?: string;
  error?: string;
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const descriptionId = `field-description-${id}`;
  const errorId = `field-error-${id}`;
  const describedBy = [description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ");
  const child = isValidElement(children)
    ? (children as ReactElement<Record<string, unknown>>)
    : null;
  const childProps = child?.props ?? {};
  const control = child
    ? cloneElement(child, {
        "aria-describedby": [childProps["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : childProps["aria-invalid"],
      })
    : children;
  const controlId = htmlFor ?? (childProps.id as string | undefined);
  return (
    <div className={cn("vx-field", className)}>
      <label htmlFor={controlId}>{label}</label>
      {description ? <p id={descriptionId}>{description}</p> : null}
      {control}
      {error ? <p id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}
