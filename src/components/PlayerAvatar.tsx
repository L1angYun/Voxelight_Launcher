// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./PlayerAvatar.css";

interface PlayerAvatarProps {
  skinUrl?: string | null;
  username?: string;
  size?: number;
  className?: string;
  label?: string;
}

export function PlayerAvatar({
  skinUrl,
  username,
  size = 36,
  className = "",
  label: providedLabel,
}: PlayerAvatarProps) {
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [textureHeight, setTextureHeight] = useState("800%");
  const { t } = useTranslation();

  useEffect(() => {
    setLoadedUrl(undefined);
    if (!skinUrl) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (
        active &&
        image.naturalWidth >= 64 &&
        (image.naturalHeight === image.naturalWidth ||
          image.naturalHeight * 2 === image.naturalWidth)
      ) {
        setTextureHeight(
          image.naturalHeight === image.naturalWidth ? "800%" : "400%",
        );
        setLoadedUrl(skinUrl);
      }
    };
    image.onerror = () => {
      if (active) setLoadedUrl(undefined);
    };
    image.src = skinUrl;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [skinUrl]);

  const label = providedLabel ?? t("accounts:avatar", { name: username ?? t("accounts:type.unknown") });
  const url =
    loadedUrl && loadedUrl === skinUrl ? JSON.stringify(loadedUrl) : undefined;

  return (
    <span
      className={`player-avatar${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      {url ? (
        <span
          className="player-avatar-head"
          aria-hidden="true"
          style={{
            backgroundImage: `url(${url}), url(${url})`,
            backgroundSize: `800% ${textureHeight}`,
            backgroundPosition: textureHeight === "400%" ? "71.4286% 33.3333%, 14.2857% 33.3333%" : undefined,
          }}
        />
      ) : (
        <UserRound size={Math.max(16, Math.round(size * 0.52))} aria-hidden />
      )}
    </span>
  );
}

export default PlayerAvatar;
