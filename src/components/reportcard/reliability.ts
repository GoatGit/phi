/**
 * 可靠性阈值的唯一来源。
 *
 * 只有到了阈值才上色，避免「凭感觉染红」，也让以后接上验收命令时改一处即可。
 * 口径见 DESIGN.md 第 5 节。
 */
export type ReliabilityTone = "calm" | "watch" | "bad";

export const FAILURE_THRESHOLDS = { watch: 0.05, bad: 0.1 } as const;
export const INTERRUPT_THRESHOLDS = { watch: 0.02, bad: 0.05 } as const;
export const DELIVERY_THRESHOLDS = { watch: 0.05, bad: 0.15 } as const;

function toneFor(
  value: number,
  thresholds: { watch: number; bad: number },
): ReliabilityTone {
  if (value >= thresholds.bad) return "bad";
  if (value >= thresholds.watch) return "watch";
  return "calm";
}

/** 失败率分档 */
export function failureTone(rate: number): ReliabilityTone {
  return toneFor(rate, FAILURE_THRESHOLDS);
}

/** 被中断率分档 */
export function interruptionTone(rate: number): ReliabilityTone {
  return toneFor(rate, INTERRUPT_THRESHOLDS);
}

/** 空交付率分档 */
export function deliveryTone(rate: number): ReliabilityTone {
  return toneFor(rate, DELIVERY_THRESHOLDS);
}

export const TONE_TEXT: Record<ReliabilityTone, string> = {
  calm: "text-fg-1",
  watch: "text-warning-text",
  bad: "text-danger-text",
};

export const TONE_BAR: Record<ReliabilityTone, string> = {
  calm: "bg-success",
  watch: "bg-warning",
  bad: "bg-danger",
};
