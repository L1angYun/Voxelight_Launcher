import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "./Button";

export function ExternalLink({ url: suppliedUrl, children, variant = "link", desktop = true }: {
  url: string;
  children: ReactNode;
  variant?: "link" | "primary" | "ghost";
  desktop?: boolean;
}) {
  // Project metadata accepts either official host; the native scope uses only the canonical one.
  const url = suppliedUrl.replace(
    /^https:\/\/curseforge\.com(?=\/(?:minecraft\/(?:mc-mods|modpacks|shaders|texture-packs)|projects)\/)/,
    "https://www.curseforge.com",
  );
  const { t } = useTranslation();
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  async function visit() {
    setFailure(null);
    setCopied(null);
    setCopyFailed(null);
    try {
      if (!desktop) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw new Error("HTTPS required");
        window.open(url, "_blank", "noopener,noreferrer");
      } else await openUrl(url);
    } catch {
      setFailure(url);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setCopyFailed(null);
    } catch {
      // The URL remains available as selectable text.
      setCopied(null);
      setCopyFailed(url);
    }
  }
  return <>
    {variant === "link" ? <a href={url} rel="noreferrer" onClick={(event) => {
      event.preventDefault();
      void visit();
    }}>{children}</a> : <Button variant={variant} onClick={() => void visit()}>{children}</Button>}
    {failure === url ? <div>
      <p role="alert">{t("shell:external.openFailed")}</p>
      <input className="vx-path" aria-label={t("shell:external.address")} value={url} readOnly
        onFocus={(event) => event.currentTarget.select()} />
      <Button size="sm" variant="secondary" onClick={() => void copy()}>{t("shell:external.copy")}</Button>
      {copied === url ? <p role="status">{t("shell:external.copied")}</p> : null}
      {copyFailed === url ? <p role="status">{t("shell:external.copyFailed")}</p> : null}
    </div> : null}
  </>;
}
