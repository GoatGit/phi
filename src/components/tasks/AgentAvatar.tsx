import avatar01 from "@/assets/bot-avatars/avatar-01.webp";
import avatar02 from "@/assets/bot-avatars/avatar-02.webp";
import avatar03 from "@/assets/bot-avatars/avatar-03.webp";
import avatar04 from "@/assets/bot-avatars/avatar-04.webp";
import avatar05 from "@/assets/bot-avatars/avatar-05.webp";
import avatar06 from "@/assets/bot-avatars/avatar-06.webp";
import avatar07 from "@/assets/bot-avatars/avatar-07.webp";
import avatar08 from "@/assets/bot-avatars/avatar-08.webp";
import avatar09 from "@/assets/bot-avatars/avatar-09.webp";
import avatar10 from "@/assets/bot-avatars/avatar-10.webp";
import avatar11 from "@/assets/bot-avatars/avatar-11.webp";
import avatar12 from "@/assets/bot-avatars/avatar-12.webp";
import avatar13 from "@/assets/bot-avatars/avatar-13.webp";
import avatar14 from "@/assets/bot-avatars/avatar-14.webp";
import avatar15 from "@/assets/bot-avatars/avatar-15.webp";
import avatar16 from "@/assets/bot-avatars/avatar-16.webp";
import { cn } from "@/lib/utils";

/**
 * 智能体头像：16 张 256×256 人像插画，键名 `avatar-01`…`avatar-16` 与文件名一致。
 *
 * 头像只表达「是它」，不表达状态——状态靠徽标。智能体上存的是键名而不是路径，
 * 换文件名等于换一批素材，所以键名一旦有用例或设置引用就不能随便改。
 * 出处与授权说明见 `src/assets/bot-avatars/NOTICE.md`。
 */
const AVATAR_SOURCES = [
  avatar01,
  avatar02,
  avatar03,
  avatar04,
  avatar05,
  avatar06,
  avatar07,
  avatar08,
  avatar09,
  avatar10,
  avatar11,
  avatar12,
  avatar13,
  avatar14,
  avatar15,
  avatar16,
];

/**
 * Router 在头像体系里的固定身份。
 *
 * 它不是 `agents` 里的某一项，没有智能体 id，所以给一个不变的键：
 * 改名、重启之后还是同一张脸，看板那一行与工作室表头认的也是同一张。
 */
export const ROUTER_AVATAR_ID = "router";

/** 全部可选头像的键，顺序即下标。选择器与校验都以它为准。 */
export const AGENT_AVATAR_KEYS: readonly string[] = AVATAR_SOURCES.map(
  (_, index) => `avatar-${String(index + 1).padStart(2, "0")}`,
);

/** 一个键是不是这批头像里的一张。后端 `validate` 认的是同一组键。 */
export function isAgentAvatarKey(value: string): boolean {
  return AGENT_AVATAR_KEYS.includes(value);
}

/**
 * 用 FNV-1a 把 id 折进 16 个头像里。
 *
 * 没显式选过头像的智能体按这个哈希取脸：同一个 id 重启、改名后都还是同一张，
 * 也不依赖名字。
 */
export function resolveAgentAvatarIndex(agentId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % AVATAR_SOURCES.length;
}

/** 按 id 派生出来的那一张，形如 `avatar-07`。 */
export function resolveAgentAvatarKey(agentId: string): string {
  const index = resolveAgentAvatarIndex(agentId);
  return AGENT_AVATAR_KEYS[index];
}

/**
 * 这个人现在用哪张脸：显式选过的优先，否则按 id 派生。
 *
 * 认不出来的键（老设置、手改过的文件）退回哈希，不显示一个破图。
 */
export function agentAvatarKey(
  agentId: string,
  avatar?: string | null,
): string {
  return avatar && isAgentAvatarKey(avatar)
    ? avatar
    : resolveAgentAvatarKey(agentId);
}

/** 键 → 图片地址。选择器里要逐张画出来，所以这里也开一个口子。 */
export function agentAvatarSource(key: string): string {
  const index = AGENT_AVATAR_KEYS.indexOf(key);
  return AVATAR_SOURCES[index >= 0 ? index : 0];
}

interface AgentAvatarProps {
  /** 稳定的身份：取自智能体 id，不取名字。 */
  agentId: string;
  /** 显式选过的头像键；空 = 按 id 派生。 */
  avatar?: string | null;
  /** 边长，默认 32；行头与卡片共用同一份素材。 */
  size?: number;
  className?: string;
}

/** 头像本身是装饰：旁边的名称已经把它是谁说清楚了。 */
export function AgentAvatar({
  agentId,
  avatar,
  size = 32,
  className,
}: AgentAvatarProps) {
  const key = agentAvatarKey(agentId, avatar);
  return (
    <img
      src={agentAvatarSource(key)}
      // 人像是方的、脸在中间偏上：圆形裁切刚好把背景压掉。
      className={cn(
        "shrink-0 rounded-full border border-border bg-subtle object-cover",
        className,
      )}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-avatar-key={key}
    />
  );
}
