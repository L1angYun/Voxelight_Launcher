import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import type { NavigationPage } from "./FloatingNav";
import { shortcutPages } from "./useShortcuts";
import "./tour.css";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

export function ShortcutHelp({
  open,
  onOpenChange,
  onShowTour,
  implemented,
  canShowTour = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowTour: () => void;
  implemented: ReadonlySet<NavigationPage>;
  canShowTour?: boolean;
}) {
  const { t } = useTranslation();
  const ctrl = t("shell:shortcuts.keys.ctrl");
  const pages = shortcutPages(implemented);
  const goTo = (page: string) => t("shell:shortcuts.actions.goTo", { page });
  const entries: ShortcutEntry[] = [
    ...pages.map((item, index) => ({
      keys: [ctrl, String(index + 1)],
      label: goTo(t(item.labelKey)),
    })),
    ...(pages.some((item) => item.id === "settings")
      ? [{ keys: [ctrl, ","], label: goTo(t("navigation.settings")) }]
      : []),
    { keys: [ctrl, "F"], label: t("shell:shortcuts.actions.search") },
    { keys: ["?"], label: t("shell:shortcuts.actions.help") },
    { keys: [t("shell:shortcuts.keys.f1")], label: t("shell:shortcuts.actions.help") },
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
      <dl className="vx-shortcut-help">
        {entries.map((entry, entryIndex) => (
          <div className="vx-shortcut-help__row" key={`${entry.label}-${entryIndex}`}>
            <dt>
              {entry.keys.map((key, keyIndex) => (
                <span className="vx-shortcut-help__key" key={`${key}-${keyIndex}`}>
                  {keyIndex > 0 ? <span className="vx-shortcut-help__plus" aria-hidden="true">+</span> : null}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </dt>
            <dd>{entry.label}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
