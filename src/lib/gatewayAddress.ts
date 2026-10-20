/**
 * 客户端连接 PHI 网关用的地址，和后端 `services::proxy::proxy_origin` 一致：
 * 带 `http://` 协议头和 `/v1` 路径，用户可以直接抄进客户端的端点输入框。
 *
 * 监听地址可能是 `0.0.0.0` / `::`（所有网卡），客户端连不上这两个地址，
 * 改用本机回环；IPv6 字面量加方括号。
 */
export const GATEWAY_API_SUFFIX = "/v1";

export function proxyOrigin(listenAddress: string, listenPort: number): string {
  const host =
    listenAddress === "0.0.0.0"
      ? "127.0.0.1"
      : listenAddress === "::"
        ? "::1"
        : listenAddress;
  const bracketed =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${listenPort}${GATEWAY_API_SUFFIX}`;
}
