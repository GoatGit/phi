import type { WorkerSnapshot } from "@/lib/api/superAgent";

/**
 * 查看器页脚要写的那句话。
 *
 * 为什么需要单独一层：查看器窗格跑的是 `zellij attach` 客户端，它**会一直活着**，
 * 哪怕里面的 worker 早就退出了。直接把窗格的 phase 当状态贴出来，就会在一块写着
 * `EXIT CODE: 0` 的画面下面顶着「运行中」。所以这里只描述 worker，并且明确写清
 * 「关掉这个窗口不会结束任务」——这句话本身就是查看器的价值。
 */
export interface ViewerLabel {
  key: string;
  options?: { code?: string };
}

export function viewerStatusLabel(
  snapshot: WorkerSnapshot | null | undefined,
): ViewerLabel {
  if (!snapshot) {
    return { key: "terminal.viewer.unknown" };
  }
  if (snapshot.state === "exited") {
    // 退出码可能就是 null（进程被外部杀掉、journal 没写成）：不编一个 0。
    return snapshot.exitCode === null
      ? { key: "terminal.viewer.exitedNoCode" }
      : {
          key: "terminal.viewer.exited",
          options: { code: String(snapshot.exitCode) },
        };
  }
  if (snapshot.state === "alive") {
    return { key: "terminal.viewer.alive" };
  }
  return { key: "terminal.viewer.unknown" };
}
