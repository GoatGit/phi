# Magpie subscriptions in Phi

The bridge reuses Magpie's provider authentication, token refresh, community plugins and OpenAI Chat gateway from the published module version `github.com/yetone/magpie v0.1.1293`. Its MIT license is included in `bridge/LICENSE.magpie`. The built-in catalog contains all 19 subscription IDs in that revision, including retired built-ins now served through Magpie community plugins.

## Build

Install Go with automatic toolchain selection enabled. The pinned Magpie module requires Go 1.26.8. Build the module once so `bridge/go.sum` stays in the tree: run `pnpm build:subscriptions` to build the current Rust target; `pnpm dev` and `pnpm build` build it automatically. Set `TAURI_ENV_TARGET_TRIPLE` for a supported cross-compilation target. Tauri bundles the executable as an external binary.

The first build downloads the pinned Go dependency and its transitive dependencies. Keep the generated `bridge/go.sum` when preparing a release. Some subscriptions also install the same community plugin or CLI required by Magpie when their authorization dialog is opened.

## Runtime

Phi launches the bridge on a random loopback port and uses a process-specific bearer token. The renderer only receives login state and model IDs. Browser-origin requests are refused. Phi stores subscription settings and cached data beneath its own `subscriptions` directory, separately from Magpie’s configuration. Native CLI login mechanisms retain their upstream behavior.

A ChatGPT (Codex) sign-in ends on Phi’s own callback page (`bridge/page.go`). OpenAI only sends Codex’s browser back to `127.0.0.1:1455`, so the engine holds that port for the sign-in, Magpie’s flow reports it as taken, and the request the browser sends there finishes through Magpie’s own state check and exchange; the page the browser shows is Phi’s, for a sign-in that finished and one that didn’t. If the port belongs to another program the sign-in falls back to Magpie’s flow, which ends on Magpie’s page and can be finished from the address pasted back.

Model lists are asked of the signed-in account: `models` runs Magpie’s `Refetch`, so a ChatGPT account lists what the Codex backend gives that account now rather than what the pinned module or a local Codex cache says. A vendor that can’t be asked leaves the previously saved list in place and says why (`warning`), which the dialog shows; a finished sign-in always asks again.

Supplier catalogs store a stable logical endpoint such as `https://subscriptions.phi.invalid/copilot`, without runtime ports or subscription credentials. Phi resolves that endpoint internally for inference and model discovery. Subscription suppliers require a local routing group; direct application connections are disabled. Closing an unfinished authorization dialog cancels its session.

## Verification

Run `pnpm typecheck`, `pnpm test:unit -- tests/components/subscriptionCatalog.test.ts tests/components/SubscriptionSupplierDialog.test.tsx tests/components/AddPoolSupplier.test.tsx`, and the Rust gateway tests. Build the bridge and exercise actual subscription authorization and streaming requests before release; component tests mock the subscription engine and cannot prove vendor connectivity.
