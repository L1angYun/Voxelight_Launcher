// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { command, type Account } from "./launcher";
import { normalizeError } from "./errors";
import type { PlayerProfile } from "./playerProfile";
import type { SkinModel } from "../components/skinTexture";

function validateProfile(account: Account, profile: PlayerProfile) {
  const expected = account.uuid.replaceAll("-", "").toLowerCase();
  const actual = profile.id.replaceAll("-", "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(expected) && actual !== expected) {
    throw new Error("账号外观的角色身份与当前账号不一致");
  }
}

export interface AccountSkin {
  profile: PlayerProfile | null;
  setProfile: (profile: PlayerProfile | null) => void;
  skinUrl?: string;
  model: SkinModel;
  capeUrl?: string;
  hasAccountSkin: boolean;
  loading: boolean;
  error: string;
  errorCode?: string;
  refresh: () => void;
}

export function useAccountSkin(account?: Account): AccountSkin {
  const [attempt, setAttempt] = useState(0);
  const [appearance, setAppearance] = useState<{
    accountId?: string;
    profile: PlayerProfile | null;
    loading: boolean;
    error: string;
    errorCode?: string;
  }>({ profile: null, loading: false, error: "" });
  const generation = useRef(0);
  const online = account?.type === "microsoft" || account?.type === "authlib";

  useEffect(() => {
    const current = ++generation.current;
    const accountId = account?.id;
    setAppearance((previous) => ({
      accountId,
      profile:
        account && online && previous.accountId === accountId
          ? previous.profile
          : null,
      loading: Boolean(account && online),
      error: "",
      errorCode: undefined,
    }));
    if (!account || !online) return;
    void command<PlayerProfile>("get_player_profile", { accountId })
      .then((profile) => {
        if (generation.current !== current) return;
        validateProfile(account, profile);
        setAppearance({ accountId, profile, loading: false, error: "" });
      })
      .catch((cause: unknown) => {
        if (generation.current === current) {
          const normalized = normalizeError(cause);
          setAppearance((previous) => ({
            accountId,
            profile: previous.accountId === accountId ? previous.profile : null,
            loading: false,
            error: normalized.detail ?? normalized.message,
            errorCode: normalized.code,
          }));
        }
      });
    return () => {
      generation.current++;
    };
  }, [
    account?.id,
    account?.uuid,
    account?.skinUrl,
    account?.skinModel,
    online,
    attempt,
  ]);

  const setProfile = useCallback(
    (profile: PlayerProfile | null) => {
      if (account && profile) {
        try {
          validateProfile(account, profile);
        } catch (cause) {
          setAppearance({
            accountId: account.id,
            profile: null,
            loading: false,
            error: String(cause),
          errorCode: "internal.unexpected",
          });
          return;
        }
      }
      setAppearance({
        accountId: account?.id,
        profile,
        loading: false,
        error: "",
      errorCode: undefined,
      });
    },
    [account?.id, account?.uuid],
  );

  const owned = appearance.accountId === account?.id;
  const profile = owned ? appearance.profile : null;
  const skin =
    profile?.skins.find((item) => item.state.toUpperCase() === "ACTIVE") ??
    profile?.skins[0];
  const cape = profile?.capes.find(
    (item) => item.state.toUpperCase() === "ACTIVE",
  );
  const skinUrl = profile ? skin?.url : (account?.skinUrl ?? undefined);
  const model: SkinModel = profile
    ? skin
      ? skin.variant?.toLowerCase() === "slim"
        ? "slim"
        : "classic"
      : "auto"
    : account?.skinModel === "slim"
      ? "slim"
      : account?.skinModel === "classic"
        ? "classic"
        : "auto";

  return {
    profile,
    setProfile,
    skinUrl,
    model,
    capeUrl: cape?.url,
    hasAccountSkin: Boolean(skinUrl),
    loading: Boolean(online && (!owned || appearance.loading)),
    error: owned ? appearance.error : "",
    errorCode: owned ? appearance.errorCode : undefined,
    refresh: () => setAttempt((value) => value + 1),
  };
}
