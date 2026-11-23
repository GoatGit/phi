import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Notice } from "@/components/ui/notice";
import {
  usePluginProtocol,
  usePluginSummaries,
} from "@/hooks/usePluginCatalog";
import { commandErrorMessage } from "@/lib/api/plugins";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { pluginPageClass } from "./pluginPage";
import { PluginLede } from "./pluginSection";

/**
 * 每一类能挂的钩子。这是校验规则的一部分（见 manifest 的验证分支），
 * 不属于运行时枚举，所以写在前端；类型列表本身读后端。
 */
const KIND_HOOKS: Record<string, string> = {
  rules: "request",
  script: "request / session-exit",
  feature: "panel",
};

/**
 * 插件协议页：写给要装或要写三方插件的人。
 *
 * 这一页刻意不手抄数字：清单版本、内置面板、各项上限都读后端
 * `get_plugin_protocol`，只有「怎么解释」留在文案里。否则文档说 150 ms、
 * 代码改成 200 ms，谁也不会记得回来改这一页。
 *
 * 代码示例直接给可复制的完整片段，而不是片段里的省略号：插件作者多数是从
 * 一个能跑的最小件开始的。
 */
export function PluginProtocolPage() {
  const { t } = useTranslation();
  const protocol = usePluginProtocol();
  const { data: summary } = usePluginSummaries();
  const data = protocol.data;

  if (protocol.error) {
    return (
      <div className={pluginPageClass}>
        <Notice tone="danger" title={t("pluginCenter.protocol.loadFailed")}>
          {commandErrorMessage(protocol.error)}
        </Notice>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={pluginPageClass}>
        <p className="text-body text-fg-3">{t("pluginCenter.loading")}</p>
      </div>
    );
  }

  const root = summary?.root ?? "~/.phi/plugins";
  const manifestKb = Math.round(data.limits.manifestBytes / 1024);
  const scriptKb = Math.round(data.limits.scriptBytes / 1024);
  const memoryMb = Math.round(data.sandbox.memoryBytes / (1024 * 1024));
  const stackKb = Math.round(data.sandbox.stackBytes / 1024);
  const payloadK = Math.round(data.sandbox.payloadChars / 1024);

  const treeSnippet = `${root}/mask-emails/
├── plugin.json
└── main.js`;

  // 用 JSON.stringify 生成清单示例，正则里的反斜杠不用手写转义。
  const manifestSnippet = JSON.stringify(
    {
      manifest_version: data.manifestVersion,
      id: "mask-emails",
      name: "Mask emails",
      version: "1.0.0",
      description: "把 messages 里每段文本的邮箱换成 <email>。",
      kind: "rules",
      hooks: ["request"],
      priority: 100,
      enabled_by_default: false,
      rules: [
        {
          op: "mask",
          path: "messages.*.content",
          pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
          replacement: "<email>",
        },
      ],
    },
    null,
    2,
  );

  const requestSnippet = `// 入参就是即将发往上游的请求体；返回新对象才会替换，返回 undefined 表示不动。
function ${data.requestEntry}(request) {
  if (typeof request.model !== "string") return undefined;
  return { ...request, model: request.model.toLowerCase() };
}`;

  const exitSnippet = `// 返回 null 表示弃权，交给下一个插件；都弃权就用内置策略。
function ${data.sessionExitEntry}(event) {
  if (event.failureKind !== "context") return null;
  return { action: "resume", mode: "fresh-session", reason: "上下文满了" };
}`;

  const manifestRows: Array<[string, ReactNode, ReactNode]> = [
    [
      "manifest_version",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.manifestVersion", {
        version: data.manifestVersion,
      }),
    ],
    [
      "id",
      t("pluginCenter.protocol.required.yes"),
      t("pluginCenter.protocol.fields.id"),
    ],
    [
      "name",
      t("pluginCenter.protocol.required.yes"),
      t("pluginCenter.protocol.fields.name"),
    ],
    [
      "version",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.version"),
    ],
    [
      "description",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.description"),
    ],
    [
      "author",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.author"),
    ],
    [
      "kind",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.kind"),
    ],
    [
      "hooks",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.hooks", {
        hooks: data.hooks.join(" / "),
      }),
    ],
    [
      "priority",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.priority"),
    ],
    [
      "enabled_by_default",
      t("pluginCenter.protocol.required.no"),
      t("pluginCenter.protocol.fields.enabledByDefault"),
    ],
    [
      "entry",
      t("pluginCenter.protocol.required.script"),
      t("pluginCenter.protocol.fields.entry"),
    ],
    [
      "rules",
      t("pluginCenter.protocol.required.rules"),
      t("pluginCenter.protocol.fields.rules", {
        maxRules: data.limits.maxRules,
      }),
    ],
    [
      "panel",
      t("pluginCenter.protocol.required.feature"),
      t("pluginCenter.protocol.fields.panel", {
        panels: data.builtinPanels.join(" / "),
      }),
    ],
  ];

  const kindRows: Array<[string, string, string]> = data.kinds.map((kind) => [
    kind,
    KIND_HOOKS[kind] ?? "—",
    t(`pluginCenter.protocol.kinds.${kind}.how`),
  ]);

  const decisionRows: Array<[string, ReactNode]> = [
    ["action", t("pluginCenter.protocol.script.decision.action")],
    ["mode", t("pluginCenter.protocol.script.decision.mode")],
    ["reason", t("pluginCenter.protocol.script.decision.reason")],
  ];

  return (
    <div className={cn(pluginPageClass, "space-y-6")}>
      <PluginLede
        hint={t("pluginCenter.protocol.hint", {
          version: data.manifestVersion,
          maxPlugins: data.limits.maxPlugins,
        })}
      >
        {t("pluginCenter.protocol.lede")}
      </PluginLede>

      <ProtocolSection
        id="protocol-layout"
        title={t("pluginCenter.protocol.layout.title")}
      >
        <ProtocolCode code={treeSnippet} label="tree" />
        <Note>{t("pluginCenter.protocol.layout.note")}</Note>
      </ProtocolSection>

      <ProtocolSection
        id="protocol-manifest"
        title={t("pluginCenter.protocol.manifest.title")}
      >
        <ProtocolTable
          head={[
            t("pluginCenter.protocol.manifest.field"),
            t("pluginCenter.protocol.manifest.requiredColumn"),
            t("pluginCenter.protocol.manifest.meaning"),
          ]}
          rows={manifestRows}
        />
        <Note>
          {t("pluginCenter.protocol.manifest.note", {
            kb: manifestKb,
            scriptKb,
          })}
        </Note>
        <ProtocolCode code={manifestSnippet} label="plugin.json" />
      </ProtocolSection>

      <ProtocolSection
        id="protocol-kinds"
        title={t("pluginCenter.protocol.kinds.title")}
      >
        <ProtocolTable
          head={[
            t("pluginCenter.protocol.kinds.kind"),
            t("pluginCenter.protocol.kinds.hooks"),
            t("pluginCenter.protocol.kinds.how"),
          ]}
          rows={kindRows}
        />
        <Note>{t("pluginCenter.protocol.kinds.note")}</Note>
      </ProtocolSection>

      <ProtocolSection
        id="protocol-rules"
        title={t("pluginCenter.protocol.rules.title")}
      >
        <Note>{t("pluginCenter.protocol.rules.note")}</Note>
        <ProtocolCode
          code={`{ "op": "remove", "path": "metadata.trace_id" }
{ "op": "mask", "path": "messages.*.content", "replacement": "<hidden>" }`}
          label="rules"
        />
      </ProtocolSection>

      <ProtocolSection
        id="protocol-script"
        title={t("pluginCenter.protocol.script.title")}
      >
        <Note>{t("pluginCenter.protocol.script.note")}</Note>

        <h3 className="pt-1 text-strong text-fg-1">
          {t("pluginCenter.protocol.script.requestTitle")}
        </h3>
        <ProtocolCode code={requestSnippet} label="main.js" />
        <Note>{t("pluginCenter.protocol.script.requestNote")}</Note>

        <h3 className="pt-1 text-strong text-fg-1">
          {t("pluginCenter.protocol.script.exitTitle")}
        </h3>
        <ProtocolCode code={exitSnippet} label="main.js" />
        <ProtocolTable
          head={[
            t("pluginCenter.protocol.script.decisionField"),
            t("pluginCenter.protocol.script.decisionValue"),
          ]}
          rows={decisionRows}
        />
        <Note>{t("pluginCenter.protocol.script.eventNote")}</Note>
        <Note>
          {t("pluginCenter.protocol.script.limitsNote", {
            timeout: data.sandbox.timeoutMs,
            memory: memoryMb,
            stack: stackKb,
            payload: payloadK,
          })}
        </Note>
      </ProtocolSection>

      <ProtocolSection
        id="protocol-install"
        title={t("pluginCenter.protocol.install.title")}
      >
        <ol className="space-y-2 text-body text-fg-2">
          <InstallStep index={1}>
            <p>
              {t("pluginCenter.protocol.install.step1")}{" "}
              <code className="break-all rounded-[4px] border border-border bg-subtle px-1 py-px font-mono text-caption text-fg-1">
                {root}
              </code>
            </p>
          </InstallStep>
          <InstallStep index={2}>
            {t("pluginCenter.protocol.install.step2")}
          </InstallStep>
          <InstallStep index={3}>
            {t("pluginCenter.protocol.install.step3")}
          </InstallStep>
          <InstallStep index={4}>
            {t("pluginCenter.protocol.install.step4", {
              stateFile: data.stateFile,
            })}
          </InstallStep>
        </ol>
        <Note>{t("pluginCenter.protocol.install.sdkNote")}</Note>
      </ProtocolSection>

      <ProtocolSection
        id="protocol-fails"
        title={t("pluginCenter.protocol.fails.title")}
      >
        <Note>{t("pluginCenter.protocol.fails.note")}</Note>
      </ProtocolSection>
    </div>
  );
}

function ProtocolSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-section text-fg-1">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 表格：首列给字段名，其余列是可读说明。窄窗口由自身横向滚动兜底。 */
function ProtocolTable({
  head,
  rows,
}: {
  head: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <div className="overflow-x-auto rounded-panel border border-border bg-surface">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="h-9 border-b border-border text-caption text-fg-2">
            {head.map((label) => (
              <th
                key={label}
                className="whitespace-nowrap px-4 text-start font-medium"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    "px-4 py-2.5",
                    cellIndex === 0
                      ? "whitespace-nowrap font-mono text-caption text-fg-1"
                      : "text-fg-2",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 代码块：等宽、横向滚动、右上角一个复制按钮。 */
function ProtocolCode({ code, label }: { code: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopied(true);
      toast.success(t("pluginCenter.protocol.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-subtle">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-caption text-fg-3">{label}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={t("pluginCenter.protocol.copy")}
          className="flex items-center gap-1 rounded-control px-1.5 py-0.5 text-caption text-fg-3 transition-colors hover:bg-surface hover:text-fg-1"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied
            ? t("pluginCenter.protocol.copied")
            : t("pluginCenter.protocol.copy")}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-caption leading-[18px] text-fg-1">
        {code}
      </pre>
    </div>
  );
}

/** 说明性小字：不进表格、不加色块，避免把文档页做成告警页。 */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-caption leading-[20px] text-fg-3">{children}</p>;
}

function InstallStep({
  index,
  children,
}: {
  index: number;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="w-4 shrink-0 text-end tabular-nums text-fg-3">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </li>
  );
}
