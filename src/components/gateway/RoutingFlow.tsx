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
import {
  Check,
  ChevronDown,
  Copy,
  ListFilter,
  Pencil,
  Plus,
  Settings2,
} from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
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
  type FlowAppEntry,
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

/** 只用于跟随窗口宽度调图表密度：唯一的状态是这条媒体查询的真假。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

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

/** 应用节点第二行显示什么：无流量时先说明它接入了哪个组（而不是只写「未运行」），
 *  有流量时给一个短状态——这一段是 12px 的次要信息，塞不下就用省略号截断。 */
function appMetaLabel(entry: FlowAppEntry, catalog?: GatewayCatalog): string {
  if (entry.lane) return appMetaOf(entry.lane.trace.requestModel, catalog);
  if (entry.binding?.enabled === false) return "off";
  return entry.staticRoutes.length ? "connected" : "noGroup";
}

/** 请求模型名去掉 `group/` 前缀：节点只有 128–180px 宽，「group/dfsfs」会
 *  把路由组名挤成省略号，而这个前缀在流程图里没有额外信息。 */
function appMetaOf(model: string | undefined, catalog?: GatewayCatalog) {
  return readableRequestModel(model, catalog).replace(/^group\//, "");
}

/** 点节点上的地址就整段复制：流转图的用处就是让你照抄进客户端。 */
function copyGatewayAddress(address: string) {
  void navigator.clipboard?.writeText(address).catch(() => undefined);
}

/** 把地址拆成「协议+主机」和「路径」两段：窄窗口一行放不下时，只允许在
 *  这两段之间换行，绝不把 http:// 自己拆开（那看起来像协议头丢了）。 */
export function splitGatewayAddress(address: string): [string, string] {
  const hostStart = address.indexOf("//");
  const cut = address.indexOf("/", hostStart === -1 ? 0 : hostStart + 2);
  if (cut <= 0) return [address, ""];
  return [address.slice(0, cut), address.slice(cut)];
}

/** 默认展开的应用行数。应用变多以后，靠后的应用折叠起来，图不会被拉得
 *  很长；已接入路由组的应用、任何一个还在传输中的应用、以及三方应用都不受
 *  折叠影响，所以实际可能比这个数多。 */
const VISIBLE_APP_LIMIT = 5;
/** 1200px 以下放不下默认 5 行，收到 4 行：滚动条不该出现在默认状态。 */
const VISIBLE_APP_LIMIT_NARROW = 3;
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
  /** 应用列表自己的可视框：展开后它会滚动，滚出去的节点不画线。 */
  list: NodeBox | null;
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

function readGeometry(
  stage: HTMLElement,
  list?: HTMLElement | null,
): FlowGeometry {
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
    // 量不到尺寸（未布局 / 测试环境）时不启用「滚动可视区」判断，否则每一行
    // 都会被当成滚出去了，连线全部消失。
    list:
      list && list.getBoundingClientRect().height > 0
        ? boxOf(list, stageBox)
        : null,
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
    !sameBox(a.hub ?? undefined, b.hub ?? undefined) ||
    !sameBox(a.list ?? undefined, b.list ?? undefined)
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
  // 这张图是首页的第一眼，默认行数不能把卡片撑出滚动条：1240px 以下收一行。
  const appLimit = useMediaQuery("(max-width: 1239px)")
    ? VISIBLE_APP_LIMIT_NARROW
    : VISIBLE_APP_LIMIT;
  const shownApps = useMemo(() => {
    // 用户自己挑了应用：他挑的就是他要看的，不受折叠上限约束。
    if (pickingApps) return pickedApps;
    if (appsExpanded) return pickedApps;
    // 默认可见数量是**硬上限**：已配置、有流量只是「优先占名额」的条件，
    // 不会让总数超过 appLimit。
    const pinned = new Set<string>();
    for (const entry of pickedApps) {
      if (pinned.size >= appLimit) break;
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
      if (pinned.size >= appLimit) break;
      pinned.add(entry.appId);
    }
    return pickedApps.filter((entry) => pinned.has(entry.appId));
  }, [appLimit, appsExpanded, focus, pickingApps, pickedApps]);
  const hiddenAppCount = pickedApps.length - shownApps.length;
  const toggleAppPick = (appId: string) =>
    setAppSelection((current) => {
      // 起点是「全部」：挑选弹层一打开，勾选框全是勾上的。第一次取消谁，就该
      // 从全部里减掉谁；否则用户点掉 Codex，看到的是「只剩 Codex」，而那个
      // 勾选框还赖在勾上的状态里——操作和反馈正好相反。
      const next = new Set(
        current.size > 0 ? current : apps.map((entry) => entry.appId),
      );
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });

  // The stage grows with its tallest column; every node reports its real
  // box back so wires stay glued to the nodes at any size.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [geometry, setGeometry] = useState<FlowGeometry | null>(null);
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const next = readGeometry(stage, listRef.current);
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
    // 展开后应用列表在自己的框里滚动：滚动时节点换了位置，连线必须跟着重算。
    const list = listRef.current;
    const onScroll = () => measure();
    list?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      list?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
    };
  }, [shownApps, groups, outlets, measure, appsExpanded]);

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

  /** 应用列展开后会在自己的框里滚动，滚出可视区的应用不画线：否则线会从
   *  看不见的位置冒出来，飘在卡片空白处。整条线（应用 → 组 → 模型）按这个
   *  判断一起出现或一起消失。 */
  const appInView = (appId: string): boolean => {
    const box = geometry?.apps.get(appId);
    if (!box) return false;
    const list = geometry?.list;
    if (!list) return true;
    return box.bottom > list.top + 1 && box.top < list.bottom - 1;
  };

  // Hide configured edges whenever visible traffic connects the same nodes,
  // including shared groups/models reached by another app during replay.
  const visibleApps = new Set<string>();
  const visibleGroups = new Set<string>();
  const visibleOutlets = new Map<string, Set<string>>();
  for (const lane of lanes) {
    // 应用被滚出可视区时，这条 lane 整条都不画，它的组/出口也就不该再被
    // 当成「已有可见流量」——否则配置层的灰线会被一起藏掉，右半边空掉。
    if (!appInView(lane.appId)) continue;
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

  const appRow = useMemo(
    () => new Map(shownApps.map((entry, index) => [entry.appId, index])),
    [shownApps],
  );
  // 同一对节点之间的线会完全重叠，所以给每条线一个槽位。槽位顺序按**源应用
  // 在列里的上下位置**排：上面的应用落到上缘、下面的落到下缘，线才不会在
  // 节点前交叉成一团。配置层的灰线跨应用共享同一对节点，画的是同一条拓扑边，
  // 不参与扇出。
  const spreadByAppRow = useCallback(
    <T,>(
      items: readonly T[],
      idOf: (item: T) => string,
      keyOf: (item: T) => string,
      appOf: (item: T) => string,
    ): Map<string, number> => {
      const buckets = new Map<string, T[]>();
      for (const item of items) {
        const key = keyOf(item);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(item);
        else buckets.set(key, [item]);
      }
      const offsets = new Map<string, number>();
      for (const bucket of buckets.values()) {
        const ordered = [...bucket].sort(
          (a, b) => (appRow.get(appOf(a)) ?? 0) - (appRow.get(appOf(b)) ?? 0),
        );
        ordered.forEach((item, index) => {
          offsets.set(
            idOf(item),
            (index - (ordered.length - 1) / 2) * WIRE_FAN_GAP,
          );
        });
      }
      return offsets;
    },
    [appRow],
  );
  const laneHubOffset = spreadByAppRow(
    lanes,
    (lane) => lane.appId,
    () => "hub",
    (lane) => lane.appId,
  );
  const laneGroupOffset = spreadByAppRow(
    lanes,
    (lane) => lane.appId,
    (lane) => lane.groupKey,
    (lane) => lane.appId,
  );
  const laneAttemptOffset = spreadByAppRow(
    lanes.flatMap((lane) =>
      lane.attempts.map((attempt) => ({ lane, attempt })),
    ),
    ({ lane, attempt }) => `${lane.appId}:${attempt.key}`,
    ({ lane, attempt }) =>
      `${lane.groupKey}|${attempt.supplierId}|${attempt.model}`,
    ({ lane }) => lane.appId,
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
  /** 配置层的边按「节点对」去重：多个应用接到同一个组时，以前会给同一条
   *  拓扑边各画一条——重复的 DOM，而且 35% 透明度的灰线叠成一根深灰线。 */
  const staticGroupEdges = [
    ...new Set(
      apps.flatMap((entry) =>
        entry.staticRoutes.map((route) => route.groupKey),
      ),
    ),
  ];
  const staticOutletEdges = new Map<
    string,
    { groupKey: string; outletKey: string }
  >();
  for (const entry of apps) {
    for (const route of entry.staticRoutes) {
      for (const key of route.outletKeys) {
        staticOutletEdges.set(`${route.groupKey}|${key}`, {
          groupKey: route.groupKey,
          outletKey: key,
        });
      }
    }
  }

  return (
    <Card
      role="region"
      aria-label={t("gateway.flow.title")}
      className="overflow-hidden shadow-v7-md"
    >
      {/* 图是首页的主体，工具只能待在一条线上：标题在左，回放与实时计数在右。
          以前回放按钮单独占一行、还在卡片内部顶端，把主体挤下去 40px。 */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-2.5">
        <div className="min-w-0">
          <h2 className="sr-only">{t("gateway.flow.title")}</h2>
          <p
            id={titleId}
            className="truncate text-strong text-fg-1"
            title={t("gateway.flow.description")}
          >
            {t("gateway.flow.title")}
            <span className="ms-2 text-caption font-normal text-fg-3">
              {t("gateway.flow.description")}
            </span>
          </p>
        </div>
        {(liveCount > 0 || total > 0) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {liveCount > 0 && (
              <Badge variant="outline">
                {t("gateway.flow.live", { count: liveCount })}
              </Badge>
            )}
            {!!total && (
              <>
                {step != null && (
                  <span className="text-caption tabular-nums text-fg-3">
                    {t("gateway.flow.step", {
                      current: Math.min(step + 1, total),
                      total,
                    })}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // 暂停后按的是「继续」：从中断的那一步接着走，
                    // 不能悄悄从头重放（以前这里是 setStep(0)）。
                    if (playing) {
                      setPlaying(false);
                      return;
                    }
                    if (step == null || step >= total) setStep(0);
                    setPlaying(true);
                  }}
                >
                  {t(
                    playing
                      ? "gateway.flow.pause"
                      : step != null && step < total
                        ? "gateway.flow.resume"
                        : "gateway.flow.replay",
                  )}
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
          </div>
        )}
      </div>
      <CardContent className="px-5 py-4">
        {apps.length ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="group"
            aria-labelledby={titleId}
          >
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
                  ref={listRef}
                  className="phi-flow-app-list"
                  /* 展开后列表自己滚：图整体高度有上限，另外三列不会被推出屏幕。 */
                  data-scroll={appsExpanded ? "true" : undefined}
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
                        {lane && (
                          <span
                            className="phi-flow-lane-bar"
                            style={{ background: laneColor(entry.appId) }}
                            aria-hidden
                          />
                        )}
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
                          <span className="phi-flow-app-row">
                            <ProviderIcon
                              icon={getAppIconName(entry.appId) ?? undefined}
                              name={appLabel(entry.appId)}
                              size={16}
                              className="phi-flow-app-icon"
                              showFallback={false}
                            />
                            <strong title={appLabel(entry.appId)}>
                              {appLabel(entry.appId)}
                            </strong>
                          </span>
                          <span
                            className="truncate text-xs text-fg-3"
                            title={
                              lane
                                ? `${readableRequestModel(lane.trace.requestModel, catalog) || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                                : undefined
                            }
                          >
                            {appMetaLabel(entry, catalog) === "off"
                              ? t("gateway.groups.off")
                              : appMetaLabel(entry, catalog) === "connected"
                                ? t("gateway.flow.connected")
                                : appMetaLabel(entry, catalog) === "noGroup"
                                  ? t("gateway.flow.noGroup")
                                  : lane
                                    ? `${appMetaLabel(entry, catalog) || "—"} · ${new Date(lane.trace.createdAt).toLocaleTimeString()}`
                                    : t("gateway.flow.idle")}
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
                {!pickingApps && apps.length > appLimit && (
                  <button
                    type="button"
                    className="phi-flow-more"
                    aria-expanded={appsExpanded}
                    aria-controls={`${titleId}-apps`}
                    onClick={() => {
                      setAppsExpanded((value) => !value);
                      if (listRef.current) listRef.current.scrollTop = 0;
                    }}
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
                </div>
                {/* 地址移到卡片外面：卡宽放不下 21 个字符，截成
                    http://127.0.0.1:30… 就等于让你抄一半。 */}
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
                    <span className="phi-flow-address-text">
                      <span className="phi-flow-address-origin">
                        {splitGatewayAddress(gatewayAddress)[0]}
                      </span>
                      <span className="phi-flow-address-path">
                        {splitGatewayAddress(gatewayAddress)[1]}
                      </span>
                    </span>
                    <Copy className="phi-flow-address-icon" aria-hidden />
                  </button>
                )}
              </div>
              {/* Column 3 · route groups — every catalog group lives here so a
                  new or not-yet-connected group can still be edited. */}
              <div className="phi-flow-col">
                <p className="phi-flow-col-label">{t("gateway.flow.groups")}</p>
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
              </div>
              {/* Column 4 · models — configured members without traffic keep
                  a neutral idle state. */}
              <div className="phi-flow-col">
                <p className="phi-flow-col-label">{t("gateway.flow.models")}</p>
                <ol
                  className="phi-flow-outlets"
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
                      <div className="min-w-0 flex-1 text-start">
                        <p
                          className="truncate text-caption font-medium text-fg-2"
                          title={outlet.supplierName}
                        >
                          {outlet.supplierName}
                        </p>
                        <p
                          className="truncate font-mono text-sm text-fg-1"
                          title={outlet.model}
                        >
                          {outlet.model}
                        </p>
                      </div>
                      {outlet.state === "completed" ? (
                        <Check
                          aria-label={t("gateway.trace.outcomes.completed")}
                          className="phi-flow-status-icon"
                          data-state="completed"
                        />
                      ) : outlet.state ? (
                        <span
                          className="phi-flow-status"
                          data-state={outlet.state}
                        >
                          {t(`gateway.flow.states.${outlet.state}`)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
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
                      if (!from || !appInView(entry.appId)) return null;
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
                      if (!from || !appInView(lane.appId)) return null;
                      const state = playback.done
                        ? laneFinalState(lane)
                        : "active";
                      return (
                        <path
                          key={lane.appId}
                          d={wirePath(
                            from,
                            hub,
                            laneHubOffset.get(lane.appId) ?? 0,
                          )}
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
                    staticGroupEdges.map((key) => {
                      if (visibleGroups.has(key)) return null;
                      const target = groupBox(key);
                      if (!target) return null;
                      return (
                        <path
                          key={`static:${key}`}
                          d={wirePath(hub, target)}
                          data-state="static"
                        />
                      );
                    })}
                  {hub &&
                    lanes.map((lane) => {
                      const playback = lanePlayback(lane, timeline, step);
                      if (!playback.visible || !appInView(lane.appId))
                        return null;
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
                  {[...staticOutletEdges.entries()].map(([key, edge]) => {
                    if (visibleOutlets.get(edge.groupKey)?.has(edge.outletKey))
                      return null;
                    const from = groupBox(edge.groupKey);
                    const to = modelBox(edge.outletKey);
                    if (!from || !to) return null;
                    return (
                      <path
                        key={`static:${key}`}
                        d={wirePath(from, to)}
                        data-state="static"
                      />
                    );
                  })}
                  {lanes.flatMap((lane) =>
                    lane.attempts.map((attempt) => {
                      // 整条线（应用 → 组 → 模型）要么都在，要么都不在：应用被
                      // 滚出去以后只留后半段，线会从 hub 上空着长出来。
                      if (!appInView(lane.appId)) return null;
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
      {!!apps.length && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-subtle px-5 py-2.5 text-xs text-fg-3"
          aria-label={t("gateway.flow.legend")}
        >
          <span className="phi-flow-key">
            <span className="phi-flow-line phi-flow-line-active" aria-hidden />
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
            <span className="phi-flow-line phi-flow-line-failed" aria-hidden />
            {t("gateway.flow.lineFailed")}
          </span>
          <span className="phi-flow-key">
            <span className="phi-flow-line phi-flow-line-unknown" aria-hidden />
            {t("gateway.flow.lineUnknown")}
          </span>
          <span className="phi-flow-key">
            <span className="phi-flow-line phi-flow-line-static" aria-hidden />
            {t("gateway.flow.configured")}
          </span>
          {/* 应用色不再在这里列一遍：每个应用节点左缘已经有自己的线色，
              图例只说明线型。 */}
          {lanes.length > 0 && (
            <span className="phi-flow-key">
              <span className="phi-flow-lane-bar-sample" aria-hidden />
              {t("gateway.flow.laneCount", { count: lanes.length })}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
