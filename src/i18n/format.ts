import { resolveLocale } from "./index";

const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
const formatterLimit = 64;

function cachedFormatter<T>(cache: Map<string, T>, locale: string, options: object | undefined, create: () => T): T {
  // Exotic option objects retain Intl's normal getter/coercion behavior.
  const prototype = options && Object.getPrototypeOf(options);
  if (options && prototype !== Object.prototype && prototype !== null) return create();
  const entries = Object.entries(Object.getOwnPropertyDescriptors(options ?? {}));
  if (entries.some(([, property]) => !('value' in property) ||
    (property.value !== undefined && !["string", "number", "boolean"].includes(typeof property.value)))) return create();
  const key = JSON.stringify([locale, entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, property]) => property.value !== undefined).map(([name, property]) => [name, property.value])]);
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const formatter = create();
  cache.set(key, formatter);
  if (cache.size > formatterLimit) cache.delete(cache.keys().next().value!);
  return formatter;
}

export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  const resolved = resolveLocale(locale, locale);
  return cachedFormatter(numbers, resolved, options, () => new Intl.NumberFormat(resolved, options)).format(value);
}

export function formatDate(
  value: Date | number | string,
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const resolved = resolveLocale(locale, locale);
  const settings: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeZone: "UTC",
    ...options,
  };
  return cachedFormatter(dates, resolved, settings, () => new Intl.DateTimeFormat(resolved, settings)).format(date);
}

export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })} ${units[unit]}`;
}
