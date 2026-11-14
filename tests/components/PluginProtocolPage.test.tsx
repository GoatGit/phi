import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh.json";
import { PluginProtocolPage } from "@/components/plugins/PluginProtocolPage";
import type { PluginProtocol, PluginSummaryResponse } from "@/lib/api/plugins";

const apiMocks = vi.hoisted(() => ({ protocol: vi.fn(), list: vi.fn() }));

vi.mock("@/lib/api/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/plugins")>();
  return {
    ...actual,
    pluginsApi: {
      ...actual.pluginsApi,
      protocol: (...args: unknown[]) => apiMocks.protocol(...args),
      list: (...args: unknown[]) => apiMocks.list(...args),
    },
  };
});

beforeAll(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
});

function protocol(overrides: Partial<PluginProtocol> = {}): PluginProtocol {
  return {
    manifestFile: "plugin.json",
    manifestVersion: 1,
    stateFile: "plugins-state.json",
    requestEntry: "onRequest",
    sessionExitEntry: "onSessionExit",
    hooks: ["request", "session-exit", "panel"],
    kinds: ["rules", "script", "feature"],
    ruleOps: ["remove", "mask"],
    builtinPanels: ["report-card", "task-board"],
    limits: {
      manifestBytes: 65536,
      scriptBytes: 262144,
      maxPlugins: 128,
      maxRules: 32,
    },
    sandbox: {
      timeoutMs: 150,
      memoryBytes: 16 * 1024 * 1024,
      stackBytes: 256 * 1024,
      payloadChars: 512 * 1024,
    },
    ...overrides,
  };
}

function home(
  plugins: PluginSummaryResponse["plugins"] = [],
): PluginSummaryResponse {
  return { root: "/tmp/phi/plugins", plugins, errors: [] };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPage() {
  render(<PluginProtocolPage />, { wrapper });
}

describe("PluginProtocolPage", () => {
  beforeEach(() => {
    apiMocks.protocol.mockResolvedValue(protocol());
    apiMocks.list.mockResolvedValue(home());
  });

  // 协议里的数字必须来自后端：万一页面把上限抄死在文案里，这条会红。
  it("shows the limits reported by the running build", async () => {
    apiMocks.protocol.mockResolvedValue(
      protocol({
        builtinPanels: ["report-card"],
        limits: {
          manifestBytes: 4096,
          scriptBytes: 8192,
          maxPlugins: 3,
          maxRules: 7,
        },
        sandbox: {
          timeoutMs: 321,
          memoryBytes: 8 * 1024 * 1024,
          stackBytes: 128 * 1024,
          payloadChars: 64 * 1024,
        },
      }),
    );
    renderPage();

    // 清单字段：规则条数上限来自协议
    expect(await screen.findByText(/最多 7 条/)).toBeInTheDocument();
    // 清单大小上限同样来自协议（4096 字节 = 4 KB）
    expect(screen.getByText(/清单最多 4 KB/)).toBeInTheDocument();
    // 功能插件只能挂协议里列出的内置面板
    expect(
      screen.getByText("功能插件挂哪个内置面板：report-card。"),
    ).toBeInTheDocument();
    // 沙箱上限
    expect(screen.getByText(/单次 321 ms/)).toBeInTheDocument();
  });

  it("renders the layout, the manifest fields and the script entries", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "一个插件就是一个目录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\/tmp\/phi\/plugins\/mask-emails\//),
    ).toBeInTheDocument();
    // 清单示例用后端给的清单版本，不是文案里写死的数字
    expect(screen.getByText(/"manifest_version": 1/)).toBeInTheDocument();
    expect(
      screen.getByText(/function onRequest\(request\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/function onSessionExit\(event\)/),
    ).toBeInTheDocument();
  });

  it("walks through installing a third-party plugin", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "装一个三方插件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/在插件目录下建一个文件夹，名字建议和 id 一致/),
    ).toBeInTheDocument();
    expect(screen.getByText(/仓库 plugins-sdk\//)).toBeInTheDocument();
    expect(screen.getByText(/plugins-state\.json/)).toBeInTheDocument();
  });

  it("reports a protocol load failure instead of rendering half a page", async () => {
    apiMocks.protocol.mockRejectedValue("命令不可用");
    renderPage();

    expect(await screen.findByText("插件协议读取失败")).toBeInTheDocument();
    expect(screen.getByText("命令不可用")).toBeInTheDocument();
  });
});
