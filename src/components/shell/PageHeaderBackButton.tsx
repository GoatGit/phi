import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";

/** 顶栏标题左侧的返回按钮：FullScreenPanel、设置页与各下钻页共用同一样式。 */
export function PageHeaderBackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <HoverTip content={label ?? t("nav.back")}>
      <Button
        type="button"
        variant="quiet"
        size="icon-compact"
        className="h-8 w-8"
        onClick={onClick}
        aria-label={label ?? t("nav.back")}
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
      </Button>
    </HoverTip>
  );
}
