import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** 侧栏空状态提示只停留这么久，之后自己消失，不长期占位。 */
export const EMPTY_APPS_HINT_MS = 5000;

/**
 * 「还没有添加应用」：侧栏一个应用都没有时出现，5 秒后自动消失。
 * 侧栏只有 200px 宽，所以文字按容器宽度换行，任何语言都不会被裁到边界外。
 */
export function SidebarEmptyHint({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!visible) {
      // 重新有应用时复位，下次变空能立刻再提示一次。
      setDismissed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDismissed(true),
      EMPTY_APPS_HINT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible || dismissed) return null;
  return (
    <p className="mx-2 mb-1 whitespace-normal break-words px-2 text-caption leading-5 text-fg-3">
      {t("nav.emptyAppsHint")}
    </p>
  );
}
