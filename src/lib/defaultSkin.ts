// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { command, desktop } from "./launcher";

export type DefaultSkinId = "steve" | "alex";
export interface DefaultSkin {
  id: DefaultSkinId;
  name: string;
  dataUrl: string;
  model: "classic" | "slim";
  sourceVersion?: string | null;
  sourceUrl?: string | null;
  notice?: string;
  isFallback?: boolean;
}

type DefaultSkinResponse = Omit<DefaultSkin, "dataUrl" | "notice"> & {
  dataUrl: string | null;
  description: string;
  localPath?: string | null;
};

function unavailableSkin(id: DefaultSkinId): DefaultSkin {
  return {
    id,
    name: id === "alex" ? "Alex" : "Steve",
    dataUrl: "",
    model: id === "alex" ? "slim" : "classic",
    isFallback: true,
  };
}

export function useDefaultSkin(
  id: DefaultSkinId,
  versionId?: string,
  enabled = true,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    skin: DefaultSkin;
    loading: boolean;
    error: string;
  }>(() => ({ skin: unavailableSkin(id), loading: false, error: "" }));

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setState({
        skin: {
          ...unavailableSkin(id),
          notice: "默认预览按需加载，当前优先显示账号外观。",
        },
        loading: false,
        error: "",
      });
      return () => {
        active = false;
      };
    }
    if (!desktop) {
      setState({
        skin: unavailableSkin(id),
        loading: false,
        error:
          "浏览器预览不下载客户端；桌面版可从已校验的官方客户端读取此角色。",
      });
      return () => {
        active = false;
      };
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    void command<DefaultSkinResponse>("get_default_skin", {
      skin: id,
      versionId: versionId || null,
    })
      .then((skin) => {
        if (!active) return;
        if (skin.id !== id || !skin.dataUrl) {
          throw new Error("角色资源响应与所选角色不一致");
        }
        setState({
          skin: { ...skin, dataUrl: skin.dataUrl, notice: skin.description },
          loading: false,
          error: "",
        });
      })
      .catch((cause: unknown) => {
        if (active) {
          setState({
            skin: unavailableSkin(id),
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [id, versionId, enabled, attempt]);

  return { ...state, refresh: () => setAttempt((value) => value + 1) };
}
