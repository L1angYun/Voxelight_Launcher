import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NativeNumberFormat = Intl.NumberFormat;
const NativeDateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("reused locale formatters", () => {
  it("formats a complete task list without rebuilding identical number/date formatters for every row", async () => {
    const numbers = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) { return new NativeNumberFormat(locale, options); });
    const dates = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale, options) { return new NativeDateTimeFormat(locale, options); });
    const { formatNumber, formatBytes, formatDate } = await import("./format");
    for (let row = 0; row < 30; row++) {
      expect(formatNumber(1250, "en-US")).toBe("1,250");
      expect(formatBytes(1536, "en-US")).toBe("1.5 KiB");
      expect(formatDate("2026-11-03T00:00:00Z", "en-US")).toBe("Nov 3, 2026");
    }
    expect(numbers).toHaveBeenCalledTimes(2);
    expect(dates).toHaveBeenCalledTimes(1);
  });

  it("keeps locale and option semantics while reusing reordered equivalent options", async () => {
    const numbers = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) { return new NativeNumberFormat(locale, options); });
    const { formatNumber, formatDate } = await import("./format");
    expect(formatNumber(1.234, "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("1.23");
    expect(formatNumber(1.236, "en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })).toBe("1.24");
    expect(numbers).toHaveBeenCalledTimes(1);
    expect(formatNumber(1.234, "en-US", { maximumFractionDigits: 1 })).toBe("1.2");
    expect(formatDate("2026-11-03T00:00:00Z", "zh-CN")).toBe("2026年11月3日");
    expect(formatDate("2026-11-03T00:00:00Z", "en-US", { dateStyle: "short", timeZone: "America/Los_Angeles" })).toBe("11/2/26");
    expect(formatDate("invalid", "en-US")).toBe("—");
  });

  it("bounds retained formatters and rebuilds an evicted option set", async () => {
    const numbers = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) { return new NativeNumberFormat(locale, options); });
    const { formatNumber } = await import("./format");
    for (let index = 0; index < 65; index++) formatNumber(1, "en-US", {
      minimumFractionDigits: index % 21, maximumFractionDigits: index % 21, minimumIntegerDigits: Math.floor(index / 21) + 1,
    });
    expect(numbers).toHaveBeenCalledTimes(65);
    expect(formatNumber(1, "en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0, minimumIntegerDigits: 1 })).toBe("1");
    expect(numbers).toHaveBeenCalledTimes(66);
  });
});
