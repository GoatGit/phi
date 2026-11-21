import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { RotateCcw, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettingsQuery } from "@/lib/query";
import { settingsApi } from "@/lib/api";
import { markSeen } from "@/lib/whatsNew";

/** 一条「会发生什么」：图标 + 一句结论 + 一句解释 */
function NoticePoint({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-panel bg-subtle px-3.5 py-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-control bg-surface text-fg-3">
        {icon}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-strong text-fg-1">{title}</p>
        <p className="text-body leading-relaxed text-fg-2">{body}</p>
      </div>
    </div>
  );
}

/** 首次运行欢迎提示：仅当后端启动阶段保留 firstRunNoticeConfirmed 为空时弹出。 */
export function FirstRunNoticeDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();

  // 后端启动时已经决定好要不要弹：条件不满足的话字段会立即被写成 true，
  // 所以前端这里只需要判空即可——与其他既有确认标记的模式一致。
  const isOpen = settings != null && settings.firstRunNoticeConfirmed !== true;

  const handleAcknowledge = async () => {
    if (!settings) return;
    try {
      // 新装用户看的就是新界面、新版本，「界面改版了」弹窗和更新摘要一并记成已看过
      const version = await getVersion().catch(() => undefined);
      await settingsApi.save({
        ...settings,
        firstRunNoticeConfirmed: true,
        newLayoutNoticeConfirmed: true,
        whatsNewSeenVersion: markSeen(settings.whatsNewSeenVersion, version),
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("Failed to save firstRunNoticeConfirmed:", error);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) void handleAcknowledge();
      }}
    >
      <DialogContent className="max-w-md" zIndex="top">
        <DialogHeader>
          <DialogTitle>{t("firstRunNotice.title")}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t("firstRunNotice.lead")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-6 pb-5 pt-1">
          <NoticePoint
            icon={<ShieldCheck className="h-4 w-4" />}
            title={t("firstRunNotice.keepTitle")}
            body={t("firstRunNotice.keepBody")}
          />
          <NoticePoint
            icon={<RotateCcw className="h-4 w-4" />}
            title={t("firstRunNotice.officialTitle")}
            body={t("firstRunNotice.officialBody")}
          />
        </div>
        <DialogFooter>
          <Button onClick={handleAcknowledge}>
            {t("firstRunNotice.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
