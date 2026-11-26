import { Sparkles } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useLumen } from "./LumenContext";

/**
 * Shared contextual Lumen wake-up button. Enforces strict zero-presence when
 * Lumen is not configured so feature pages never hand-roll gating checks.
 */
export function LumenHelpButton({
  when = true,
  label,
  reason,
  prompt,
  size,
}: {
  when?: boolean;
  label: string;
  reason: string;
  prompt: string;
  size?: "sm" | "md";
}) {
  const lumen = useLumen();
  if (!lumen.configured || !when) return null;
  return (
    <Button
      size={size}
      variant="ghost"
      icon={<Sparkles size={14} />}
      onClick={() => lumen.openLumen({ reason, prompt, autoSend: true })}
    >
      {label}
    </Button>
  );
}
