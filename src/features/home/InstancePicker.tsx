import { Box } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Instance } from "../../lib/launcher";
import { AnchoredListbox, type ListboxOption } from "../../components/ui/AnchoredListbox";

export function InstancePicker({ instance, instances, onSelectInstance, onOpenChange }: {
  instance?: Instance; instances: Instance[]; onSelectInstance: (id?: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const listSeparator = /^(?:zh|ja)/i.test(i18n.language) ? "、" : ", ";
  const options: ListboxOption[] = instances.map((item) => ({
    value: item.id, label: item.name, icon: <Box size={18} aria-hidden="true" />,
    metadata: [item.versionId, !item.loader || item.loader === "vanilla" ? t("home:vanilla")
      : [item.loader, item.loaderVersion].filter(Boolean).join(" ")].filter(Boolean).join(listSeparator),
    dataAttributes: { "data-instance-id": item.id },
  }));
  return <AnchoredListbox id="home-instance" material="glass" embedded value={instance?.id ?? ""} options={options}
    aria-label={t("home:instance")} onChange={(value) => onSelectInstance(value || undefined)} onOpenChange={onOpenChange} minimumMenuWidth={320}
    triggerClassName="vx-instance-picker__trigger" popupClassName="vx-instance-picker__popover" />;
}
