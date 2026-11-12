import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => core);

import {
  commandErrorMessage,
  mcpRouterApi,
  pluginsApi,
  privacyApi,
  type PrivacyConfig,
} from "@/lib/api/plugins";

/**
 * 插件中心三组命令的契约：命令名与参数名（camelCase）拼错的话只会在运行时炸，
 * 所以在这里钉住。
 */
describe("pluginsApi · 请求插件命令契约", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    core.invoke.mockResolvedValue(null);
  });

  it("列表、启停、试跑", async () => {
    await pluginsApi.list();
    await pluginsApi.setEnabled("strip-thinking", false);
    await pluginsApi.preview("strip-thinking", { a: 1 });

    expect(core.invoke.mock.calls).toEqual([
      ["list_plugins"],
      ["set_plugin_enabled", { id: "strip-thinking", enabled: false }],
      ["preview_plugin_request", { id: "strip-thinking", payload: { a: 1 } }],
    ]);
  });
});

describe("privacyApi · 脱敏命令契约", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    core.invoke.mockResolvedValue(null);
  });

  it("读取、保存、试跑", async () => {
    const config: PrivacyConfig = {
      version: 1,
      enabled: true,
      applyToRequestBody: false,
      redactErrorLogs: true,
      rules: [{ detector: "email", action: "mask", replacement: null }],
    };

    await privacyApi.get();
    await privacyApi.save(config);
    await privacyApi.preview("someone@example.com");

    expect(core.invoke.mock.calls).toEqual([
      ["get_privacy_config"],
      ["save_privacy_config", { config }],
      ["preview_privacy_redaction", { text: "someone@example.com" }],
    ]);
  });
});

describe("mcpRouterApi · 路由命令契约", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    core.invoke.mockResolvedValue(null);
  });

  it("读取、保存、目录预览", async () => {
    const config = {
      version: 1,
      enabled: true,
      namespaceSeparator: "-",
      routes: [
        {
          serverId: "github",
          alias: "work-github",
          namespace: null,
          apps: [],
          enabled: true,
          priority: 0,
          tags: [],
        },
      ],
    };

    await mcpRouterApi.get();
    await mcpRouterApi.save(config);
    await mcpRouterApi.catalog();

    expect(core.invoke.mock.calls).toEqual([
      ["get_mcp_router_config"],
      ["save_mcp_router_config", { config }],
      ["preview_mcp_router_catalog"],
    ]);
  });
});

describe("commandErrorMessage", () => {
  it("字符串、Error 与其它值都收成一句话", () => {
    expect(commandErrorMessage("第 1 条路由的 alias 过长")).toBe(
      "第 1 条路由的 alias 过长",
    );
    expect(commandErrorMessage(new Error("boom"))).toBe("boom");
    expect(commandErrorMessage(undefined)).toBe("undefined");
  });
});
