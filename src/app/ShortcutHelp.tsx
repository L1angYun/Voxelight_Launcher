import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import type { NavigationPage } from "./FloatingNav";
import { shortcutPages } from "./useShortcuts";
import "./tour.css";

/** One action, reachable by one or more key combinations. */
interface ShortcutEntry {
  combos: string[][];
  label: string;
}

interface ShortcutGroup {
  id: "navigation" | "general";
  entries: ShortcutEntry[];
}

export function ShortcutHelp({
  open,
  onOpenChange,
  onShowTour,
  implemented,
  canShowTour = true,
  showAssistant = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowTour: () => void;
  implemented: ReadonlySet<NavigationPage>;
  canShowTour?: boolean;
  showAssistant?: boolean;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const ctrl = t("shell:shortcuts.keys.ctrl");
  const pages = shortcutPages(implemented);
  const goTo = (page: string) => t("shell:shortcuts.actions.goTo", { page });
  // A page with two shortcuts (Settings: Ctrl+7 and Ctrl+,) is one action, so
  // it is listed once with both key combinations.
  const navigation: ShortcutEntry[] = pages.map((item, index) => ({
    combos: [[ctrl, String(index + 1)], ...(item.id === "settings" ? [[ctrl, ","]] : [])],
    label: goTo(t(item.labelKey)),
  }));
  const general: ShortcutEntry[] = [
    ...(showAssistant ? [{ combos: [[ctrl, "K"]], label: t("shell:shortcuts.actions.assistant") }] : []),
    { combos: [[ctrl, "F"]], label: t("shell:shortcuts.actions.search") },
    { combos: [["?"], [t("shell:shortcuts.keys.f1")]], label: t("shell:shortcuts.actions.help") },
  ];
  const groups: ShortcutGroup[] = [
    { id: "navigation", entries: navigation },
    { id: "general", entries: general },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell:shortcuts.title")}
      description={t("shell:shortcuts.description")}
      closeLabel={t("common:a11y.closeDialog")}
      className="vx-shortcuts-dialog"
      footer={
        <Button variant="secondary" disabled={!canShowTour} onClick={() => {
          onOpenChange(false);
          onShowTour();
        }}>
          {t("shell:tour.showAgain")}
        </Button>
      }
    >
      <div className="vx-shortcut-help">
        {groups.filter((group) => group.entries.length > 0).map((group) => (
          <section className="vx-shortcut-help__group" key={group.id} data-shortcut-group={group.id}
            aria-labelledby={`${headingId}-${group.id}`}>
            <h3 className="vx-shortcut-help__heading" id={`${headingId}-${group.id}`}>
              {t(`shell:shortcuts.groups.${group.id}`)}
            </h3>
            <dl className="vx-shortcut-help__list">
              {group.entries.map((entry) => (
                <div className="vx-shortcut-help__row" key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd>
                    {entry.combos.map((combo, comboIndex) => (
                      <span className="vx-shortcut-help__combo" key={combo.join("+")}>
                        {comboIndex > 0 ? <span className="vx-shortcut-help__or">{t("shell:shortcuts.or")}</span> : null}
                        {combo.map((key, keyIndex) => (
                          <span className="vx-shortcut-help__key" key={`${key}-${keyIndex}`}>
                            {keyIndex > 0 ? <span className="vx-shortcut-help__plus" aria-hidden="true">+</span> : null}
                            <kbd>{key}</kbd>
                          </span>
                        ))}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
