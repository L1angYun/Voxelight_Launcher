export type AmbientPalette = readonly [string, string, string, string];

export interface AmbientPresetPalettes {
  readonly dark: AmbientPalette;
  readonly light: AmbientPalette;
}

export const AMBIENT_PRESETS: Readonly<Record<string, AmbientPresetPalettes>> = {
  dianqing: {
    dark: ["#3585c9", "#027c91", "#9e6e49", "#575d96"],
    light: ["#89bdef", "#87cedf", "#e3bb9e", "#aab1de"],
  },
  kongquelan: {
    dark: ["#129db0", "#108d7f", "#437aa6", "#9f6d53"],
    light: ["#7bd0df", "#8cd5c8", "#92bde2", "#e6bda9"],
  },
  biqing: {
    dark: ["#329ab4", "#178c89", "#5476a3", "#9a7956"],
    light: ["#8bd0e5", "#91d6d3", "#9fbde4", "#e1c5a8"],
  },
  zhulv: {
    dark: ["#199d78", "#0b8c8d", "#6b8c57", "#97724d"],
    light: ["#89d3b6", "#82cdcd", "#b6d1a6", "#dfc1a6"],
  },
  luweilv: {
    dark: ["#849a49", "#478b61", "#987c41", "#436e8e"],
    light: ["#bed096", "#a0d2b1", "#dfc89a", "#9cc0db"],
  },
  zhuhong: {
    dark: ["#cc624a", "#bc7c40", "#a45160", "#2b728c"],
    light: ["#f1a492", "#eebc92", "#e29fa9", "#91c3d8"],
  },
  haitanghong: {
    dark: ["#c95b63", "#ad5a87", "#b3754f", "#257488"],
    light: ["#f1a2a4", "#e1a1c1", "#edbb9e", "#8fc5d4"],
  },
  meiguihong: {
    dark: ["#bc5580", "#98599a", "#b26960", "#27757d"],
    light: ["#e69fb9", "#d1a2d2", "#eeb4ab", "#94c9cf"],
  },
  qinglian: {
    dark: ["#a35899", "#755eac", "#ac6071", "#36788e"],
    light: ["#d8a4d0", "#b9aae5", "#e6abb7", "#93c7da"],
  },
  hupohuang: {
    dark: ["#bd871c", "#c06e41", "#858441", "#2c7191"],
    light: ["#ebc487", "#efb191", "#cbcb9a", "#94c2db"],
  },
  yanyuhui: {
    dark: ["#887858", "#5d748b", "#967a67", "#4e7076"],
    light: ["#cdbfa4", "#abc0d6", "#dac2b2", "#a2c1c7"],
  },
};
