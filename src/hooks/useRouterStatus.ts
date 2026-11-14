import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  superAgentApi,
  type RouterSettings,
  type RouterStatus,
  type RouterTaskRun,
  type RouterTickReport,
} from "@/lib/api/superAgent";

/** 后台每 30 秒跑一轮，界面慢一拍也没关系；15 秒足够让人看到「刚派出去」。 */
const POLL_MS = 15_000;

export interface RouterStatusState {
  status: RouterStatus | null;
  error: string | null;
  /** 任务 id → 运行态。卡片与详情都用它，不各拉一次。 */
  runsByTask: Map<string, RouterTaskRun>;
  refresh: () => Promise<void>;
  saveSettings: (next: RouterSettings) => Promise<void>;
  runNow: () => Promise<RouterTickReport>;
}

/**
 * 自动调度的状态来源。
 *
 * 只做一件事：把 `router_status` 读回来并保持新鲜。判断全在后端，
 * 界面不参与任何「该派谁」的决定。
 */
export function useRouterStatus(root: string | null): RouterStatusState {
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await superAgentApi.status();
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const saveSettings = useCallback(
    async (next: RouterSettings) => {
      const saved = await superAgentApi.saveSettings(next);
      if (!mounted.current) return;
      setStatus((current) =>
        current ? { ...current, settings: saved } : current,
      );
      // 开关会影响「今天用了多少」，存完再读一次。
      await refresh();
    },
    [refresh],
  );

  const runNow = useCallback(async () => {
    const report = await superAgentApi.tick("manual");
    await refresh();
    return report;
  }, [refresh]);

  // 任务 id 只在单个仓库内唯一（每个 backlog 仓库都有自己的 TASK-1），
  // 所以只把当前仓库的运行态放进映射，同名任务不会互相顶掉。
  const runsByTask = useMemo(() => {
    const map = new Map<string, RouterTaskRun>();
    for (const run of status?.runs ?? []) {
      if (root && run.root !== root) continue;
      map.set(run.taskId, run);
    }
    return map;
  }, [status, root]);

  return { status, error, runsByTask, refresh, saveSettings, runNow };
}
