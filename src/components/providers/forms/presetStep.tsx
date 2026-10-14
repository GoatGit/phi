import { createContext, useContext } from "react";
import type { AppId } from "@/lib/api";
import type { PresetEntry } from "./ProviderPresetSelector";

/** A shared supplier catalog selects the appropriate legacy form internally. */
export interface PresetCatalog {
  entries: PresetEntry[];
  selectedPresetId?: string;
  onSelect: (id: string) => void;
}

/**
 * 添加供应商分两步（v7）：先选预设，再填写。表单一直挂着（预设列表和填写状态都在表单里），
 * 选预设那一步由预设选择器画进 `host`，表单本身先藏起来。
 */
export interface PresetStepState {
  appId: AppId;
  step: "pick" | "form";
  setStep: (step: "pick" | "form") => void;
  /** 第 1 步的画布（添加页的内容区） */
  host: HTMLElement | null;
  /** 预设选择器挂上时登记；表单里没有选择器时外壳直接进第 2 步 */
  registerSelector: () => () => void;
  catalog?: PresetCatalog;
}

export const PresetStepContext = createContext<PresetStepState | null>(null);

export const usePresetStep = () => useContext(PresetStepContext);
