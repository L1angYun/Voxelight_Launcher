export type LauncherErrorParams = Record<string, unknown>;

export class LauncherError extends Error {
  readonly code: string;
  readonly params: LauncherErrorParams;
  readonly detail?: string;

  constructor(code: string, params: LauncherErrorParams = {}, detail?: string) {
    super(detail ?? code);
    this.name = "LauncherError";
    this.code = code;
    this.params = { ...params };
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSerialized(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function normalizeError(error: unknown): LauncherError {
  if (error instanceof LauncherError) return error;
  const value = parseSerialized(error);
  const record = objectValue(value);
  if (record) {
    const code = typeof record.code === "string" ? record.code : undefined;
    const detail =
      typeof record.detail === "string"
        ? record.detail
        : typeof record.message === "string"
          ? record.message
          : undefined;
    if (code) {
      return new LauncherError(code, objectValue(record.params) ?? {}, detail);
    }
    if (detail) return new LauncherError("internal.unexpected", {}, detail);
  }
  if (value instanceof Error) {
    return new LauncherError("internal.unexpected", {}, value.message);
  }
  if (typeof value === "string") {
    return new LauncherError("internal.unexpected", {}, value);
  }
  return new LauncherError("internal.unexpected", {}, "Unknown launcher error");
}
