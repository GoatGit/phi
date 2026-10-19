import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/components/ui/notice";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";

const fresh = (): AccessBinding => ({
  id: "",
  name: "",
  agent: "",
  tool: "codex",
  projectId: null,
  allowedGroups: [],
  enabled: true,
});
export function AccessBindings() {
  const { t } = useTranslation();
  return (
    <Collapsible className="flex flex-col gap-2 rounded-panel border border-border p-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group w-full justify-between">
          {t("access.advanced")}
          <ChevronDown
            data-icon="inline-end"
            aria-hidden
            className="transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <p className="text-sm text-fg-3">{t("access.automaticHint")}</p>
      <CollapsibleContent className="pt-2">
        <ClientAccessManager />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ClientAccessManager() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [draft, setDraft] = useState<AccessBinding | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const bindings = useQuery({
    queryKey: ["access-bindings"],
    queryFn: accessApi.bindings,
  });
  const projects = useQuery({
    queryKey: ["access-projects"],
    queryFn: accessApi.projects,
  });
  const catalog = useGatewayCatalog();
  const availableGroups =
    catalog.data?.groups?.filter((g) => g.appIds.includes(draft?.tool ?? "")) ??
    [];
  const invalidScope =
    scope === "selected" &&
    (!draft?.allowedGroups.length ||
      !draft.allowedGroups.every((id) =>
        availableGroups.some((g) => g.id === id),
      ));
  const ready = projects.isSuccess && catalog.isSuccess;
  const issue = useMutation({
    mutationFn: async (binding: AccessBinding) => {
      let projectId = binding.projectId;
      if (projectPath.trim())
        projectId = (await accessApi.createProject(projectPath.trim())).id;
      return accessApi.issue({ ...binding, projectId });
    },
    onSuccess: async (result) => {
      setDraft(null);
      setIssued(result.token);
      setCopied(false);
      setCopyError(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["access-bindings"] }),
        client.invalidateQueries({ queryKey: ["access-projects"] }),
      ]);
    },
  });
  const enabled = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      accessApi.enabled(id, value),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["access-bindings"] }),
  });
  const update = (patch: Partial<AccessBinding>) =>
    setDraft((value) => (value ? { ...value, ...patch } : value));
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("access.title")}</h2>
        <Button
          onClick={() => {
            issue.reset();
            setProjectPath("");
            setScope("all");
            setValidationError(null);
            setDraft(fresh());
          }}
        >
          {t("access.create")}
        </Button>
      </div>
      <p className="text-sm text-fg-3">{t("access.description")}</p>
      <Notice title={t("access.boundary")} />
      {(bindings.error || enabled.error) && (
        <Notice tone="danger" title={String(bindings.error ?? enabled.error)} />
      )}
      {bindings.isPending && <p role="status">{t("ledger.loading")}</p>}
      {bindings.data?.length === 0 && <Notice title={t("access.empty")} />}
      {bindings.data?.map((b) => (
        <Card key={b.id}>
          <CardHeader className="flex-row items-center justify-between px-4 py-3">
            <CardTitle>{b.name}</CardTitle>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  issue.reset();
                  setProjectPath("");
                  setScope(b.allowedGroups.length ? "selected" : "all");
                  setValidationError(null);
                  setDraft({ ...b });
                }}
              >
                {t("access.rotate")}
              </Button>
              <Switch
                aria-label={t("access.enabled", { name: b.name })}
                checked={b.enabled}
                disabled={enabled.isPending}
                onCheckedChange={(value) => enabled.mutate({ id: b.id, value })}
              />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 px-4 pb-4 text-sm">
            <p>
              {b.agent} · {b.tool} ·{" "}
              {projects.data?.find((p) => p.id === b.projectId)?.displayPath ??
                b.projectId ??
                t("access.noProject")}
            </p>
            <p className="text-xs text-fg-3">
              {b.allowedGroups.length
                ? b.allowedGroups
                    .map(
                      (id) =>
                        catalog.data?.groups?.find((g) => g.id === id)?.name ??
                        id,
                    )
                    .join(" · ")
                : t("access.allGroups")}
            </p>
          </CardContent>
        </Card>
      ))}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !issue.isPending) setDraft(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {t(draft?.id ? "access.rotate" : "access.create")}
            </DialogTitle>
            <DialogDescription>
              {t(draft?.id ? "access.rotateHint" : "access.createHint")}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(e) => {
                e.preventDefault();
                if (issue.isPending || !ready || invalidScope) return;
                if (!draft.name.trim() || !draft.agent.trim()) {
                  setValidationError(t("access.required"));
                  return;
                }
                setValidationError(null);
                issue.mutate({
                  ...draft,
                  name: draft.name.trim(),
                  agent: draft.agent.trim(),
                  allowedGroups: scope === "all" ? [] : draft.allowedGroups,
                });
              }}
            >
              <DialogBody>
                <FieldSet disabled={issue.isPending}>
                  <FieldGroup className="gap-4">
                    {(projects.isPending || catalog.isPending) && (
                      <p role="status">{t("ledger.loading")}</p>
                    )}
                    {(issue.error || projects.error || catalog.error) && (
                      <Notice
                        tone="danger"
                        title={String(
                          issue.error ?? projects.error ?? catalog.error,
                        )}
                      >
                        {(projects.isError || catalog.isError) && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              void projects.refetch();
                              void catalog.refetch();
                            }}
                          >
                            {t("access.retry")}
                          </Button>
                        )}
                      </Notice>
                    )}
                    {validationError && (
                      <FieldError>{validationError}</FieldError>
                    )}
                    <Field>
                      <FieldLabel htmlFor="binding-name">
                        {t("ledger.name")}
                      </FieldLabel>
                      <Input
                        id="binding-name"
                        required
                        maxLength={200}
                        value={draft.name}
                        onChange={(e) => {
                          setValidationError(null);
                          update({ name: e.target.value });
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="binding-agent">
                        {t("access.agent")}
                      </FieldLabel>
                      <Input
                        id="binding-agent"
                        required
                        maxLength={100}
                        value={draft.agent}
                        placeholder="Cline / Continue / Claude Code"
                        onChange={(e) => {
                          setValidationError(null);
                          update({ agent: e.target.value });
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="binding-protocol">
                        {t("access.protocol")}
                      </FieldLabel>
                      <Select
                        value={draft.tool}
                        onValueChange={(tool) =>
                          update({ tool, allowedGroups: [] })
                        }
                      >
                        <SelectTrigger
                          id="binding-protocol"
                          aria-label={t("access.protocol")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {[
                              ["codex", "OpenAI Chat / Responses"],
                              ["claude", "Anthropic Messages"],
                              ["gemini", "Gemini"],
                              // System One 是决策协议，只接 /typesafe/v1/systemone。
                              ["typesafe", "System One"],
                            ].map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="binding-project-choice">
                        {t("ledger.project")}
                      </FieldLabel>
                      <Select
                        value={draft.projectId ?? "none"}
                        disabled={projects.isPending || projects.isError}
                        onValueChange={(projectId) => {
                          setProjectPath("");
                          update({
                            projectId: projectId === "none" ? null : projectId,
                          });
                        }}
                      >
                        <SelectTrigger
                          id="binding-project-choice"
                          aria-label={t("ledger.project")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="none">
                              {t("access.noProject")}
                            </SelectItem>
                            {projects.data?.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.displayPath}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="binding-project">
                        {t("access.newProject")}
                      </FieldLabel>
                      <Input
                        id="binding-project"
                        value={projectPath}
                        onChange={(e) => setProjectPath(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="binding-scope">
                        {t("access.scope")}
                      </FieldLabel>
                      <Select
                        value={scope}
                        disabled={catalog.isPending || catalog.isError}
                        onValueChange={(value) => {
                          setScope(value as "all" | "selected");
                          if (value === "all") update({ allowedGroups: [] });
                        }}
                      >
                        <SelectTrigger id="binding-scope">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="all">
                              {t("access.allGroups")}
                            </SelectItem>
                            <SelectItem value="selected">
                              {t("access.selectedGroups")}
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {t("access.groupsHint")}
                      </FieldDescription>
                    </Field>
                    {scope === "selected" && (
                      <FieldSet>
                        <FieldLegend variant="label">
                          {t("access.groups")}
                        </FieldLegend>
                        {availableGroups.length === 0 && ready && (
                          <FieldDescription>
                            {t("access.noGroups")}
                          </FieldDescription>
                        )}
                        <FieldGroup className="gap-2">
                          {availableGroups.map((g) => (
                            <Field key={g.id} orientation="horizontal">
                              <Checkbox
                                id={`binding-group-${g.id}`}
                                checked={draft.allowedGroups.includes(g.id)}
                                onCheckedChange={(checked) =>
                                  update({
                                    allowedGroups: checked
                                      ? [...draft.allowedGroups, g.id]
                                      : draft.allowedGroups.filter(
                                          (id) => id !== g.id,
                                        ),
                                  })
                                }
                              />
                              <FieldLabel htmlFor={`binding-group-${g.id}`}>
                                {g.name}
                              </FieldLabel>
                            </Field>
                          ))}
                        </FieldGroup>
                        {invalidScope && ready && (
                          <FieldError>{t("access.selectGroup")}</FieldError>
                        )}
                      </FieldSet>
                    )}
                  </FieldGroup>
                </FieldSet>
              </DialogBody>
              <DialogFooter className="border-t border-border">
                <Button
                  type="button"
                  variant="outline"
                  disabled={issue.isPending}
                  onClick={() => setDraft(null)}
                >
                  {t("ledger.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={issue.isPending || !ready || invalidScope}
                >
                  {t(issue.isPending ? "access.issuing" : "access.issue")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) setIssued(null);
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
                value={issued ?? ""}
                onFocus={(e) => e.target.select()}
                className="font-mono text-xs"
              />
            </Field>
            <p className="text-sm text-fg-3">{t("access.headers")}</p>
            {copyError && <FieldError>{t("access.copyFailed")}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!issued) return;
                try {
                  await copyText(issued);
                  setCopied(true);
                  setCopyError(false);
                } catch {
                  setCopyError(true);
                }
              }}
            >
              {t(copied ? "access.copied" : "access.copy")}
            </Button>
            <Button onClick={() => setIssued(null)}>{t("access.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
