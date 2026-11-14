import { logFrontendInfo } from "@/lib/frontendLogger";

/**
 * 「钉在左侧导航」的插件列表。
 *
 * 这是纯本地界面偏好：它不改变插件行为，也不该写进后端配置，所以只放在
 * localStorage。存的是插件 id（`report-card`、`session-baton`…），顺序就是
 * 侧栏里的顺序；插件被卸载时 id 留在本地，重新装上又会出现。
 */
export const PINNED_PLUGINS_STORAGE_KEY = "phi-pinned-plugins";

/** 侧栏一级入口不能无限长：超过这个数就不再接受新的钉住。 */
export const MAX_PINNED_PLUGINS = 12;

/** 后端插件 id 的字符集；顺手挡住被手改成路径/空白之类的东西。 */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalize(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length >= MAX_PINNED_PLUGINS) {
      logFrontendInfo(
        `钉住的插件超过 ${MAX_PINNED_PLUGINS} 个上限，其余条目被忽略`,
      );
      break;
    }
  }
  return normalized;
}

/** 读取钉住的插件；坏数据当作空列表，不让界面起不来。 */
export function readPinnedPlugins(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_PLUGINS_STORAGE_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function storePinnedPlugins(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_PLUGINS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存不了就算了：本次会话里钉住仍然生效
  }
}

/** 钉住 / 取消钉住；超出上限时保持原样。 */
export function togglePinnedPlugin(ids: string[], pluginId: string): string[] {
  if (ids.includes(pluginId)) {
    return ids.filter((id) => id !== pluginId);
  }
  if (ids.length >= MAX_PINNED_PLUGINS) return ids;
  return [...ids, pluginId];
}
