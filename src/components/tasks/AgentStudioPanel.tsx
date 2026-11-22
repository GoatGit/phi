import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import {
  superAgentApi,
  type AgentStudioTurn,
  type RouterAgent,
} from "@/lib/api/superAgent";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AgentAvatar, ROUTER_AVATAR_ID } from "./AgentAvatar";

interface AgentStudioPanelProps {
  /**
   * Router 自己的头像键；空 = 按固定 id 派生。
   *
   * 与看板讨论区那一行取同一份设置：同一个 Router 在两处是同一张脸，
   * 而不是一边是头像、一边换成一个通用的星形图标。
   */
  routerAvatar?: string;
  /**
   * 草稿将来用哪个应用执行。
   *
   * 这一轮对话本身跑的是调度模型，不看应用；应用只决定草稿里的 `appId`。
   * 所以这里直接取编辑器里已经选好的那个，不再单独给一个下拉——同一个弹窗里
   * 两个「应用」长得一样、含义不同，只会让人以为选错了。
   */
  appId: string;
  /**
   * 右栏此刻那一版。
   *
   * 每一轮都把它交给模型：多说一句「再加一条约束」时，模型得看着现在这份改，
   * 而不是凭对话记忆重写一遍，把人已经改过的地方冲掉。
   */
  current: RouterAgent;
  /**
   * 左右两侧共用的版本锚点：右栏正在看的那一版。
   *
   * 靠它把两边的「第几版」连起来——点左栏的徽标，右栏跟着换；在右栏切版，
   * 对应的那一轮发言跟着亮。
   */
  activeVersion: number;
  /** 右栏正在看历史版本：看的这份不参与保存，但可以接着聊。 */
  previewing: boolean;
  /** 正在看的那一版叫什么，已翻译（「初始」或「第 2 版」）。 */
  previewLabel: string;
  /**
   * 看着旧版直接开口：发送前先以正在看的那一版继续。
   *
   * 看旧版归看旧版——只是看一眼不该改右栏；说过话就是要往下改，
   * 所以“以这一版继续”这件事从按钮变成发送的前一步。
   */
  onContinueFromView: () => void;
  /**
   * 草稿到达：编辑器负责填进字段，保存仍要人点。
   *
   * 返回值是这一版在版本条上的位置与它真的改到的字段名（已翻译），
   * 用来在 timeline 上标出「第 N 版」——多轮优化得看得见，否则只是一串聊天记录。
   */
  onDraft: (
    draft: RouterAgent,
    round: number,
  ) => { version: number; fields: string[] };
  /** 点 timeline 上的版本徽标：右栏切到那一版。 */
  onSelectVersion: (version: number) => void;
  className?: string;
}

/** 一轮发言。`applied` 只在 Router 这一轮带回了草稿时出现。 */
interface StudioTurnView {
  role: "user" | "router";
  text: string;
  applied?: { version: number; fields: string[] };
}

/**
 * 工作室：左侧一条会话，右侧一份草稿，来回几轮把草稿收敛到能用。
 *
 * 它不是弹窗，而是添加智能体弹窗里的一栏。产物仍然只是草稿：模型没有数据库、
 * 没有文件写，回复里那段 `phi-agent` JSON 由 Rust 解析校验后交给编辑器。
 * 所以「模型不能自己造员工」是能力上的边界，不是提示词里的请求。
 */
export function AgentStudioPanel({
  appId,
  routerAvatar = "",
  current,
  activeVersion,
  previewing,
  previewLabel,
  onContinueFromView,
  onDraft,
  onSelectVersion,
  className,
}: AgentStudioPanelProps) {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<StudioTurnView[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 新的一轮进来就把视角带到最新：聊到第三四句时，人不该自己再去滚。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns, busy]);

  // 在右栏切了版本：把对应那一轮带回视野里。反方向的联动只走这一条，
  // 两边都去同步对方就会绕成回环。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeVersion]);

  /**
   * 输入框跟着内容长高，最多到 160px（约六行）。
   *
   * 写清一个岗位常要两三段话，固定两行的高度会让人在一条缝里翻自己的稿子；
   * 到顶之后仍由它自己滚，不会把下面的 timeline 挤没。
   */
  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, 160);
    // 读不到高度（无排版环境）就退回 CSS 的起始高度，不要把框压成 0。
    if (next > 0) element.style.height = `${next}px`;
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    // 正在看旧版也能直接说：这一句就发生在那一版上，右栏跟着切过去，
    // 后面的每一轮都以它为起点，而不是叠在看不见的实时草稿上。
    if (previewing) onContinueFromView();
    // 只把「谁说了什么」发给模型；轮次标记是界面自己的记账。
    const history: AgentStudioTurn[] = turns.map(({ role, text }) => ({
      role,
      text,
    }));
    const round = turns.filter((turn) => turn.role === "user").length + 1;
    setTurns([...turns, { role: "user", text: message }]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "";
    setBusy(true);
    try {
      const reply = await superAgentApi.agentDraft(
        appId,
        history,
        message,
        current,
      );
      let applied: StudioTurnView["applied"];
      if (reply.draft) {
        applied = onDraft(reply.draft, round);
      }
      setTurns((now) => [
        ...now,
        { role: "router", text: reply.reply, applied },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        message.includes("router-model-missing")
          ? t("tasks.router.agentStudioNoModel")
          : t("tasks.router.agentStudioFailed", { error: message }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-panel bg-subtle p-3",
        className,
      )}
    >
      {/* 头像 ｜ 名称：与看板那一行同一套行头，同一个 Router 在两处是同一张脸。
          怎么用它已经写在弹窗标题下那一句里，这里不再重说一遍。 */}
      <header className="flex items-center gap-2">
        <AgentAvatar
          agentId={ROUTER_AVATAR_ID}
          avatar={routerAvatar}
          size={30}
        />
        <h3 className="m-0 min-w-0 text-body font-medium text-fg-1">
          {t("tasks.router.agentStudioTitle")}
        </h3>
      </header>

      <div
        ref={listRef}
        role="log"
        aria-label={t("tasks.router.agentStudioTitle")}
        // 与右栏同一套隐式滚动条：同一个弹层里两栏不该有两种滚动条的脾气。
        className="scroll-implicit flex max-h-[26vh] flex-col gap-2 overflow-y-auto md:max-h-none md:min-h-0 md:flex-1"
      >
        {turns.length === 0 ? (
          // 空对话里这块是「从这里开始」，不是一条落单的提示：靠自身的留白把开头推到中间。
          <p className="m-0 my-auto rounded-control bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-fg-3">
            {t("tasks.router.agentStudioEmpty")}
          </p>
        ) : (
          turns.map((turn, index) => {
            const mine = turn.role === "user";
            const applied = turn.applied;
            const on = applied?.version === activeVersion;
            return (
              <div
                key={`${turn.role}-${index}`}
                ref={on ? activeRef : undefined}
                className={cn(
                  "-mx-1 flex min-w-0 flex-col gap-0.5 rounded-control border-l-2 py-0.5 pl-1.5 pr-1 transition-colors",
                  // 右栏正在看这一版时，这一轮发言左侧留一道竖线：两边看的是同一版。
                  on ? "border-action-text" : "border-transparent",
                )}
              >
                <span className="flex items-center gap-1 px-0.5 text-[10px] leading-none text-fg-3">
                  {/* 谁在说话比说了什么先被读到：Router 每轮都顶着它自己的脸。 */}
                  {mine ? null : (
                    <AgentAvatar
                      agentId={ROUTER_AVATAR_ID}
                      avatar={routerAvatar}
                      size={14}
                      className="border-0"
                    />
                  )}
                  {mine
                    ? t("tasks.router.agentStudioYou")
                    : t("tasks.agentView.routerName")}
                </span>
                <p
                  className={cn(
                    "m-0 max-w-full whitespace-pre-wrap break-words rounded-control px-2.5 py-1.5 text-caption leading-relaxed",
                    mine ? "bg-action-soft text-fg-1" : "bg-surface text-fg-1",
                  )}
                >
                  {turn.text}
                </p>
                {applied ? (
                  <button
                    type="button"
                    aria-pressed={on}
                    title={t("tasks.router.agentStudioViewVersion", {
                      version: t("tasks.router.agentVersionRound", {
                        count: applied.version,
                      }),
                    })}
                    onClick={() => onSelectVersion(applied.version)}
                    className={cn(
                      "mt-0.5 self-start rounded-control px-1.5 py-0.5 text-[10px] leading-4 transition-colors",
                      on
                        ? "bg-action-soft text-action-text"
                        : "text-fg-3 hover:bg-surface hover:text-fg-1",
                    )}
                  >
                    {applied.fields.length === 0
                      ? t("tasks.router.agentVersionRound", {
                          count: applied.version,
                        })
                      : t("tasks.router.agentStudioRoundFields", {
                          count: applied.version,
                          fields: applied.fields.join(
                            t("tasks.router.agentStudioFieldSeparator"),
                          ),
                        })}
                  </button>
                ) : null}
              </div>
            );
          })
        )}
        {busy ? (
          <span className="flex items-center gap-1.5 self-start text-[11px] text-fg-3">
            <Loader2
              aria-hidden="true"
              className="h-3 w-3 animate-spin"
              strokeWidth={1.5}
            />
            {t("tasks.router.agentStudioThinking")}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        {/* 发送键在框里右下角：一列气泡加一个输入框，按钮吊在框外面会把这一列
            撑出第二道边，也不符合「说到一半接着往下写」的用法。 */}
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            rows={4}
            className={cn(
              fieldClass,
              // 四行起步、最长约六行：够写清一个岗位，又不至于把 timeline 挤没。
              // 右侧留出按钮的位置（pe-11），文字不会写到按钮底下。
              // 必须是块级：行内块底下会留一条基线间隙，容器比框高几像素，
              // 右下角的按钮就会压在下边框上，看着像挂到框外面去了。
              // 不覆写字体尺寸与行高：font-size 工具类在样式表里的先后顺序不受
              // className 顺序控制，覆盖会变成两边看运气。
              "block max-h-40 min-h-[96px] resize-none py-2 pe-11",
            )}
            aria-label={t("tasks.router.agentStudioPlaceholder")}
            placeholder={t("tasks.router.agentStudioPlaceholder")}
            disabled={busy}
            onChange={(event) => {
              setInput(event.target.value);
              grow(event.currentTarget);
            }}
            onKeyDown={(event) => {
              // 回车就是换行：一句话常常要分几段说清一个岗位，
              // 一按回车就发出去，只会把人逼成挤在一行里写。
              if (event.key !== "Enter") return;
              if (!event.ctrlKey && !event.metaKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button
            type="button"
            // 框里不再套一个带边框的白方块：那会让框的右下角看起来有两个边。
            variant="ghost"
            size="icon-compact"
            className="absolute bottom-2 end-2"
            aria-label={t("tasks.router.agentStudioSend")}
            title={t("tasks.router.agentStudioSend")}
            disabled={busy || input.trim() === ""}
            onClick={() => void send()}
          >
            <Send data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
        <p
          className={cn(
            "m-0 text-[10px] leading-relaxed",
            previewing ? "text-action-text" : "text-fg-3",
          )}
        >
          {previewing
            ? t("tasks.router.agentStudioPreviewContinue", {
                version: previewLabel,
              })
            : t("tasks.router.agentStudioEnterHint")}
        </p>
      </div>
    </section>
  );
}
