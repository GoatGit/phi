import { describe, expect, it } from "vitest";
import {
  composeMoment,
  normalizeClock,
  splitMoment,
  todayDate,
} from "@/components/tasks/schedule";

describe("任务排期的时间组件取值", () => {
  it("时分补零，非法时刻返回 null", () => {
    expect(normalizeClock("9:5")).toBe("09:05");
    expect(normalizeClock("09:30")).toBe("09:30");
    expect(normalizeClock("24:00")).toBeNull();
    expect(normalizeClock("")).toBeNull();
  });

  it("日期 + 时间拼成后端能解析的 2026-11-20 09:30", () => {
    expect(composeMoment("2026-11-20", "09:30")).toBe("2026-11-20 09:30");
    expect(composeMoment("2026-11-20", "9:5")).toBe("2026-11-20 09:05");
    expect(composeMoment("", "09:30")).toBeNull();
    expect(composeMoment("2026-11-20", "")).toBeNull();
  });

  it("已存的时刻能回填到两个输入框", () => {
    expect(splitMoment("2026-11-20 14:05")).toEqual({
      date: "2026-11-20",
      time: "14:05",
    });
    // 旧卡里可能只有日期，不能凭空补一个时间
    expect(splitMoment("2026-11-20")).toEqual({
      date: "2026-11-20",
      time: "",
    });
    expect(splitMoment(null)).toEqual({ date: "", time: "" });
  });

  it("默认日期取本机时区的今天", () => {
    expect(todayDate(new Date(2026, 10, 20, 8, 0))).toBe("2026-11-20");
  });
});
