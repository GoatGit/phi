import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ListFilter, Pencil, Plus, Settings2 } from "lucide-react";
import type {
  GatewayCatalog,
  GatewayRouteGroup,
  GatewayTracePage,
} from "@/lib/api/gateway";
import {
  getAppIconName,
  getAppLabel,
  isRoutableAppId,
} from "@/config/appConfig";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { AccessBinding } from "@/lib/api/access";
import phiLogoLight from "@/assets/icons/phi/phi-logo-light.png";
import phiLogoDark from "@/assets/icons/phi/phi-logo-dark.png";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AccessDeleteDialog,
  AccessKeyDialog,
  IssuedTokenDialog,
  freshBinding,
} from "./AccessKeyDialog";
import {
  buildRoutingFlow,
  buildTimeline,
  laneColor,
  laneFinalState,
  lanePlayback,
  readableRequestModel,
  type FlowGroupNode,
  type FlowLane,
  type FlowState,
  type RouteAppRequest,
} from "./routingFlowModel";
import {
  AppRouteSettingsDialog,
  type AppRouteDialogAppId,
} from "./AppRouteSettingsDialog";
import { createGroupDraft, GroupDialog } from "./GroupEditorDialog";
import {
  catalogWithoutGroup,
  useGatewayErrorMessage,
  useSaveGatewayCatalog,
} from "./useGatewayCatalog";
import { ConfirmDialog } from "@/components/ConfirmDialog";

function PhiFlowLogo() {
  return (
    <span role="img" aria-label="phi" className="inline-flex size-7 shrink-0">
      <img
        src={phiLogoLight}
        alt=""
        draggable={false}
        className="size-full object-contain dark:hidden"
      />
      <img
        src={phiLogoDark}
        alt=""
        draggable={false}
        className="hidden size-full object-contain dark:block"
      />
    </span>
  );
}

/** 点节点上的地址就整段复制：流转图的用处就是让你照抄进客户端。 */
function copyGatewayAddress(address: string) {
  void navigator.clipboard?.writeText(address).catch(() => undefined);
}

/** 默认展开的应用行数。应用变多以后，靠后的应用折叠起来，图不会被拉得
 *  很长；已接入路由组的应用、任何一个还在传输中的应用、以及三方应用都不受
 *  折叠影响，所以实际可能比这个数多。 */
const VISIBLE_APP_LIMIT = 5;
const EMPTY_BINDINGS: readonly AccessBinding[] = [];

/** A node's real on-screen box, relative to the flow stage. Wires are drawn
 *  from these measured values, so they always touch the rendered nodes no
 *  matter how the CSS grid distributes rows or how tall columns grow. */
type NodeBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cy: number;
};

type FlowGeometry = {
  width: number;
  height: number;
  hub: NodeBox | null;
  apps: Map<string, NodeBox>;
  groups: Map<string, NodeBox>;
  models: Map<string, NodeBox>;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function boxOf(el: Element, stage: DOMRect): NodeBox {
  const rect = el.getBoundingClientRect();
  return {
    left: round1(rect.left - stage.left),
    top: round1(rect.top - stage.top),
    right: round1(rect.right - stage.left),
    bottom: round1(rect.bottom - stage.top),
    cy: round1(rect.top + rect.height / 2 - stage.top),
  };
}

function readGeometry(stage: HTMLElement): FlowGeometry {
  const stageBox = stage.getBoundingClientRect();
  const collect = (kind: string) => {
    const boxes = new Map<string, NodeBox>();
    stage
      .querySelectorAll<HTMLElement>(`[data-flow="${kind}"][data-flow-key]`)
      .forEach((el) => {
        boxes.set(el.dataset.flowKey!, boxOf(el, stageBox));
      });
    return boxes;
  };
  const hub = stage.querySelector<HTMLElement>('[data-flow="hub"]');
  return {
    width: round1(stageBox.width),
    height: round1(stageBox.height),
    hub: hub ? boxOf(hub, stageBox) : null,
    apps: collect("app"),
    groups: collect("group"),
    models: collect("model"),
  };
}

const sameBox = (a?: NodeBox, b?: NodeBox) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.cy === b.cy);

function sameGeometry(a: FlowGeometry | null, b: FlowGeometry) {
  if (
    !a ||
    a.width !== b.width ||
    a.height !== b.height ||
    !sameBox(a.hub ?? undefined, b.hub ?? undefined)
  )
    return false;
  const layers = [
    [a.apps, b.apps],
    [a.groups, b.groups],
    [a.models, b.models],
  ] as const;
  for (const [from, to] of layers) {
    if (from.size !== to.size) return false;
    for (const [key, box] of from) {
      if (!sameBox(box, to.get(key))) return false;
    }
  }
  return true;
}

/** 连线在节点边缘上的落点与节点圆角之间保留的余量：扇出再大也不会画到
 *  节点外面去。 */
const WIRE_EDGE_INSET = 8;

/** 平行线之间的间距。 */
const WIRE_FAN_GAP = 5;

type WireEnd = Pick<NodeBox, "cy"> & Partial<Pick<NodeBox, "top" | "bottom">>;

/** 线在节点上的落点：节点纵轴中心加上这条线的扇出偏移，并收在节点边缘
 *  之内。偏移一旦超出节点高度，线就会飘到节点上下的空白处。 */
function edgeY(box: WireEnd, offset: number): number {
  const y = box.cy + offset;
  if (box.top == null || box.bottom == null) return round1(y);
  const inset = Math.min(WIRE_EDGE_INSET, (box.bottom - box.top) / 4);
  return round1(Math.min(Math.max(y, box.top + inset), box.bottom - inset));
}

/** Horizontal cubic that leaves the source's right edge and lands exactly
 *  on the target's left edge. Pure function so the shape stays testable. */
export function wirePath(
  from: Pick<NodeBox, "right"> & WireEnd,
  to: Pick<NodeBox, "left"> & WireEnd,
  offset = 0,
): string {
  const x1 = round1(from.right);
  const y1 = edgeY(from, offset);
  const x2 = round1(to.left);
  const y2 = edgeY(to, offset);
  const bend = round1(Math.max(18, (x2 - x1) * 0.45));
  return `M ${x1} ${y1} C ${round1(x1 + bend)} ${y1}, ${round1(x2 - bend)} ${y2}, ${x2} ${y2}`;
}

type GroupDraft = {
  group: GatewayRouteGroup;
  revision: number;
  isNew: boolean;
};

/** 路由组编辑器的沙箱：只在弹窗打开时挂载，因此可以安全使用目录缓存。 */
function GroupEditorHost({
  catalog,
  draft,
  onClose,
  onDeleteRequest,
}: {
  catalog: GatewayCatalog;
  draft: GroupDraft;
  onClose: () => void;
  onDeleteRequest: (group: GatewayRouteGroup) => void;
}) {
  const describeError = useGatewayErrorMessage();
  const save = useSaveGatewayCatalog();
  const groups = catalog.groups ?? [];
  return (
    <GroupDialog
      catalog={catalog}
      group={draft.group}
      isNew={draft.isNew}
      pending={save.isPending}
      error={save.isError ? describeError(save.error) : null}
      stale={draft.revision !== catalog.revision}
      onClose={onClose}
      onDeleteRequest={() => onDeleteRequest(draft.group)}
      onSave={(group) =>
        save.mutate(
          {
            ...catalog,
            revision: draft.revision,
            groups: draft.isNew
              ? [...groups, group]
              : groups.map((item) => (item.id === group.id ? group : item)),
          },
          { onSuccess: onClose },
        )
      }
    />
  );
}

/** 删除确认从编辑器拆出来，避免编辑器关闭时一起卸载确认弹窗。 */
function GroupDeleteDialog({
  catalog,
  group,
  onClose,
}: {
  catalog: GatewayCatalog;
  group: GatewayRouteGroup;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveGatewayCatalog();
  return (
    <ConfirmDialog
      isOpen
      title={t("gateway.groups.removeTitle")}
      message={t("gateway.groups.removeMessage", { name: group.name })}
      pending={save.isPending}
      onCancel={onClose}
      onConfirm={() =>
        save.mutate(catalogWithoutGroup(catalog, group.id), {
          onSuccess: onClose,
        })
      }
    />
  );
}

/** Shares the status page's filtered query; the catalog only supplies the
 *  configured base topology. Historical names and paths still come from the
 *  traces so past requests render as they happened. */
export function RoutingFlow({
  data,
  catalog,
  bindings = EMPTY_BINDINGS,
  gatewayAddress,
  routeAppRequest,
  onRouteAppRequestHandled,
}: {
  data: GatewayTracePage;
  catalog?: GatewayCatalog;
  bindings?: readonly AccessBinding[];
  gatewayAddress?: string;
  /** 侧栏点了某个应用：进来后直接打开它的「设置应用路由」 */
  routeAppRequest?: RouteAppRequest | null;
  onRouteAppRequestHandled?: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [routeApp, setRouteApp] = useState<AppRouteDialogAppId | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  // 第一列的「添加其他应用」：新建一个三方应用（接入令牌），它随后就是一列里的
  // 一个应用节点。令牌只在签发时显示一次，所以保存后必须在这里再展示一次。
  const [keyDraft, setKeyDraft] = useState<AccessBinding | null>(null);
  // 已保存的三方应用：右上角铅笔打开的编辑弹窗，只有重新签发与删除两个动作。
  const [editKey, setEditKey] = useState<AccessBinding | null>(null);
  const [deleteKey, setDeleteKey] = useState<AccessBinding | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GatewayRouteGroup | null>(
    null,
  );
  // 侧栏点进来的应用：高亮它，并打开路由设置；请求只消费一次。
  useEffect(() => {
    if (!catalog || !routeAppRequest) return;
    if (
      isRoutableAppId(routeAppRequest.appId) &&
      routeAppRequest.appId !== "typesafe"
    ) {
      setRouteApp(routeAppRequest.appId);
      setFocus(routeAppRequest.appId);
    }
    onRouteAppRequestHandled?.();
  }, [catalog, routeAppRequest, onRouteAppRequestHandled]);
  const { apps, lanes, groups, outlets, liveCount } = useMemo(
    () => buildRoutingFlow(data, catalog, bindings),
    [data, catalog, bindings],
  );
  const appLabels = new Map(
    apps.map((entry) => [
      entry.appId,
      entry.binding?.name ||
        entry.lane?.trace.bindingName ||
        getAppLabel(entry.appId),
    ]),
  );
  const appLabel = (appId: string) =>
    appLabels.get(appId) ?? getAppLabel(appId);
  const timeline = useMemo(() => buildTimeline(lanes), [lanes]);
  const total = timeline.length;
  // 默认只列优先级最高的几行；展开后仍是同一份优先级顺序。
  const [appsExpanded, setAppsExpanded] = useState(false);
  // 用户手动挑过的应用：只在第一列显示这些，其余收起。没挑过（空集合）时保持
  // 原来的优先级 + 折叠规则。
  const [appSelection, setAppSelection] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pickingApps = appSelection.size > 0;
  // 手动挑选时先按挑选结果收窄，再走折叠规则；没挑选时就是完整列表。
  const pickedApps = useMemo(
    () =>
      pickingApps
        ? apps.filter((entry) => appSelection.has(entry.appId))
        : apps,
    [apps, appSelection, pickingApps],
  );
  const shownApps = useMemo(() => {
    // 用户自己挑了应用：他挑的就是他要看的，不受折叠上限约束。
    if (pickingApps) return pickedApps;
    if (appsExpanded) return pickedApps;
    // 默认可见数量是**硬上限**：已配置、有流量只是「优先占名额」的条件，
    // 不会让总数超过 VISIBLE_APP_LIMIT。
    const pinned = new Set<string>();
    for (const entry of pickedApps) {
      if (pinned.size >= VISIBLE_APP_LIMIT) break;
      // 进行中的应用、用户高亮的应用、已配置（接入了路由组）的应用优先占位。
      if (
        entry.configured ||
        entry.binding ||
        entry.lane?.live ||
        entry.appId === focus
      )
        pinned.add(entry.appId);
    }
    // 剩余名额按优先级顺序补满，总数恒等于上限。
    for (const entry of pickedApps) {
      if (pinned.size >= VISIBLE_APP_LIMIT) break;
      pinned.add(entry.appId);
    }
    return pickedApps.filter((entry) => pinned.has(entry.appId));
  }, [appsExpanded, focus, pickingApps, pickedApps]);
  const hiddenAppCount = pickedApps.length - shownApps.length;
  const toggleAppPick = (appId: string) =>
    setAppSelection((current) => {
      const next = new Set(current);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });

  // The stage grows with its tallest column; every node reports its real
  // box back so wires stay glued to the nodes at any size.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<FlowGeometry | null>(null);
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const next = readGeometry(stage);
    setGeometry((current) => (sameGeometry(current, next) ? current : next));
  }, []);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (observer) {
      observer.observe(stage);
      stage
        .querySelectorAll("[data-flow]")
        .forEach((node) => observer.observe(node));
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [shownApps, groups, outlets, measure]);

  useEffect(() => {
    setStep((current) =>
      current != null && current > total ? total : current,
    );
  }, [total]);

  useEffect(() => {
    if (!playing) return;
    if (step == null || step >= total) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep(step + 1), 900);
    return () => window.clearTimeout(timer);
  }, [playing, step, total]);

  // Hide configured edges whenever visible traffic connects the same nodes,
  // including shared groups/models reached by another app during replay.
  const visibleApps = new Set<string>();
  const visibleGroups = new Set<string>();
  const visibleOutlets = new Map<string, Set<string>>();
  for (const lane of lanes) {
    const playback = lanePlayback(lane, timeline, step);
    if (playback.visible) {
      visibleApps.add(lane.appId);
      visibleGroups.add(lane.groupKey);
    }
    for (const attempt of lane.attempts) {
      if (!playback.attemptVisible(attempt)) continue;
      const keys = visibleOutlets.get(lane.groupKey) ?? new Set<string>();
      keys.add(`${attempt.supplierId}|${attempt.model}`);
      visibleOutlets.set(lane.groupKey, keys);
    }
  }

  // 同一对节点之间的线会完全重叠，所以按出现顺序给每条线一个槽位：第一条
  // 居中，其余左右对称铺开。只有流量线参与扇出——配置层的灰线跨应用共享
  // 同一对节点，画的是同一条拓扑边，按应用各偏几个像素只会在节点边缘画出
  // 一束落在节点之外的错位线缆。
  const fanOut = (
    wires: { id: string; key: string }[],
  ): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const wire of wires) {
      counts.set(wire.key, (counts.get(wire.key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const offsets = new Map<string, number>();
    for (const wire of wires) {
      const index = seen.get(wire.key) ?? 0;
      seen.set(wire.key, index + 1);
      const count = counts.get(wire.key) ?? 1;
      offsets.set(wire.id, (index - (count - 1) / 2) * WIRE_FAN_GAP);
    }
    return offsets;
  };
  const laneGroupOffset = fanOut(
    lanes.map((lane) => ({ id: lane.appId, key: `g:${lane.groupKey}` })),
  );
  const laneAttemptOffset = fanOut(
    lanes.flatMap((lane) =>
      lane.attempts.map((attempt) => ({
        id: `${lane.appId}:${attempt.key}`,
        key: `a:${lane.groupKey}:${attempt.supplierId}|${attempt.model}`,
      })),
    ),
  );
  const trafficGroups = new Set(lanes.map((lane) => lane.groupKey));

  const laneStyle = (
    lane: FlowLane,
    state: FlowState,
  ): { "data-state": string; style: { stroke: string } } => ({
    "data-state": state,
    style: { stroke: laneColor(lane.appId) },
  });
  const dimmed = (appId: string): { "data-dimmed": "true" } | {} =>
    focus && focus !== appId ? { "data-dimmed": "true" } : {};

  const hub = geometry?.hub ?? null;
  const appBox = (appId: string) => geometry?.apps.get(appId);
  const groupBox = (key: string) => geometry?.groups.get(key);
  const modelBox = (key: string) => geometry?.models.get(key);
  const catalogGroup = (node: FlowGroupNode) =>
    node.groupId
      ? catalog?.groups?.find((group) => group.id === node.groupId)
      : undefined;
  const openNewGroup = () => {
    if (!catalog) return;
    setGroupDraft({
      group: createGroupDraft(),
      revision: catalog.revision,
      isNew: true,
    });
  };
  const openGroup = (group: GatewayRouteGroup) => {
    if (!catalog) return;
    setGroupDraft({
      group: structuredClone(group),
      revision: catalog.revision,
      isNew: false,
    });
  };

  return (
    <Card role="region" aria-label={t("gateway.flow.title")}>
      {(liveCount > 0 || total > 0) && (
        <CardHeader className="flex-row flex-wrap items-center justify-end gap-2 space-y-0 p-3 pb-0">
          {liveCount > 0 && (
            <Badge variant="outline">
              {t("gateway.flow.live", { count: liveCount })}
            </Badge>
          )}
          {!!total && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (playing) setPlaying(false);
                  else {
                    setStep(0);
                    setPlaying(true);
                  }
                }}
              >
                {t(playing ? "gateway.flow.pause" : "gateway.flow.replay")}
              </Button>
              {step != null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep(null);
                    setPlaying(false);
                  }}
                >
                  {t("gateway.flow.showAll")}
                </Button>
              )}
            </>
          )}
        </CardHeader>
      )}
      <CardContent className="p-4 pt-3">
        {apps.length ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="group"
            aria-labelledby={titleId}
          >
            <span className="sr-only" id={titleId}>
              {t("gateway.flow.diagram")}
            </span>
            {/* The stage has no fixed height: columns stack naturally and the
                tallest one defines the canvas. An absolutely positioned SVG
                overlays it and draws pixel-exact wires between the measured
                node boxes, so links can never drift off their endpoints. */}
            <div className="phi-flow-stage" ref={stageRef}>
              {/* Column 1 · apps — configured apps are always present; the
                  latest request adds the colored lane overlay on top. */}
              <div className="phi-flow-col phi-flow-app-col">
                <div className="phi-flow-app-tools">
                  <span id={`${titleId}-apps-label`}>
                    {t("gateway.flow.apps")}
                  </span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="phi-flow-pick"
                        aria-label={t("gateway.flow.pickApps")}
                        title={t("gateway.flow.pickApps")}
                        aria-haspopup="dialog"
                      >
                        <ListFilter aria-hidden />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 p-2">
                      <p className="m-0 px-1 pb-1.5 text-caption text-fg-3">
                        {t("gateway.flow.pickAppsHint")}
                      </p>
                      <ul className="m-0 flex max-h-72 list-none flex-col overflow-y-auto p-0">
                        {apps.map((entry) => {
                          const checked =
                            !pickingApps || appSelection.has(entry.appId);
                          return (
                            <li key={entry.appId}>
                              <label className="flex cursor-pointer items-center gap-2 rounded-control px-1.5 py-1.5 text-body text-fg-2 hover:bg-subtle">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={() =>
                                    toggleAppPick(entry.appId)
                                  }
                                />
                                <span className="min-w-0 truncate">
                                  {appLabel(entry.appId)}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-1 w-full justify-start"
                        disabled={!pickingApps}
                        onClick={() => setAppSelection(new Set())}
                      >
                        {t("gateway.flow.pickAppsReset")}
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>
                <ol
                  id={`${titleId}-apps`}
                  className="phi-flow-app-list"
                  aria-label={t("gateway.flow.apps")}
                >
                  {shownApps.map((entry) => {
                    const lane = entry.lane;
                    const playback = lane
                      ? lanePlayback(lane, timeline, step)
                      : null;
                    // System One 是决策协议的虚拟应用：路由目标由组推导，
                    // 没有可写的应用配置，因此不提供「设置应用路由」。
                    const routableAppId =
                      isRoutableAppId(entry.appId) && entry.appId !== "typesafe"
                        ? entry.appId
                        : null;
                    // 三方应用（接入令牌）不在应用配置里，编辑它就是重新签发
                    // 令牌或删除应用，所以右上角给铅笔而不是路由齿轮。
                    const editableBinding = entry.binding ?? null;
                    return (
                      <li
                        key={entry.appId}
                        className="phi-flow-node"
                        data-flow="app"
                        data-flow-key={entry.appId}
                        data-kind="app"
                        data-app-kind={entry.binding ? "binding" : "builtin"}
                        data-disabled={
                          entry.binding?.enabled === false ? "true" : undefined
                        }
                        data-has-action={
                          catalog && routableAppId ? "true" : undefined
                        }
                        data-badge={
                          entry.binding ? t("access.externalBadge") : undefined
                        }
                        data-state={
                          lane
                            ? playback!.visible
                              ? laneFinalState(lane)
                              : "dimmed"
                            : "idle"
                        }
                        data-dimmed={
                          focus && focus !== entry.appId ? "true" : undefined
                        }
                      >
                        <button
                          type="button"
                          className="phi-flow-hit"
                          aria-label={t("gateway.flow.focusApp", {
                            app: appLabel(entry.appId),
                          })}
                          aria-pressed={focus === entry.appId}
                          onClick={() =>
                            setFocus((current) =>
                              current === entry.appId ? null : entry.appId,
                            )
                          }
                        >
                          <ProviderIcon
                            icon={getAppIconName(entry.appId) ?? undefined}
                            name={appLabel(entry.appId)}
                            size={18}
                            className="phi-flow-app-icon"
                          />
                          <strong>{appLabel(entry.appId)}</strong>
                          <span
                            className="truncate font-mono text-xs text-fg-3"
                            title={
                              lane
                                ? `${readableRequestModel(lane.trace.requestModel, catalog) || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                                : undefined
                            }
                          >
                            {entry.binding?.enabled === false
                              ? t("gateway.groups.off")
                              : lane
                                ? `${readableRequestModel(lane.trace.requestModel, catalog) || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                                : entry.staticRoutes.length
                                  ? t("gateway.flow.idle")
                                  : t("gateway.flow.noGroup")}
                          </span>
                        </button>
                        {catalog && routableAppId && (
                          <button
                            type="button"
                            className="phi-flow-action"
                            aria-label={t("gateway.flow.routeSettingsFor", {
                              app: appLabel(entry.appId),
                            })}
                            title={t("gateway.flow.routeSettings")}
                            onClick={() => setRouteApp(routableAppId)}
                          >
                            <Settings2 aria-hidden />
                          </button>
                        )}
                        {editableBinding && (
                          <button
                            type="button"
                            className="phi-flow-action"
                            aria-label={t("gateway.flow.editAppFor", {
                              app: appLabel(entry.appId),
                            })}
                            title={t("gateway.flow.editApp")}
                            onClick={() => setEditKey(editableBinding)}
                          >
                            <Pencil aria-hidden />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {!pickingApps && apps.length > VISIBLE_APP_LIMIT && (
                  <button
                    type="button"
                    className="phi-flow-more"
                    aria-expanded={appsExpanded}
                    aria-controls={`${titleId}-apps`}
                    onClick={() => setAppsExpanded((value) => !value)}
                  >
                    <ChevronDown
                      aria-hidden
                      className={appsExpanded ? "rotate-180" : undefined}
                    />
                    {appsExpanded
                      ? t("gateway.flow.fewerApps")
                      : t("gateway.flow.moreApps", {
                          count: hiddenAppCount,
                        })}
                  </button>
                )}
                {/* 没有现成接入的应用在这里新建：一个三方应用等于一枚接入令牌，
                    保存后它就以自己的身份出现在本列与用量页。 */}
                <button
                  type="button"
                  className="phi-flow-add"
                  onClick={() =>
                    setKeyDraft(
                      freshBinding(
                        apps.some((entry) => entry.binding) ? "" : "PHI",
                      ),
                    )
                  }
                >
                  <Plus aria-hidden />
                  {t("gateway.flow.addApp")}
                </button>
              </div>
              {/* Column 2 · PHI */}
              <div className="phi-flow-col phi-flow-hub-wrap">
                <div className="phi-flow-node phi-flow-hub" data-flow="hub">
                  <PhiFlowLogo />
                  {gatewayAddress && (
                    <button
                      type="button"
                      className="phi-flow-address"
                      title={t("gateway.flow.copyAddress", {
                        address: gatewayAddress,
                      })}
                      aria-label={t("gateway.flow.copyAddress", {
                        address: gatewayAddress,
                      })}
                      onClick={() => copyGatewayAddress(gatewayAddress)}
                    >
                      {gatewayAddress}
                    </button>
                  )}
                  {step != null && (
                    <Badge variant="outline">
                      {t("gateway.flow.step", { current: step, total })}
                    </Badge>
                  )}
                </div>
              </div>
              {/* Column 3 · route groups — every catalog group lives here so a
                  new or not-yet-connected group can still be edited. */}
              <div className="phi-flow-col">
                {catalog && (
                  <button
                    type="button"
                    className="phi-flow-add"
                    onClick={openNewGroup}
                  >
                    <Plus aria-hidden />
                    {t("gateway.groups.new")}
                  </button>
                )}
                <ol
                  className="phi-flow-group-list"
                  aria-label={t("gateway.flow.groups")}
                >
                  {groups.map((group) => {
                    const editable = catalogGroup(group);
                    return (
                      <li
                        key={group.key}
                        className="phi-flow-node"
                        data-flow="group"
                        data-flow-key={group.key}
                        data-kind="group"
                        data-disabled={
                          group.enabled === false ? "true" : undefined
                        }
                        data-has-action={editable ? "true" : undefined}
                        data-static={
                          trafficGroups.has(group.key) ? undefined : "true"
                        }
                      >
                        <div className="phi-flow-node-text">
                          <strong
                            className="w-full truncate"
                            title={group.name}
                          >
                            {group.name}
                          </strong>
                          {group.enabled === false ? (
                            <span className="text-xs text-fg-3">
                              {t("gateway.groups.off")}
                            </span>
                          ) : group.strategy ? (
                            <span className="text-xs text-fg-3">
                              {t(
                                `gateway.groups.strategies.${group.strategy}`,
                                {
                                  defaultValue: group.strategy,
                                },
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-fg-3">
                              {t("gateway.flow.legacyPolicy")}
                            </span>
                          )}
                        </div>
                        {editable && (
                          <button
                            type="button"
                            className="phi-flow-action"
                            aria-label={t("gateway.groups.editFor", {
                              name: group.name,
                            })}
                            title={t("gateway.groups.edit")}
                            onClick={() => openGroup(editable)}
                          >
                            <Pencil aria-hidden />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
              {/* Column 4 · models — configured members without traffic keep
                  a neutral idle state. */}
              <ol
                className="phi-flow-col phi-flow-outlets"
                aria-label={t("gateway.flow.models")}
              >
                {outlets.map((outlet) => (
                  <li
                    key={outlet.key}
                    className="phi-flow-node"
                    data-flow="model"
                    data-flow-key={outlet.key}
                    data-kind="model"
                    data-state={outlet.state ?? undefined}
                    data-static={outlet.state == null ? "true" : undefined}
                  >
                    <span className="phi-flow-dot" aria-hidden />
                    <div className="min-w-0 flex-1 text-start">
                      <p
                        className="truncate text-sm font-medium"
                        title={outlet.supplierName}
                      >
                        {outlet.supplierName}
                      </p>
                      <p
                        className="truncate font-mono text-xs text-fg-2"
                        title={outlet.model}
                      >
                        {outlet.model}
                      </p>
                    </div>
                    {outlet.state && outlet.state !== "completed" && (
                      <span className="text-xs text-fg-3">
                        {t(`gateway.flow.states.${outlet.state}`)}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {/* Wires: app → PHI → group → model. Drawn once geometry is
                  measured; every path starts and ends on a node edge. */}
              <svg
                className="phi-flow-wires"
                width={geometry?.width ?? 0}
                height={geometry?.height ?? 0}
                viewBox={`0 0 ${geometry?.width ?? 0} ${geometry?.height ?? 0}`}
                preserveAspectRatio="none"
                aria-hidden
              >
                <g data-region="app">
                  {hub &&
                    apps.map((entry) => {
                      if (!entry.configured || visibleApps.has(entry.appId))
                        return null;
                      const from = appBox(entry.appId);
                      if (!from) return null;
                      return (
                        <path
                          key={`static:${entry.appId}`}
                          d={wirePath(from, hub)}
                          data-state="static"
                          {...dimmed(entry.appId)}
                        />
                      );
                    })}
                  {hub &&
                    lanes.map((lane) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.visible) return null;
                      const from = appBox(lane.appId);
                      if (!from) return null;
                      const state = playback.done
                        ? laneFinalState(lane)
                        : "active";
                      return (
                        <path
                          key={lane.appId}
                          d={wirePath(from, hub)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    })}
                </g>
                <g data-region="group">
                  {hub &&
                    apps.flatMap((entry) =>
                      entry.staticRoutes.map((route) => {
                        if (visibleGroups.has(route.groupKey)) return null;
                        const target = groupBox(route.groupKey);
                        if (!target) return null;
                        return (
                          <path
                            key={`static:${entry.appId}:${route.groupKey}`}
                            d={wirePath(hub, target)}
                            data-state="static"
                            {...dimmed(entry.appId)}
                          />
                        );
                      }),
                    )}
                  {hub &&
                    lanes.map((lane) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.visible) return null;
                      const target = groupBox(lane.groupKey);
                      if (!target) return null;
                      const state = playback.done
                        ? laneFinalState(lane)
                        : "active";
                      const offset = laneGroupOffset.get(lane.appId) ?? 0;
                      return (
                        <path
                          key={lane.appId}
                          d={wirePath(hub, target, offset)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    })}
                </g>
                <g data-region="model">
                  {apps.flatMap((entry) =>
                    entry.staticRoutes.flatMap((route) =>
                      route.outletKeys.map((key) => {
                        if (visibleOutlets.get(route.groupKey)?.has(key))
                          return null;
                        const from = groupBox(route.groupKey);
                        const to = modelBox(key);
                        if (!from || !to) return null;
                        return (
                          <path
                            key={`static:${entry.appId}:${route.groupKey}:${key}`}
                            d={wirePath(from, to)}
                            data-state="static"
                            {...dimmed(entry.appId)}
                          />
                        );
                      }),
                    ),
                  )}
                  {lanes.flatMap((lane) =>
                    lane.attempts.map((attempt) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.attemptVisible(attempt)) return null;
                      const outletKey = `${attempt.supplierId}|${attempt.model}`;
                      const from = groupBox(lane.groupKey);
                      const to = modelBox(outletKey);
                      if (!from || !to) return null;
                      const offset =
                        laneAttemptOffset.get(`${lane.appId}:${attempt.key}`) ??
                        0;
                      const state: FlowState =
                        playback.headAttempt === attempt.key
                          ? "active"
                          : attempt.state;
                      return (
                        <path
                          key={`${lane.appId}:${attempt.key}`}
                          d={wirePath(from, to, offset)}
                          data-dimmed={
                            focus && focus !== lane.appId ? "true" : undefined
                          }
                          {...laneStyle(lane, state)}
                        />
                      );
                    }),
                  )}
                </g>
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-5">
            <div
              className="flex items-center justify-center gap-4 text-sm text-fg-2"
              aria-hidden
            >
              <span>{t("gateway.flow.apps")}</span>
              <span>→</span>
              <PhiFlowLogo />
              <span>→</span>
              <span>{t("gateway.flow.groups")}</span>
              <span>→</span>
              <span>{t("gateway.flow.models")}</span>
            </div>
            <p role="status" className="text-center text-sm text-fg-3">
              {t("gateway.flow.empty")}
            </p>
          </div>
        )}
        {!!apps.length && (
          <div
            className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-xs text-fg-2"
            aria-label={t("gateway.flow.legend")}
          >
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-active"
                aria-hidden
              />
              {t("gateway.flow.lineActive")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-completed"
                aria-hidden
              />
              {t("gateway.flow.lineCompleted")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-failed"
                aria-hidden
              />
              {t("gateway.flow.lineFailed")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-unknown"
                aria-hidden
              />
              {t("gateway.flow.lineUnknown")}
            </span>
            <span className="phi-flow-key">
              <span
                className="phi-flow-line phi-flow-line-static"
                aria-hidden
              />
              {t("gateway.flow.configured")}
            </span>
            {lanes.map((lane) => {
              const color = laneColor(lane.appId);
              return (
                <span
                  key={lane.appId}
                  className="phi-flow-key"
                  data-state={laneFinalState(lane)}
                >
                  <span
                    className="phi-flow-line"
                    style={{ background: color }}
                    aria-hidden
                  />
                  {appLabel(lane.appId)}
                  {lane.live && (
                    <span className="text-fg-3">
                      · {t("gateway.flow.liveOne")}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {routeApp && catalog && (
          <AppRouteSettingsDialog
            app={routeApp}
            catalog={catalog}
            open
            onOpenChange={(open) => {
              if (!open) setRouteApp(null);
            }}
          />
        )}
        {groupDraft && catalog && (
          <GroupEditorHost
            catalog={catalog}
            draft={groupDraft}
            onClose={() => setGroupDraft(null)}
            onDeleteRequest={(group) => {
              setDeletingGroup(group);
              setGroupDraft(null);
            }}
          />
        )}
        {deletingGroup && catalog && (
          <GroupDeleteDialog
            catalog={catalog}
            group={deletingGroup}
            onClose={() => setDeletingGroup(null)}
          />
        )}
        <AccessKeyDialog
          draft={keyDraft}
          onChange={setKeyDraft}
          onClose={() => setKeyDraft(null)}
          onIssued={(token) => {
            setKeyDraft(null);
            setIssuedToken(token);
          }}
        />
        {/* 编辑就是重新签发：令牌只在签发时显示一次，所以完成后再弹令牌。 */}
        <AccessKeyDialog
          variant="edit"
          draft={editKey}
          onChange={setEditKey}
          onClose={() => setEditKey(null)}
          onDeleteRequest={(binding) => {
            setEditKey(null);
            setDeleteKey(binding);
          }}
          onIssued={(token) => {
            setEditKey(null);
            setIssuedToken(token);
          }}
        />
        <AccessDeleteDialog
          binding={deleteKey}
          onClose={() => setDeleteKey(null)}
        />
        <IssuedTokenDialog
          token={issuedToken}
          onClose={() => setIssuedToken(null)}
        />
      </CardContent>
    </Card>
  );
}
