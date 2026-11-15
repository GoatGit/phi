import { describe, expect, it } from "vitest";
import { viewerStatusLabel } from "@/components/terminal/viewerStatus";

describe("viewerStatusLabel", () => {
  it("worker 退出时按退出码说退出，并在没拿到退出码时如实说没有", () => {
    expect(viewerStatusLabel({ state: "exited", exitCode: 0 })).toEqual({
      key: "terminal.viewer.exited",
      options: { code: "0" },
    });
    expect(viewerStatusLabel({ state: "exited", exitCode: null })).toEqual({
      key: "terminal.viewer.exitedNoCode",
    });
  });

  it("还在跑和查不到分成两句话：查不到不能当成还在跑", () => {
    expect(viewerStatusLabel({ state: "alive", exitCode: null })).toEqual({
      key: "terminal.viewer.alive",
    });
    expect(viewerStatusLabel({ state: "unknown", exitCode: null })).toEqual({
      key: "terminal.viewer.unknown",
    });
    // 还没查到第一帧：默认说「查不到」，不要先报一个乐观的「运行中」。
    expect(viewerStatusLabel(null)).toEqual({
      key: "terminal.viewer.unknown",
    });
  });
});
