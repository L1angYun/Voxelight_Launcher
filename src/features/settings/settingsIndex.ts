export type SettingsSectionId = "general" | "appearance" | "game" | "java" | "downloads" | "assistant" | "about";

export interface SettingsEntry {
  /** The settings section that renders the label and its control. */
  section: SettingsSectionId;
  /** An existing settings namespace key for the label the user sees. */
  labelKey: string;
  /** Extra settings namespace keys with synonyms, translated for search only. */
  keywords?: readonly string[];
  /** Stable id placed on the element that wraps the setting and its control. */
  target: string;
  /**
   * Where to reveal the setting when `target` is not rendered in the current
   * state (for example a custom-only field while the default mode is active).
   */
  fallbackTarget?: string;
  /**
   * Wait briefly for a disabled control to become enabled before falling back.
   * Proxy credential fields load their stored state over IPC after mounting.
   */
  waitForEnabled?: boolean;
}

export interface SettingsSearchResult {
  entry: SettingsEntry;
  label: string;
  sectionLabel: string;
}

export type SettingsTranslator = (key: string) => string;

const keyword = {
  microsoftAccount: "settings:search.keywords.microsoftAccount",
  clientIdOptional: "settings:search.keywords.clientIdOptional",
  apiKey: "settings:search.keywords.apiKey",
  curseforge: "settings:search.keywords.curseforge",
  preset: "settings:search.keywords.preset",
  backup: "settings:search.keywords.backup",
  darkMode: "settings:search.keywords.darkMode",
  themeMode: "settings:search.keywords.themeMode",
  locale: "settings:search.keywords.locale",
  animations: "settings:search.keywords.animations",
  motion: "settings:search.keywords.motion",
  scene: "settings:search.keywords.scene",
  particles: "settings:search.keywords.particles",
  colour: "settings:search.keywords.colour",
  audio: "settings:search.keywords.audio",
  wallpaper: "settings:search.keywords.wallpaper",
  gameFolder: "settings:search.keywords.gameFolder",
  instanceIsolation: "settings:search.keywords.instanceIsolation",
  resolution: "settings:search.keywords.resolution",
  javaPath: "settings:search.keywords.javaPath",
  javaRuntime: "settings:search.keywords.javaRuntime",
  jdk: "settings:search.keywords.jdk",
  findJava: "settings:search.keywords.findJava",
  ram: "settings:search.keywords.ram",
  heap: "settings:search.keywords.heap",
  initialHeap: "settings:search.keywords.initialHeap",
  jvmOptions: "settings:search.keywords.jvmOptions",
  javaOptions: "settings:search.keywords.javaOptions",
  runtimeDownload: "settings:search.keywords.runtimeDownload",
  mirror: "settings:search.keywords.mirror",
  official: "settings:search.keywords.official",
  parallelDownloads: "settings:search.keywords.parallelDownloads",
  speedLimit: "settings:search.keywords.speedLimit",
  networkProxy: "settings:search.keywords.networkProxy",
  httpProxy: "settings:search.keywords.httpProxy",
  proxyServer: "settings:search.keywords.proxyServer",
  gameProxy: "settings:search.keywords.gameProxy",
  proxyTest: "settings:search.keywords.proxyTest",
  proxyDetect: "settings:search.keywords.proxyDetect",
  credentials: "settings:search.keywords.credentials",
  startupCheck: "settings:search.keywords.startupCheck",
  updateChannel: "settings:search.keywords.updateChannel",
  updateCheck: "settings:search.keywords.updateCheck",
  aiAssistant: "settings:search.keywords.aiAssistant",
  mcpServer: "settings:search.keywords.mcpServer",
  llmProvider: "settings:search.keywords.llmProvider",
  modelName: "settings:search.keywords.modelName",
  permissionTier: "settings:search.keywords.permissionTier",
  proactiveWake: "settings:search.keywords.proactiveWake",
  factoryReset: "settings:search.keywords.factoryReset",
} as const;

/** Every user-facing setting or action, in the order the sections present them. */
export const settingsIndex: readonly SettingsEntry[] = [
  { section: "general", labelKey: "settings:service.clientId", keywords: [keyword.microsoftAccount, keyword.clientIdOptional], target: "general-client-id" },
  { section: "general", labelKey: "settings:service.curseforgeKey", keywords: [keyword.apiKey, keyword.curseforge], target: "general-curseforge-key" },
  { section: "general", labelKey: "settings:preset.export", keywords: [keyword.preset, keyword.backup], target: "general-export-preset" },
  { section: "general", labelKey: "settings:preset.import", keywords: [keyword.preset, keyword.backup], target: "general-import-preset" },
  { section: "general", labelKey: "settings:resetLauncher.action", keywords: [keyword.factoryReset], target: "general-reset-launcher" },

  { section: "appearance", labelKey: "settings:fields.theme", keywords: [keyword.darkMode, keyword.themeMode], target: "appearance-theme" },
  { section: "appearance", labelKey: "settings:fields.language", keywords: [keyword.locale], target: "appearance-language" },
  { section: "appearance", labelKey: "settings:fields.effects", keywords: [keyword.animations, keyword.motion], target: "appearance-effects" },
  { section: "appearance", labelKey: "settings:fields.worldScene", keywords: [keyword.scene], target: "appearance-world-scene" },
  { section: "appearance", labelKey: "settings:fields.worldMaterial", keywords: [keyword.particles], target: "appearance-world-material" },
  { section: "appearance", labelKey: "settings:fields.accentSource", target: "appearance-accent-source" },
  { section: "appearance", labelKey: "settings:fields.accentColor", keywords: [keyword.colour], target: "appearance-accent-color", fallbackTarget: "appearance-accent-source" },
  { section: "appearance", labelKey: "settings:fields.sound", keywords: [keyword.audio], target: "appearance-sound" },
  { section: "appearance", labelKey: "settings:background.choose", keywords: [keyword.wallpaper], target: "appearance-background" },

  { section: "game", labelKey: "settings:fields.gameDirectory", keywords: [keyword.gameFolder], target: "game-directory" },
  { section: "game", labelKey: "settings:fields.versionIsolation", keywords: [keyword.instanceIsolation], target: "game-version-isolation" },
  { section: "game", labelKey: "settings:fields.screenWidth", keywords: [keyword.resolution], target: "game-window-width" },
  { section: "game", labelKey: "settings:fields.screenHeight", keywords: [keyword.resolution], target: "game-window-height" },

  { section: "java", labelKey: "settings:fields.javaPath", keywords: [keyword.javaPath, keyword.javaRuntime, keyword.jdk], target: "java-executable" },
  { section: "java", labelKey: "settings:java.detect", keywords: [keyword.findJava], target: "java-detect" },
  { section: "java", labelKey: "settings:memory.mode", keywords: [keyword.ram], target: "java-memory-mode" },
  { section: "java", labelKey: "settings:memory.initial", keywords: [keyword.ram, keyword.initialHeap], target: "java-initial-memory" },
  { section: "java", labelKey: "settings:fields.maxMemory", keywords: [keyword.ram, keyword.heap], target: "java-max-memory", fallbackTarget: "java-memory-mode" },
  { section: "java", labelKey: "settings:fields.jvmArguments", keywords: [keyword.jvmOptions, keyword.javaOptions], target: "java-jvm-arguments" },
  { section: "java", labelKey: "settings:fields.javaAutoDownload", keywords: [keyword.runtimeDownload], target: "java-auto-download" },

  { section: "downloads", labelKey: "settings:fields.downloadSource", keywords: [keyword.mirror, keyword.official], target: "downloads-source" },
  { section: "downloads", labelKey: "settings:fields.downloadConcurrency", keywords: [keyword.parallelDownloads], target: "downloads-concurrency" },
  { section: "downloads", labelKey: "settings:fields.downloadLimit", keywords: [keyword.speedLimit], target: "downloads-limit" },
  { section: "downloads", labelKey: "settings:proxy.mode", keywords: [keyword.networkProxy], target: "downloads-proxy-mode" },
  { section: "downloads", labelKey: "settings:proxy.detect", keywords: [keyword.networkProxy, keyword.proxyDetect], target: "downloads-proxy-detect" },
  { section: "downloads", labelKey: "settings:proxy.scheme", keywords: [keyword.httpProxy], target: "downloads-proxy-scheme", fallbackTarget: "downloads-proxy-mode" },
  { section: "downloads", labelKey: "settings:proxy.host", keywords: [keyword.proxyServer], target: "downloads-proxy-host", fallbackTarget: "downloads-proxy-mode" },
  { section: "downloads", labelKey: "settings:proxy.port", keywords: [keyword.proxyServer], target: "downloads-proxy-port", fallbackTarget: "downloads-proxy-mode" },
  { section: "downloads", labelKey: "settings:proxy.gameMode", keywords: [keyword.gameProxy], target: "downloads-proxy-game-mode" },
  { section: "downloads", labelKey: "settings:proxy.test", keywords: [keyword.proxyTest], target: "downloads-proxy-test" },
  { section: "downloads", labelKey: "settings:proxy.username", keywords: [keyword.credentials], target: "downloads-proxy-username", fallbackTarget: "downloads-proxy-mode", waitForEnabled: true },
  { section: "downloads", labelKey: "settings:proxy.password", keywords: [keyword.credentials], target: "downloads-proxy-password", fallbackTarget: "downloads-proxy-mode", waitForEnabled: true },
  { section: "downloads", labelKey: "settings:proxy.saveCredentials", keywords: [keyword.credentials], target: "downloads-proxy-username", fallbackTarget: "downloads-proxy-mode", waitForEnabled: true },

  { section: "assistant", labelKey: "settings:assistant.provider", keywords: [keyword.aiAssistant, keyword.llmProvider], target: "assistant-provider" },
  { section: "assistant", labelKey: "settings:assistant.baseUrl", keywords: [keyword.aiAssistant, keyword.llmProvider], target: "assistant-base-url" },
  { section: "assistant", labelKey: "settings:assistant.model", keywords: [keyword.aiAssistant, keyword.modelName], target: "assistant-model" },
  { section: "assistant", labelKey: "settings:assistant.apiKey", keywords: [keyword.aiAssistant, keyword.apiKey], target: "assistant-api-key" },
  { section: "assistant", labelKey: "settings:assistant.permission", keywords: [keyword.aiAssistant, keyword.permissionTier], target: "assistant-permission" },
  { section: "assistant", labelKey: "settings:assistant.proactive", keywords: [keyword.aiAssistant, keyword.proactiveWake], target: "assistant-proactive" },
  { section: "assistant", labelKey: "settings:assistant.mcpPort", keywords: [keyword.mcpServer], target: "assistant-mcp-port" },
  { section: "assistant", labelKey: "settings:assistant.mcpStart", keywords: [keyword.mcpServer], target: "assistant-mcp-actions" },

  { section: "about", labelKey: "settings:updates.checkOnStartup", keywords: [keyword.startupCheck], target: "about-update-check" },
  { section: "about", labelKey: "settings:updates.source", keywords: [keyword.updateChannel], target: "about-update-source" },
  { section: "about", labelKey: "settings:updates.checkNow", keywords: [keyword.updateCheck], target: "about-update-actions" },
];

const MAX_RESULTS = 8;

/** Match a trimmed query against translated labels and keywords, label prefixes first. */
export function searchSettings(query: string, t: SettingsTranslator): SettingsSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<SettingsSearchResult & { labelPrefix: boolean }> = [];
  for (const entry of settingsIndex) {
    const label = t(entry.labelKey);
    const normalizedLabel = label.trim().toLowerCase();
    const labelPrefix = normalizedLabel.startsWith(needle);
    const matchesLabel = normalizedLabel.includes(needle);
    const matchesKeyword = (entry.keywords ?? []).some((key) => t(key).trim().toLowerCase().includes(needle));
    if (!matchesLabel && !matchesKeyword) continue;
    matches.push({ entry, label, sectionLabel: t(`settings:section.${entry.section}`), labelPrefix });
  }
  matches.sort((a, b) => Number(b.labelPrefix) - Number(a.labelPrefix));
  return matches.slice(0, MAX_RESULTS).map(({ entry, label, sectionLabel }) => ({ entry, label, sectionLabel }));
}
