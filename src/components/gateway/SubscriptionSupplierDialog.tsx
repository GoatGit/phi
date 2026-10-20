import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { settingsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { gatewayApi, type GatewaySupplier } from "@/lib/api";
import type {
  SubscriptionMethod,
  SubscriptionModels,
  SubscriptionPrompt,
  SubscriptionSignIn,
} from "@/lib/api/gateway";
import { gatewayCatalogKey, useGatewayErrorMessage } from "./useGatewayCatalog";
import type { SubscriptionType } from "./subscriptionTemplates";

const pending = (state?: string) =>
  !!state && !["done", "failed", "canceled"].includes(state);

/** Login credentials stay in the subscription engine, never in app configs. */
export function SubscriptionSupplierDialog({
  subscription,
  revision,
  onClose,
  onBack,
  supplier,
}: {
  subscription: SubscriptionType;
  revision: number;
  onClose: () => void;
  onBack?: () => void;
  supplier?: GatewaySupplier;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const describeError = useGatewayErrorMessage();
  const [methods, setMethods] = useState<SubscriptionMethod[]>([]);
  const [method, setMethod] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState<SubscriptionPrompt | null>(null);
  const [answer, setAnswer] = useState("");
  const [key, setKey] = useState("");
  const [callback, setCallback] = useState("");
  const [session, setSession] = useState<SubscriptionSignIn | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsWarning, setModelsWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const current = useRef<SubscriptionSignIn | null>(null);
  const call = <T,>(action: string, payload: Record<string, unknown> = {}) =>
    gatewayApi.subscriptionAction<T>(action, {
      id: subscription.id,
      ...payload,
    });

  // Opens the account's own list: the vendor is asked, so the dialog shows what
  // the subscription can use now rather than what was saved with an older one.
  const loadModels = async () => {
    const listed = await call<SubscriptionModels>("models");
    if (!alive.current) return;
    setModels(listed.models ?? []);
    setModelsWarning(listed.warning ?? "");
  };
  const loadPrompt = async (index: number, values: Record<string, string>) => {
    const next = await call<SubscriptionPrompt | null>("prompt", {
      method: index,
      inputs: values,
    });
    if (alive.current) {
      setPrompt(next);
      setAnswer(next?.options?.[0]?.value ?? "");
    }
    return next;
  };
  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await call<SubscriptionMethod[]>("prepare");
      if (!alive.current) return;
      setMethods(next);
      setMethod(0);
      setInputs({});
      setSession(null);
      setKey("");
      setModelsWarning("");
      await loadPrompt(0, {});
      // An existing account can be added without logging in again.
      try {
        await loadModels();
      } catch {
        /* No saved subscription yet. */
      }
    } catch (err) {
      if (alive.current) setError(describeError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void prepare();
    return () => {
      alive.current = false;
      const active = current.current;
      if (active?.id && pending(active.state)) {
        void gatewayApi
          .subscriptionAction("cancel", { session: active.id })
          .catch(() => {});
      }
    };
    // The parent keys the dialog by subscription ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    current.current = session;
    if (!session?.id || !pending(session.state)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await call<SubscriptionSignIn>("status", {
          session: session.id,
        });
        if (disposed) return;
        setSession(next);
        current.current = next;
        if (next.state === "done") await loadModels();
        else if (next.state === "failed")
          setError(next.error || t("gateway.subscription.failed"));
        else if (pending(next.state)) timer = setTimeout(poll, 1500);
      } catch (err) {
        if (!disposed) setError(describeError(err));
      }
    };
    timer = setTimeout(poll, 700);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.state]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (err) {
      if (alive.current) setError(describeError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const login = () =>
    run(async () => {
      const values = prompt ? { ...inputs, [prompt.key]: answer } : inputs;
      setInputs(values);
      if (prompt && (await loadPrompt(method, values))) return;
      const next = await call<SubscriptionSignIn>("login", {
        method,
        inputs: values,
        value: key,
      });
      setKey("");
      if (!alive.current) {
        if (next.id && pending(next.state))
          await gatewayApi.subscriptionAction("cancel", { session: next.id });
        return;
      }
      current.current = next;
      setSession(next);
      if (next.state === "done") await loadModels();
    });
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = supplier
        ? await gatewayApi.updateSupplier(supplier.id, { revision, models })
        : await gatewayApi.connectSubscription(subscription.id, revision);
      qc.setQueryData(gatewayCatalogKey, saved);
      onClose();
    } catch (err) {
      setError(describeError(err));
      void qc.invalidateQueries({ queryKey: gatewayCatalogKey });
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const open = (url: string) =>
    run(async () => {
      const protocol = new URL(url).protocol;
      if (protocol !== "http:" && protocol !== "https:")
        throw new Error(t("gateway.subscription.invalidUrl"));
      await settingsApi.openExternal(url);
    });
  const waiting = pending(session?.state);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {subscription.name} · {t("providerPreset.group.subscription")}
          </DialogTitle>
          <DialogDescription>
            {t("gateway.subscription.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Notice tone="route" title={t("gateway.subscription.routeHint")} />
          {error && (
            <div role="alert">
              <Notice tone="danger" title={error} />
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-fg-3">
              {t("gateway.subscription.preparing")}
            </p>
          )}
          {methods.length > 1 && (
            <Field>
              <FieldLabel htmlFor="subscription-method">
                {t("gateway.subscription.method")}
              </FieldLabel>
              <select
                id="subscription-method"
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={method}
                disabled={busy || waiting || saving}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setMethod(index);
                  setInputs({});
                  setKey("");
                  void run(async () => {
                    await loadPrompt(index, {});
                  });
                }}
              >
                {methods.map((item, index) => (
                  <option key={index} value={index}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!waiting && prompt && (
            <Field>
              <FieldLabel htmlFor="subscription-answer">
                {prompt.message}
              </FieldLabel>
              {prompt.type === "select" ? (
                <select
                  id="subscription-answer"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                >
                  {prompt.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="subscription-answer"
                  type={prompt.type === "password" ? "password" : "text"}
                  autoComplete="off"
                  placeholder={prompt.placeholder}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              )}
            </Field>
          )}
          {!waiting && methods[method]?.type === "api" && (
            <Field>
              <FieldLabel htmlFor="subscription-key">
                {t("gateway.subscription.apiKey")}
              </FieldLabel>
              <Input
                id="subscription-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
          )}
          {session?.instructions && (
            <p className="whitespace-pre-wrap text-sm text-fg-2">
              {session.instructions}
            </p>
          )}
          {session?.code && (
            <div className="rounded-lg bg-subtle p-4">
              <p className="text-xs text-fg-3">
                {t("gateway.subscription.deviceCode")}
              </p>
              <p className="mt-1 select-all font-mono text-xl tracking-widest">
                {session.code}
              </p>
            </div>
          )}
          {waiting && (
            <p role="status" className="text-sm text-fg-2">
              {t("gateway.subscription.waiting")}
            </p>
          )}
          {session?.url && waiting && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void open(session.url!)}
            >
              {t("gateway.subscription.openLogin")}
            </Button>
          )}
          {session?.keysURL && waiting && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void open(session.keysURL!)}
            >
              {t("gateway.subscription.openKeys")}
            </Button>
          )}
          {waiting &&
            (session?.pasteCallback ||
              session?.pasteCode ||
              session?.pasteKey) && (
              <Field>
                <FieldLabel htmlFor="subscription-callback">
                  {t("gateway.subscription.callback")}
                </FieldLabel>
                <Input
                  id="subscription-callback"
                  autoComplete="off"
                  type={session.pasteKey ? "password" : "text"}
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy || !callback.trim()}
                  onClick={() =>
                    void run(async () => {
                      await call("callback", {
                        session: session.id,
                        value: callback.trim(),
                      });
                      setCallback("");
                    })
                  }
                >
                  {t("gateway.subscription.submitCallback")}
                </Button>
              </Field>
            )}
          {modelsWarning && (
            <Notice
              tone="warning"
              title={t("gateway.subscription.modelsStale")}
            >
              {modelsWarning}
            </Notice>
          )}
          {!!models.length && (
            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium text-fg-1">
                {t("gateway.subscription.ready", { count: models.length })}
              </p>
              <div className="mt-2 max-h-36 overflow-auto break-words font-mono text-xs leading-5 text-fg-3">
                {models.join(" · ")}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2">
          {onBack && (
            <Button variant="ghost" disabled={saving} onClick={onBack}>
              {t("gateway.subscription.back")}
            </Button>
          )}
          {!methods.length && !busy && (
            <Button variant="outline" onClick={() => void prepare()}>
              {t("gateway.subscription.retry")}
            </Button>
          )}
          {waiting ? (
            <Button
              variant="outline"
              disabled={busy || saving}
              onClick={() =>
                void run(async () => {
                  await call("cancel", { session: session!.id });
                  setSession(null);
                  current.current = null;
                })
              }
            >
              {t("gateway.subscription.cancelLogin")}
            </Button>
          ) : (
            !!methods.length && (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  saving ||
                  (methods[method]?.type === "api" && !key.trim())
                }
                onClick={() => void login()}
              >
                {t(
                  prompt
                    ? "gateway.subscription.next"
                    : "gateway.subscription.login",
                )}
              </Button>
            )
          )}
          <Button
            disabled={busy || saving || waiting || !models.length}
            onClick={() => void save()}
          >
            {t(
              saving
                ? "gateway.loading"
                : supplier
                  ? "gateway.subscription.update"
                  : "gateway.subscription.add",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
