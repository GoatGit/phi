import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { accessApi, type AccessBinding } from "@/lib/api/access";
import { useGatewayCatalog } from "./useGatewayCatalog";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// 与后端 access::EXTERNAL_APPS 一致：三方应用按入口协议切换身份，可选的路由组是
// 这些身份的并集，而不是某一个应用的组。
export const EXTERNAL_TOOL = "external";
export const EXTERNAL_APPS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "typesafe",
];
// 入口路径：令牌只解决鉴权，协议由客户端调用哪个端点决定。
const PROTOCOL_ENTRIES = [
  ["OpenAI Chat", "/v1/chat/completions"],
  ["OpenAI Responses", "/v1/responses"],
  ["Anthropic", "/v1/messages"],
  ["Gemini", "/v1beta/models/{model}:generateContent"],
  ["System One", "/typesafe/v1/systemone"],
];

/** 新建三方应用的空白草稿。第一条默认叫 PHI，之后的让用户按渠道命名。 */
export const freshBinding = (name = ""): AccessBinding => ({
  id: "",
  name,
  agent: "",
  tool: EXTERNAL_TOOL,
  projectId: null,
  allowedGroups: [],
  enabled: true,
});

/**
 * 新建 / 重新签发一个三方应用。
 *
 * 三方应用 = 一枚由 PHI 签发的接入令牌：给 Cursor、Cline、脚本这类 PHI 不自动
 * 配置的客户端用，在用量与路由流转图里都按一个独立应用出现。路由流转图第一列
 * 的「添加其他应用」开的就是这个窗口，所以它自己完成保存并展示一次令牌。
 *
 * `variant="edit"` 是流转图节点右上角的编辑：只给「重新签发」与「删除」两个
 * 动作。改名与换路由范围仍留在设置 → 网关 → 三方应用的单页表单里。
 */
export function AccessKeyDialog({
  draft,
  onChange,
  onClose,
  onIssued,
  variant = "full",
  onDeleteRequest,
}: {
  draft: AccessBinding | null;
  onChange: (next: AccessBinding) => void;
  onClose: () => void;
  onIssued?: (token: string) => void;
  /** `edit`：只给「重新签发」与「删除」，用于流转图上已保存的三方应用。 */
  variant?: "full" | "edit";
  onDeleteRequest?: (binding: AccessBinding) => void;
}) {
  // 只有打开时才挂载：内部有目录查询与保存 mutation，关着的时候要求外面提供
  // QueryClient 是没必要的（也会让流转图这类只看图的场景必须套 Provider）。
  if (!draft) return null;
  return (
    <AccessKeyDialogPanel
      draft={draft}
      onChange={onChange}
      onClose={onClose}
      onIssued={onIssued}
      variant={variant}
      onDeleteRequest={onDeleteRequest}
    />
  );
}

function AccessKeyDialogPanel({
  draft,
  onChange,
  onClose,
  onIssued,
  variant,
  onDeleteRequest,
}: {
  draft: AccessBinding;
  onChange: (next: AccessBinding) => void;
  onClose: () => void;
  onIssued?: (token: string) => void;
  variant: "full" | "edit";
  onDeleteRequest?: (binding: AccessBinding) => void;
}) {
  const { t } = useTranslation();
  const editOnly = variant === "edit" && Boolean(draft.id);
  const client = useQueryClient();
  const catalog = useGatewayCatalog();
  const [validationError, setValidationError] = useState<string | null>(null);
  // 签发成功与关窗是同一次状态更新：先把令牌留在这里，等本弹窗卸载后再交给
  // 宿主的令牌弹窗，否则两个 Radix 弹窗会在同一帧里互相关闭。
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  useEffect(() => {
    if (issuedToken === null) return;
    const timer = window.setTimeout(() => onIssued?.(issuedToken), 0);
    return () => window.clearTimeout(timer);
  }, [issuedToken, onIssued]);

  const availableGroups = useMemo(
    () =>
      catalog.data?.groups?.filter((group) =>
        group.appIds.some((id) => EXTERNAL_APPS.includes(id)),
      ) ?? [],
    [catalog.data],
  );
  const invalidScope =
    draft.allowedGroups.length === 0 ||
    !draft.allowedGroups.every((id) =>
      availableGroups.some((group) => group.id === id),
    );
  const ready = catalog.isSuccess;

  const issue = useMutation({
    mutationFn: async (binding: AccessBinding) => {
      const name = binding.name.trim();
      return accessApi.issue({
        ...binding,
        name,
        agent: binding.agent.trim() || name,
        tool: EXTERNAL_TOOL,
        projectId: null,
        allowedGroups: binding.allowedGroups,
      });
    },
    onSuccess: async (result) => {
      setIssuedToken(result.token);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["access-bindings"] }),
        client.invalidateQueries({ queryKey: ["access-binding-usage"] }),
        client.invalidateQueries({ queryKey: ["gateway"] }),
      ]);
    },
  });

  const update = (patch: Partial<AccessBinding>) => {
    onChange({ ...draft, ...patch });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !issue.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {t(
              editOnly
                ? "access.editTitle"
                : draft.id
                  ? "access.rotate"
                  : "access.create",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              editOnly
                ? "access.editHint"
                : draft.id
                  ? "access.rotateHint"
                  : "access.createHint",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (issue.isPending || !ready || invalidScope) return;
            if (!draft.name.trim()) {
              setValidationError(t("access.nameRequired"));
              return;
            }
            setValidationError(null);
            issue.mutate(draft);
          }}
        >
          <DialogBody>
            <FieldSet disabled={issue.isPending}>
              <FieldGroup className="gap-4">
                {editOnly && (
                  <div className="flex flex-col gap-1 rounded-control bg-subtle px-3 py-2.5 text-body">
                    <span className="font-medium text-fg-1">{draft.name}</span>
                    <span className="text-caption text-fg-2">
                      {draft.allowedGroups.length
                        ? draft.allowedGroups
                            .map(
                              (id) =>
                                availableGroups.find((group) => group.id === id)
                                  ?.name ?? id,
                            )
                            .join(" · ")
                        : t("access.allGroups")}
                    </span>
                  </div>
                )}
                {catalog.isPending && (
                  <p role="status" className="m-0 text-caption text-fg-2">
                    {t("ledger.loading")}
                  </p>
                )}
                {(issue.error || catalog.error) && (
                  <Notice
                    tone="danger"
                    title={String(issue.error ?? catalog.error)}
                  >
                    {catalog.isError && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void catalog.refetch()}
                      >
                        {t("access.retry")}
                      </Button>
                    )}
                  </Notice>
                )}
                {validationError && <FieldError>{validationError}</FieldError>}
                {editOnly ? (
                  // 编辑模式只给两个动作，不再暴露可改的字段；协议入口说明保留，
                  // 因为重新签发前常见的问题是客户端把路径写错了。
                  <div className="rounded-control bg-subtle px-3 py-2.5 text-caption text-fg-2">
                    <p className="m-0">{t("access.protocolsHint")}</p>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 font-mono text-badge">
                      {PROTOCOL_ENTRIES.map(([protocol, path]) => (
                        <li key={path}>
                          {protocol} · {path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <>
                    <Field>
                      <FieldLabel htmlFor="binding-name">
                        {t("access.keyName")}
                      </FieldLabel>
                      <Input
                        id="binding-name"
                        required
                        maxLength={200}
                        placeholder={t("access.keyNamePlaceholder")}
                        value={draft.name}
                        onChange={(event) => {
                          setValidationError(null);
                          update({ name: event.target.value });
                        }}
                      />
                    </Field>
                    <FieldSet>
                      <FieldLegend variant="label">
                        {t("access.scope")}
                      </FieldLegend>
                      <FieldDescription>
                        {availableGroups.length === 0 && ready
                          ? t("access.noGroups")
                          : t("access.groupsHint")}
                      </FieldDescription>
                      <FieldGroup className="gap-2">
                        {availableGroups.map((group) => (
                          <Field key={group.id} orientation="horizontal">
                            <Checkbox
                              id={`binding-group-${group.id}`}
                              checked={draft.allowedGroups.includes(group.id)}
                              onCheckedChange={(checked) =>
                                update({
                                  allowedGroups: checked
                                    ? [...draft.allowedGroups, group.id]
                                    : draft.allowedGroups.filter(
                                        (id) => id !== group.id,
                                      ),
                                })
                              }
                            />
                            <FieldLabel htmlFor={`binding-group-${group.id}`}>
                              {group.name}
                            </FieldLabel>
                          </Field>
                        ))}
                      </FieldGroup>
                      {invalidScope && ready && (
                        <FieldError>{t("access.selectGroup")}</FieldError>
                      )}
                    </FieldSet>
                    <div className="rounded-control bg-subtle px-3 py-2.5 text-caption text-fg-2">
                      <p className="m-0">{t("access.protocolsHint")}</p>
                      <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 font-mono text-badge">
                        {PROTOCOL_ENTRIES.map(([protocol, path]) => (
                          <li key={path}>
                            {protocol} · {path}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </FieldGroup>
            </FieldSet>
          </DialogBody>
          <DialogFooter className="border-t border-border">
            {onDeleteRequest && draft.id && (
              <Button
                type="button"
                variant="outline"
                className="me-auto text-danger"
                disabled={issue.isPending}
                onClick={() => onDeleteRequest(draft)}
              >
                {t("access.delete")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={issue.isPending}
              onClick={onClose}
            >
              {t("ledger.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={issue.isPending || !ready || invalidScope}
            >
              {t(draft.id ? "access.rotate" : "access.issue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 新建成功后展示一次令牌：令牌只在签发时可见。 */
export function IssuedTokenDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (token === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("access.token")}</DialogTitle>
          <DialogDescription>{t("access.tokenHint")}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-3 px-6 pb-2">
          <Field>
            <FieldLabel htmlFor="issued-access-token">
              {t("access.token")}
            </FieldLabel>
            <Input
              id="issued-access-token"
              aria-label={t("access.token")}
              readOnly
              value={token}
              onFocus={(event) => event.target.select()}
              className="font-mono text-xs"
            />
          </Field>
          <p className="m-0 text-caption text-fg-3">{t("access.headers")}</p>
          {copyError && <FieldError>{t("access.copyFailed")}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await copyText(token);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {t(copied ? "access.copied" : "access.copy")}
          </Button>
          <Button onClick={onClose}>{t("access.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 删除确认。三方应用在设置页与流转图上都能删，确认文案与后果说明是同一份，
 * 所以抽在这里，两处只负责把要删的那一项传进来。
 */
export function AccessDeleteDialog({
  binding,
  onClose,
}: {
  binding: AccessBinding | null;
  onClose: () => void;
}) {
  // 只有打开时才挂载：内部有删除 mutation，关着的时候要求外面提供 QueryClient
  // 是没必要的（也会让流转图这类只看图的场景必须套 Provider）。
  if (!binding) return null;
  return <AccessDeleteDialogPanel binding={binding} onClose={onClose} />;
}

function AccessDeleteDialogPanel({
  binding,
  onClose,
}: {
  binding: AccessBinding;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => accessApi.remove(id),
    onSuccess: async () => {
      onClose();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["access-bindings"] }),
        client.invalidateQueries({ queryKey: ["access-binding-usage"] }),
        client.invalidateQueries({ queryKey: ["gateway"] }),
      ]);
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("access.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("access.deleteHint", { name: binding.name })}
          </DialogDescription>
        </DialogHeader>
        {remove.error && (
          <DialogBody>
            <Notice tone="danger" title={String(remove.error)} />
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            {t("ledger.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(binding.id)}
          >
            {t("access.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
