import type { Locator, Page } from "@playwright/test";

export async function selectValue(page: Page, label: string, value: string, scope?: Locator) {
  const trigger = (scope ?? page).getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  const menu = page.getByRole("listbox", { name: label, exact: true });
  await menu.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}
