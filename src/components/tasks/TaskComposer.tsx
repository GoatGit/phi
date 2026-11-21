import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  INTERVAL_UNITS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  SCHEDULE_MODES,
  UNIT_MINUTES,
  composeMoment,
  normalizeClock,
  todayDate,
  type IntervalUnit,
  type ScheduleKind,
} from "./schedule";

/** 新建时选的任务类型：直接换成落盘要写的两个字段，`null` 表示这一项不写。 */
export interface NewTaskTiming {
  recurrence: string | null;
  schedule: string | null;
}

export interface TaskTimingState {
  mode: ScheduleKind;
  setMode: (mode: ScheduleKind) => void;
  amount: number | "";
  setAmount: (value: number | "") => void;
  unit: IntervalUnit;
  setUnit: (unit: IntervalUnit) => void;
  date: string;
  setDate: (value: string) => void;
  time: string;
  setTime: (value: string) => void;
  /** 类型没选完（比如定时任务还没填时刻）就不该提交，省得建出一张不会跑的卡。 */
  valid: boolean;
  /** 落盘用的两个字段；讨论模式不用它。 */
  timing: () => NewTaskTiming;
  /** 建完回到「不重复」：下一张卡不该默默继承上一张的排期。 */
  reset: () => void;
}

/**
 * 任务类型（排期）的状态。
 *
 * 新建任务的入口有两处——看板列头、智能体行里的 +——两处都要能选类型，
 * 所以状态与控件各写一份在这里，两个入口只是外壳不同。
 */
export function useTaskTiming(): TaskTimingState {
  const [mode, setModeState] = useState<ScheduleKind>("none");
  const [amount, setAmount] = useState<number | "">(30);
  const [unit, setUnit] = useState<IntervalUnit>("m");
  const [date, setDate] = useState(todayDate);
  const [time, setTime] = useState("");

  const minutes =
    mode === "interval" ? Number(amount) * UNIT_MINUTES[unit] : null;
  const clock = normalizeClock(time);
  const moment = mode === "once" ? composeMoment(date, time) : null;
  const valid =
    mode === "none" ||
    (mode === "interval"
      ? Number.isInteger(amount) &&
        minutes !== null &&
        minutes >= MIN_INTERVAL_MINUTES &&
        minutes <= MAX_INTERVAL_MINUTES
      : mode === "daily"
        ? clock !== null
        : moment !== null);

  const setMode = (next: ScheduleKind) => {
    setModeState(next);
    // 切类型时只清掉不属于新类型的部分，避免把刚填的值丢掉
    if (next !== "interval") {
      setAmount(30);
      setUnit("m");
    }
    if (next === "none") setTime("");
    if (next === "once" && !date) setDate(todayDate());
  };

  return {
    mode,
    setMode,
    amount,
    setAmount,
    unit,
    setUnit,
    date,
    setDate,
    time,
    setTime,
    valid,
    timing: () =>
      mode === "interval"
        ? { recurrence: `${amount}${unit}`, schedule: null }
        : mode === "daily"
          ? { recurrence: null, schedule: clock }
          : mode === "once"
            ? { recurrence: null, schedule: moment }
            : { recurrence: null, schedule: null },
    reset: () => {
      setModeState("none");
      setAmount(30);
      setUnit("m");
      setDate(todayDate());
      setTime("");
    },
  };
}

/**
 * 任务类型的三个控件：只选一个下拉，持续任务 / 定时任务才多出必需的那两个小控件。
 *
 * 排期不能等到建完卡再进详情页补：那总是多一步，而这一步本来就该在新建时完成。
 */
export function ScheduleFields({
  timing,
  pending = false,
}: {
  timing: TaskTimingState;
  pending?: boolean;
}) {
  const { t } = useTranslation();
  const {
    mode,
    setMode,
    amount,
    setAmount,
    unit,
    setUnit,
    date,
    setDate,
    time,
    setTime,
    valid,
  } = timing;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption text-fg-3">
        {t("tasks.schedule.title")}
      </span>
      <Select
        value={mode}
        onValueChange={(nextMode) => setMode(nextMode as ScheduleKind)}
        disabled={pending}
      >
        <SelectTrigger
          className="h-7 w-[118px] text-caption"
          aria-label={t("tasks.schedule.title")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_MODES.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`tasks.schedule.mode.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === "interval" ? (
        <span className="inline-flex items-center gap-1.5">
          <Input
            type="number"
            min={1}
            max={MAX_INTERVAL_MINUTES / UNIT_MINUTES[unit]}
            step={1}
            aria-invalid={!valid}
            className="h-7 w-[64px] text-center text-caption"
            value={amount}
            aria-label={t("tasks.schedule.intervalAmount")}
            disabled={pending}
            onChange={(event) => {
              const value = event.target.value;
              setAmount(value === "" ? "" : Number(value));
            }}
          />
          <Select
            value={unit}
            onValueChange={(nextUnit) => setUnit(nextUnit as IntervalUnit)}
            disabled={pending}
          >
            <SelectTrigger
              className="h-7 w-[86px] text-caption"
              aria-label={t("tasks.schedule.intervalUnit")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_UNITS.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`tasks.schedule.unit.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      ) : null}
      {mode === "daily" || mode === "once" ? (
        <span className="inline-flex items-center gap-1.5">
          {mode === "once" ? (
            <Input
              type="date"
              className="h-7 w-[138px] text-caption"
              value={date}
              aria-label={t("tasks.schedule.dateLabel")}
              disabled={pending}
              onChange={(event) => setDate(event.target.value)}
            />
          ) : null}
          <Input
            type="time"
            step={60}
            aria-invalid={!valid}
            className="h-7 w-[104px] text-caption"
            value={time}
            aria-label={t("tasks.schedule.timeLabel")}
            disabled={pending}
            onChange={(event) => setTime(event.target.value)}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * 看板列头的快速新建：Ctrl+Enter 或点发送才提交，避免输入法误发。
 *
 * 默认「不重复」，不选就与以前一样是一张普通卡。
 */
export function NewTaskComposer({
  onCreate,
  onDiscuss,
}: {
  onCreate: (title: string, timing: NewTaskTiming) => Promise<boolean>;
  /** 一句话成卡并直接进入讨论；为空表示当前平台开不了会话 */
  onDiscuss?: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  /** 讨论模式：只写一句话，不选任务类型（还在讨论就不该先排期） */
  const [discuss, setDiscuss] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const timing = useTaskTiming();
  const optionalDiscuss = onDiscuss;

  const submit = async () => {
    const value = title.trim();
    if (!value || pending || !timing.valid) return;
    if (discuss) {
      if (!optionalDiscuss) return;
      setPending(true);
      try {
        // 讨论卡建好会直接打开详情，这里就没必要保留一张空输入框
        if (await optionalDiscuss(value)) {
          setTitle("");
          setDiscuss(false);
          timing.reset();
          setOpen(false);
        }
      } finally {
        setPending(false);
      }
      return;
    }
    setPending(true);
    try {
      if (await onCreate(value, timing.timing())) {
        setTitle("");
        timing.reset();
      }
    } finally {
      setPending(false);
    }
  };

  // 一屏只留一个视觉落点：「新建任务」像一张等着填的卡（实线 + 白底），
  // 「讨论一下」是次要动作，只靠文字与图标，不再和它抢同一份重量。
  const entryBase =
    "flex items-center gap-1.5 rounded-control px-2.5 py-2 text-caption transition-[color,background-color,box-shadow]";
  const primaryEntry = cn(
    entryBase,
    "border border-border-strong bg-surface text-fg-1 shadow-v7-sm hover:shadow-v7-card-hover",
  );
  const secondaryEntry = cn(
    entryBase,
    "text-fg-2 hover:bg-surface hover:text-fg-1",
  );

  if (!open) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setDiscuss(false);
            setOpen(true);
          }}
          className={cn(primaryEntry, "min-w-0 flex-1")}
        >
          <Plus
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
            strokeWidth={1.5}
          />
          {t("tasks.newTask")}
        </button>
        {/* 想法还没成形时走这里：建一张讨论中的卡 */}
        {onDiscuss ? (
          <button
            type="button"
            onClick={() => {
              setDiscuss(true);
              timing.reset();
              setOpen(true);
            }}
            className={cn(secondaryEntry, "shrink-0")}
          >
            <MessageSquare
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0"
              strokeWidth={1.5}
            />
            {t("tasks.discussion.start")}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="space-y-1.5"
      onBlur={(event) => {
        // 选类型会打开下拉浮层（内容在 portal 里），那种失焦不算离开。
        const next = event.relatedTarget as HTMLElement | null;
        if (
          next &&
          (event.currentTarget.contains(next) ||
            next.closest("[data-radix-popper-content-wrapper]"))
        )
          return;
        // 什么都没填就收起；已经写了字或选了类型就不丢内容
        if (!title.trim() && timing.mode === "none") setOpen(false);
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={title}
          aria-label={
            discuss ? t("tasks.discussion.start") : t("tasks.newTask")
          }
          placeholder={
            discuss
              ? t("tasks.discussion.newPlaceholder")
              : t("tasks.newTaskPlaceholder")
          }
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              event.ctrlKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              setTitle("");
              setDiscuss(false);
              setOpen(false);
            }
          }}
        />
        <HoverTip
          content={
            discuss ? t("tasks.discussion.start") : t("tasks.newTaskSend")
          }
        >
          <Button
            variant="solid"
            size="icon-compact"
            aria-label={
              discuss ? t("tasks.discussion.start") : t("tasks.newTaskSend")
            }
            disabled={!title.trim() || pending || !timing.valid}
            onClick={() => void submit()}
          >
            {discuss ? (
              <MessageSquare
                data-icon
                className="h-3.5 w-3.5"
                strokeWidth={1.5}
              />
            ) : (
              <Send data-icon className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </Button>
        </HoverTip>
      </div>
      {discuss ? (
        <p className="m-0 text-caption leading-relaxed text-fg-3">
          {t("tasks.discussion.newHint")}
        </p>
      ) : null}
      {/* 讨论模式不渲染任务类型：还在讨论就先不排期，也不给一个选了会被忽略的控件 */}
      {discuss ? null : <ScheduleFields timing={timing} pending={pending} />}
    </div>
  );
}
