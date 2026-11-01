// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

let shouldThrow = true;

function FragilePage() {
  if (shouldThrow) throw new Error("Synthetic page failure");
  return <h1>Recovered page</h1>;
}

describe("PageErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    shouldThrow = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps a page-local failure visible and allows a retry", async () => {
    await act(async () => {
      root.render(
        <PageErrorBoundary
          page="library"
          title="Something went wrong"
          description="This page could not be displayed."
          retryLabel="Retry"
        >
          <FragilePage />
        </PageErrorBoundary>,
      );
    });

    const fallback = container.querySelector<HTMLElement>("[data-page-error]");
    expect(fallback?.dataset.pageError).toBe("library");
    expect(fallback?.textContent).toContain("Synthetic page failure");

    shouldThrow = false;
    await act(async () => {
      fallback?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(container.textContent).toContain("Recovered page");
    expect(container.querySelector("[data-page-error]")).toBeNull();
  });
});
