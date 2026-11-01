import { Box, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Instance } from "../../lib/launcher";
import { AnchoredListbox, type ListboxOption } from "../../components/ui/AnchoredListbox";

export function InstancePicker({ instance, instances, versionId, onSelectInstance }: {
  instance?: Instance; instances: Instance[]; versionId?: string; onSelectInstance: (id?: string) => void;
}) {
  const { t } = useTranslation();
  const options: ListboxOption[] = instances.map((item) => ({
    value: item.id, label: item.name, icon: <Box size={18} aria-hidden="true" />,
    metadata: [item.versionId, !item.loader || item.loader === "vanilla" ? t("home:vanilla")
      : [item.loader, item.loaderVersion].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
    dataAttributes: { "data-instance-id": item.id },
  }));
  options.push({ value: "", label: t("home:versionDirectory"), metadata: versionId,
    icon: <FolderOpen size={18} aria-hidden="true" />, dataAttributes: { "data-version-directory": "" } });
  return <AnchoredListbox id="home-instance" embedded value={instance?.id ?? ""} options={options}
    aria-label={t("home:instance")} onChange={(value) => onSelectInstance(value || undefined)} minimumMenuWidth={320}
    triggerClassName="vx-instance-picker__trigger" popupClassName="vx-instance-picker__popover" />;
}
