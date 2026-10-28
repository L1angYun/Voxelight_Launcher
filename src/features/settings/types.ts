import type { Config } from "../../lib/launcher";

export interface SettingsSectionProps {
  config: Config;
  onChange: (next: Config) => void;
  onPersisted: (next: Config) => Promise<void>;
  onPersistedPatch: (patch: Partial<Config>) => Promise<void>;
  onError: (cause: unknown) => void;
  onNotice: (code: string, params?: Record<string, unknown>) => void;
}
