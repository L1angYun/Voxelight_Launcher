// Traditional Chinese colour presets for the accent chooser.
// Values read from zhongguose.com (based on the 1957 Chinese Academy of
// Sciences colour atlas): https://zhongguose.com/colors.json
// The source URL is data for maintainers only; it is never shown in the UI.
export const ACCENT_PRESET_SOURCE_URL = "https://zhongguose.com/colors.json";

export interface AccentPreset {
  /** Stable pinyin identifier, also used as the React key. */
  readonly id: string;
  /** Fully qualified translation key; the Chinese name is the primary label. */
  readonly nameKey: string;
  readonly hex: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "dianqing", nameKey: "settings:accent.names.dianqing", hex: "#1661ab" },
  { id: "kongquelan", nameKey: "settings:accent.names.kongquelan", hex: "#0eb0c9" },
  { id: "biqing", nameKey: "settings:accent.names.biqing", hex: "#5cb3cc" },
  { id: "zhulv", nameKey: "settings:accent.names.zhulv", hex: "#1ba784" },
  { id: "luweilv", nameKey: "settings:accent.names.luweilv", hex: "#b7d07a" },
  { id: "zhuhong", nameKey: "settings:accent.names.zhuhong", hex: "#ed5126" },
  { id: "haitanghong", nameKey: "settings:accent.names.haitanghong", hex: "#f03752" },
  { id: "meiguihong", nameKey: "settings:accent.names.meiguihong", hex: "#d2357d" },
  { id: "qinglian", nameKey: "settings:accent.names.qinglian", hex: "#8b2671" },
  { id: "hupohuang", nameKey: "settings:accent.names.hupohuang", hex: "#feba07" },
  { id: "yanyuhui", nameKey: "settings:accent.names.yanyuhui", hex: "#685e48" },
];
