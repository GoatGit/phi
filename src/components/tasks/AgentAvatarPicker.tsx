import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  AGENT_AVATAR_KEYS,
  AgentAvatar,
  agentAvatarKey,
  agentAvatarSource,
  isAgentAvatarKey,
} from "./AgentAvatar";

interface AgentAvatarPickerProps {
  agentId: string;
  /** 只用于无障碍标签：按钮要说清换的是谁的头像。 */
  agentName: string;
  /** 当前选过的键；空 = 按 id 派生。 */
  avatar?: string | null;
  size?: number;
  /** 选中一张就落盘；传空串表示「回到按 id 派生」。 */
  onPick: (avatar: string) => void;
}

/**
 * 点开头像换一张。
 *
 * 换一张是配置动作，就地完成：弹出十六张、点一张即保存，不绕进编辑弹窗——
 * 那里面躺着十几个文本字段，只为换张脸翻一遍表不划算。
 */
export function AgentAvatarPicker({
  agentId,
  agentName,
  avatar,
  size = 32,
  onPick,
}: AgentAvatarPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = agentAvatarKey(agentId, avatar);
  // 没显式选过就没有「默认」可回：按钮会点了没反应。
  const picked = Boolean(avatar && isAgentAvatarKey(avatar));

  const choose = (next: string) => {
    onPick(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("tasks.agentView.avatarSet", { name: agentName })}
          title={t("tasks.agentView.avatarSet", { name: agentName })}
          className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-action"
        >
          <AgentAvatar agentId={agentId} avatar={avatar} size={size} />
          {/* 悬停/聚焦时才提示「这里能点」，常驻描边会把头像画成一张卡片。 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-transparent transition-colors group-hover:ring-action group-focus-visible:ring-action"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[212px] p-2">
        <p className="m-0 px-1 pb-1.5 text-[11px] text-fg-3">
          {t("tasks.agentView.avatarTitle")}
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {AGENT_AVATAR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === current}
              aria-label={t("tasks.agentView.avatarPick", { key })}
              onClick={() => choose(key)}
              className={cn(
                "rounded-full p-0.5 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-action",
                key === current
                  ? "ring-2 ring-action"
                  : "ring-1 ring-transparent hover:ring-border",
              )}
            >
              <img
                src={agentAvatarSource(key)}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="block size-11 rounded-full object-cover"
              />
            </button>
          ))}
        </div>
        {picked ? (
          <button
            type="button"
            onClick={() => choose("")}
            className="mt-2 w-full rounded-control px-1 py-1 text-start text-[11px] text-fg-3 hover:bg-subtle hover:text-fg-1"
          >
            {t("tasks.agentView.avatarReset")}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
