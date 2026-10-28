import { describe, expect, it } from "vitest";
import { LauncherError, normalizeError } from "./errors";

describe("structured launcher errors", () => {
  it("preserves stable codes and parameters", () => {
    const error = normalizeError({
      code: "instance.running",
      params: { id: "fixture" },
      detail: "旧实例正在运行",
    });
    expect(error).toBeInstanceOf(LauncherError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("instance.running");
    expect(error.params).toEqual({ id: "fixture" });
    expect(error.detail).toBe("旧实例正在运行");
    expect(error.message).toBe("旧实例正在运行");
  });

  it("accepts serialized IPC errors", () => {
    const error = normalizeError(JSON.stringify({ code: "auth.required", params: {} }));
    expect(error.code).toBe("auth.required");
  });

  it("hides legacy details behind an unexpected-error code", () => {
    const error = normalizeError("旧内部错误");
    expect(error.code).toBe("internal.unexpected");
    expect(error.detail).toBe("旧内部错误");
    expect(error.message).toBe("旧内部错误");
  });

  it("normalizes native errors and empty values", () => {
    expect(normalizeError(new Error("network failed")).code).toBe("internal.unexpected");
    expect(normalizeError(null).message).not.toBe("");
  });
});
