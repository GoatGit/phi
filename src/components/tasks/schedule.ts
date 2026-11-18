import type { TFunction } from "i18next";
import type { TaskSchedule } from "@/lib/api/tasks";

/**
 * 排期在界面上的说法。
 *
 * 卡片里存的是机器可读的规则（`recurrence: 2h` / `schedule: 09:30`），
 * 界面要说成人话；两者之间的换算只放在这里，别在两个组件里各写一套。
 */

export type ScheduleKind = "none" | "interval" | "daily" | "once";

export function scheduleKind(schedule: TaskSchedule | null): ScheduleKind {
  return (schedule?.kind as ScheduleKind | undefined) ?? "none";
}

/** 分钟数 → 编辑器里的简写（120 → `2h`，45 → `45m`，1440 → `1d`）。 */
export function intervalText(minutes: number | null): string {
  if (!minutes) return "";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** 编辑器里的简写 → 分钟数。后端还会再校验一次，这里只做即时反馈。 */
export function parseIntervalText(value: string): number | null {
  const text = value.trim().toLowerCase();
  const match =
    /^(\d+)\s*(m|min|mins|h|hr|hour|hours|d|day|days|分钟|小时|天)?$/.exec(
      text,
    );
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2] ?? "m";
  if (unit.startsWith("h") || unit === "小时") return number * 60;
  if (unit.startsWith("d") || unit === "天") return number * 24 * 60;
  return number;
}

/**
 * 编辑器里的时刻 → `HH:MM`（`9:5` 也认，补成 `09:05`）。
 *
 * `at` 存的是归一化后的 `YYYY-MM-DD HH:MM`，界面只让人挑日期和时分两个部分，
 * 拼回字符串仍由这里做，好让「选出来的值」和「后端能解析的值」是同一个。
 */
export function normalizeClock(value: string): string | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` → `2026-11-20 09:30`；日期不合法时返回 null。 */
export function composeMoment(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const clock = normalizeClock(time);
  if (!clock) return null;
  return `${date.trim()} ${clock}`;
}

/** `2026-11-20 09:30` → `{ date, time }`，给日期、时间两个输入框回填。 */
export function splitMoment(at: string | null | undefined): {
  date: string;
  time: string;
} {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(
    (at ?? "").trim(),
  );
  if (!match) return { date: "", time: "" };
  return {
    date: match[1],
    time: match[2] ? `${pad(Number(match[2]))}:${match[3]}` : "",
  };
}

/** 本机时区的 `YYYY-MM-DD`，用作日期输入框的初值。 */
export function todayDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 本机时区的 `HH:MM`。 */
export function currentClock(now: Date = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 卡片上那个小标签：一眼看出这是持续任务还是定时任务。 */
export function scheduleLabel(
  t: TFunction,
  schedule: TaskSchedule | null,
): string | null {
  switch (scheduleKind(schedule)) {
    case "interval": {
      const minutes = schedule?.minutes ?? 0;
      if (minutes % 1440 === 0)
        return t("tasks.schedule.everyDays", { count: minutes / 1440 });
      if (minutes % 60 === 0)
        return t("tasks.schedule.everyHours", { count: minutes / 60 });
      return t("tasks.schedule.everyMinutes", { count: minutes });
    }
    case "daily":
      return t("tasks.schedule.daily", { time: schedule?.time ?? "" });
    case "once":
      return t("tasks.schedule.once", { at: schedule?.at ?? "" });
    default:
      return null;
  }
}

/** 「下次什么时候跑」/「已经到点」。时间戳由后端按本机时区算好。 */
export function nextRunLabel(
  t: TFunction,
  schedule: TaskSchedule | null,
  now: number = Date.now(),
): string | null {
  const at = schedule?.nextRunAt;
  if (!at) return null;
  if (at <= now) return t("tasks.schedule.due");
  return t("tasks.schedule.next", { time: formatStamp(at) });
}

export function formatStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 产物大小：只给一个能比较的量级，不假装精确到字节。 */
export function formatBytes(size: number | null): string | null {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
