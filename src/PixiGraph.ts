/**
 * PixiGraph — DELTAFlow 캔버스 도면 그래프 렌더링 라이브러리 (기본 iteration).
 *
 * 책임 (이번 iteration):
 *  - 데이터 모델: 노드/엣지 add/remove/clear
 *  - 렌더링: per-element pixi Graphics. 노드 = 사각형 fill, 엣지 = 두 노드 중심 연결선.
 *  - 쿼리: element(id) / elements() / nodes() / edges() / $('#id')
 *  - 리소스 정리: destroy()
 *
 * 비-책임 (이번 iteration X — 향후 단계별 추가):
 *  - 상태 (selected / hovered / classes)
 *  - 이벤트 (tap / cxttap / mouseover ... — DOM/pixi 위임)
 *  - hidden / visibility / opacity 조작
 *  - selector 쿼리 (cytoscape `:selected.hovered` 같은 복합 selector)
 *  - hit-test (point → element)
 *  - 스타일 규칙 시스템 (상태별 cascading style)
 *
 * 사용 예:
 * ```ts
 *   const graph = new PixiGraph();
 *   parentContainer.addChild(graph.view);
 *   graph.add({
 *     nodes: [{ id: 'n1', bbox: { x: 10, y: 10, w: 40, h: 40 }, data: {...} }],
 *     edges: [{ id: 'e1', source: 'n1', target: 'n2', data: {...} }],
 *   });
 *   const ele = graph.element('n1');
 *   ele?.connectedEdges();
 *   graph.destroy();
 * ```
 *
 * 좌표계 — 모든 입력 bbox 는 graph-local pixel 좌표. 부모 컨테이너의 scale/translate 이
 * world ↔ local 변환을 담당하므로 graph 내부에선 단위 일관.
 */

import { Container, Graphics } from 'pixi.js';
import {
  DEFAULT_PIXIGRAPH_STYLE,
  type GraphBbox,
  type GraphPoint,
  type PixiGraphAddInput,
  type PixiGraphConfig,
  type PixiGraphEdgeInput,
  type PixiGraphNodeInput,
} from './types';
import { PixiGraphElement, type EdgeMeta } from './PixiGraphElement';
import {
  StyleEngine,
  type PixiGraphStyleProps,
  type PixiGraphStyleRule,
} from './PixiGraphStyle';
import {
  PixiGraphEventBus,
  type PixiGraphEventType,
  type PixiGraphFeedType,
  type PixiGraphHandler,
} from './PixiGraphEvents';
import { HighlightManager, type PixiGraphHighlightInput } from './PixiGraphHighlights';
import * as ClipboardModule from './PixiGraphClipboard';
import { ptSegDist, projectOnSeg } from './PixiGraphGeometry';
import { PixiGraphPreview } from './PixiGraphPreview';
import { PixiGraphHistory } from './PixiGraphHistory';

/**
 * 점 (px, py) 에서 선분 (x1,y1)→(x2,y2) 까지 최단거리.
 * edge hit-test 에 사용. 길이 0 선분이면 두 점 거리.
 */
const distancePointSegment = (
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number => {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/**
 * 점 (x,y) 이 다각형 내부인지 — ray casting. flat = [x0,y0,x1,y1,...] (절대 graph-local 좌표).
 * 다각형 노드 hit-test 에 사용 (bbox 가 아니라 실제 polygon 영역).
 */
const pointInPolygon = (x: number, y: number, flat: number[]): boolean => {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2], yi = flat[i * 2 + 1];
    const xj = flat[j * 2], yj = flat[j * 2 + 1];
    const intersect = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

/**
 * center 에서 toward 방향 ray 가 다각형(flat=[x0,y0,...]) 외곽선과 만나는 점 중
 * center 에 가장 가까운 것(가장 작은 t>0). 없으면 null. polygon 노드의 엣지 끝점 clip 용.
 */
const rayPolygonExit = (center: GraphPoint, toward: GraphPoint, flat: number[]): GraphPoint | null => {
  const dx = toward.x - center.x, dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return null;
  let bestT = Infinity;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = flat[j * 2], y1 = flat[j * 2 + 1];
    const sx = flat[i * 2] - x1, sy = flat[i * 2 + 1] - y1;
    const denom = dx * sy - dy * sx;
    if (Math.abs(denom) < 1e-9) continue;          // ray ∥ segment
    const acx = x1 - center.x, acy = y1 - center.y;
    const t = (acx * sy - acy * sx) / denom;       // ray 파라미터
    const u = (acx * dy - acy * dx) / denom;       // segment 파라미터 [0,1]
    if (t > 1e-6 && u >= 0 && u <= 1 && t < bestT) bestT = t;
  }
  return bestT === Infinity ? null : { x: center.x + dx * bestT, y: center.y + dy * bestT };
};

/**
 * 노드 bbox 의 중심에서 `toward` 방향으로 ray 를 쏠 때 bbox 경계와 만나는 점.
 *
 * 엣지가 노드 중심까지 뚫고 들어가지 않고 노드 표면에서 멈추도록 끝점을 clip 하는 용도.
 * cytoscape 의 edge endpoint anchoring 과 동일한 동작.
 *
 *  - bbox 는 image-local 좌표의 사각형 (axis-aligned).
 *  - center 가 정확히 bbox 의 기하학적 중심이라고 가정 (PixiGraph 에선 항상 그렇다).
 *  - toward 가 center 와 같으면 center 그대로 반환 (degenerate).
 *
 * 반환점은 항상 ray 위에 있고, 동시에 bbox 경계 위 (또는 한쪽 변).
 */
const clipRayToBbox = (center: GraphPoint, bbox: GraphBbox, toward: GraphPoint): GraphPoint => {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y };
  const hw = bbox.w / 2;
  const hh = bbox.h / 2;

  // ray = center + t * (dx, dy). t>0 이면 toward 쪽.
  // bbox 4변 중 가장 먼저 만나는 변 → t 최소값.
  let t = Infinity;
  if (dx !== 0) {
    const tx = hw / Math.abs(dx);
    if (tx < t) t = tx;
  }
  if (dy !== 0) {
    const ty = hh / Math.abs(dy);
    if (ty < t) t = ty;
  }
  return { x: center.x + dx * t, y: center.y + dy * t };
};

export class PixiGraph {
  /**
   * 외부 pixi scene 에 add 할 root container.
   *   parentContainer.addChild(graph.view)
   *
   * 내부 구조 — edges 가 nodes 아래 깔리도록 두 sublayer 분리.
   */
  public readonly view: Container;

  private readonly edgesLayer: Container;
  private readonly nodesLayer: Container;
  private readonly elementMap = new Map<string, PixiGraphElement>();
  // edge 양방향 pair → 엣지 집합. _parallelEdges 가 elementMap 전체를 순회하면 O(N)·매 add 마다 N²/2 비용 → 인덱스로 O(1) 조회.
  private readonly _edgesByPair = new Map<string, Set<PixiGraphElement>>();
  /** 전역 dash offset — 흐름 시뮬 등 dash 애니메이션용. setDashOffset 으로 갱신 + 점선 엣지 재렌더. */
  private _dashOffsetGlobal = 0;
  /** 노드 group 기본 스타일 — 매칭 규칙 없을 때 fallback. config 로 override 가능. */
  private readonly nodeDefaults: PixiGraphStyleProps;
  /** 엣지 group 기본 스타일 — 매칭 규칙 없을 때 fallback. */
  private readonly edgeDefaults: PixiGraphStyleProps;
  private readonly styleEngine = new StyleEngine();
  private readonly eventBus: PixiGraphEventBus;
  private readonly highlightManager: HighlightManager;
  private readonly previewManager: PixiGraphPreview;
  /** undo/redo 매니저 — 외부에서 graph.history.undo()/redo()/recordX() 호출. */
  public readonly history: PixiGraphHistory;
  /** hidden 모드 — true 면 모든 element 가 `.hidden` 클래스 보유. hover 시 일시적 `.temporarily-visible`. */
  private _hidden = false;
  private destroyed = false;
  /**
   * 엣지 hit-test 추가 허용 거리(graph-local px) — stroke 반경에 더해짐.
   * 외부(viewer)가 줌에 맞춰 setHitTolerance(screenPx / worldScale) 로 갱신하면
   * 줌과 무관하게 일정한 화면 hit 영역 확보. 기본은 넉넉히 6.
   */
  private _hitTolerance = 6;

  /** 선택 핸들(리사이즈) — 단일 노드 선택 시 bbox 둘레에 표시. 전부 옵션 커스텀. */
  private readonly handlesLayer: Container;
  private readonly handlesGfx: Graphics;
  private _handlesEnabled = false;
  private _handleCorners = true;          // 모서리 4개
  private _handleEdges = false;           // 변 가운데 4개
  private _resizeCursor = true;           // hover 시 resize 커서
  private _centerResize = false;          // 중심 기준 리사이즈(기본)
  private _keepAspect = false;            // 비율 유지(기본)
  private _selectable = true;             // 전역 선택 활성
  private _handleUnion = false;           // true=다중선택 시 합집합 1박스, false(기본)=노드별
  private _handleMove = true;             // 노드 드래그 이동 (요소별 ele.movable() 도 필요)
  private _selectOnGrab = true;           // 미선택 노드 드래그 시 자동 선택+이동
  private _handleRotate = false;          // 회전 활성
  private _rotateMode: 'zone' | 'handle' = 'handle'; // handle=전용 핸들(기본), zone=피그마(코너 바깥 ring)
  private _rotateZone = 16;               // zone 모드 ring 두께(px)
  private _rotateGap = 24;                // handle 모드 전용 핸들이 상단변에서 떨어진 거리(px)
  // 핸들 스타일
  private _hSize = 10;                     // 기준 크기(viewScale=1)
  private _hZoomFollow = 0.1;              // 줌 추종 0~1
  private _hShape: 'square' | 'circle' = 'square';
  private _hFill: number | string = 0xffffff;
  private _hStroke: number | string = 0x000000;
  private _hStrokeWidth = 1;               // px(화면 고정), 0=없음
  // 선택 박스(outline)
  private _boxEnabled = false;
  private _boxStroke: number | string = 0x1d4ed8;
  private _boxWidth = 1;
  private _boxAlpha = 0.9;
  private _boxDash = 0;     // 0=solid
  private _boxGap = 0;      // 0 또는 _boxDash 와 동일
  /** 현재 뷰 scale — 핸들/박스를 화면상 일정하게 역보정. 외부가 setViewScale 로 갱신. */
  private _viewScale = 1;

  // 호버 툴팁 — 시스템은 라이브러리에서, 렌더링은 별도 컴포넌트.
  //   순서/필터는 도메인 규칙 — 라이브러리 기본값 없음(호출부에서 지정).
  private _tooltipEnabled = false;
  private _tooltipOrder: string[] = [];
  private _tooltipHiddenPattern: RegExp | null = null;
  private _tooltipHiddenKeys: Set<string> = new Set();

  /**
   * 라이브러리가 자동 관리하는 시스템 클래스 style — 외부 user rules 와 항상 결합.
   * - `.dim`:       일반 dim — highlights 활성 시 그룹 외 element 자동 부여 (alpha 0.06, 거의 안 보임).
   * - `.focus-dim`: focus 모드 dim — graph.setFocusColor 활성 시 focus 색 외 element 자동 부여
   *                 (alpha 0.18, 흐릿하지만 보임). trace lock 등에 사용.
   *
   * graph.style(userRules) 호출 시 user rules 앞에 prepend 되어 cascade 의 가장 낮은 우선순위.
   * user 가 같은 selector 를 명시하면 선언 순서로 user 가 이김 (override 가능).
   */
  private readonly _systemStyleRules: PixiGraphStyleRule[] = [
    { selector: '.dim', style: { alpha: 0 } },
    { selector: '.focus-dim', style: { alpha: 0.18 } },
  ];

  /** user 가 graph.style 로 등록한 규칙 — 시스템 rules 와 결합 전 캐시. */
  private _userStyleRules: PixiGraphStyleRule[] = [];

  constructor(config: PixiGraphConfig = {}) {
    this.view = new Container();
    this.edgesLayer = new Container();
    this.nodesLayer = new Container();
    this.handlesLayer = new Container();
    this.handlesGfx = new Graphics();
    this.handlesGfx.eventMode = 'none';
    this.handlesLayer.addChild(this.handlesGfx);
    this.view.addChild(this.edgesLayer);
    this.view.addChild(this.nodesLayer);
    this.view.addChild(this.handlesLayer); // 노드 위

    // 선택 핸들 옵션 — 전부 커스텀.
    const h = config.selectionHandles;
    if (h) {
      this._handlesEnabled = true;
      if (typeof h === 'object') {
        if (h.enabled === false) this._handlesEnabled = false;
        if (typeof h.corners === 'boolean') this._handleCorners = h.corners;
        if (typeof h.edges === 'boolean') this._handleEdges = h.edges;
        if (typeof h.resizeCursor === 'boolean') this._resizeCursor = h.resizeCursor;
        if (typeof h.centerResize === 'boolean') this._centerResize = h.centerResize;
        if (typeof h.keepAspect === 'boolean') this._keepAspect = h.keepAspect;
        if (typeof h.selectable === 'boolean') this._selectable = h.selectable;
        if (typeof h.union === 'boolean') this._handleUnion = h.union;
        if (typeof h.move === 'boolean') this._handleMove = h.move;
        if (typeof h.selectOnGrab === 'boolean') this._selectOnGrab = h.selectOnGrab;
        if (typeof h.rotate === 'boolean') this._handleRotate = h.rotate;
        if (h.rotateMode === 'zone' || h.rotateMode === 'handle') this._rotateMode = h.rotateMode;
        if (typeof h.rotateGap === 'number') this._rotateGap = h.rotateGap;
        if (typeof h.rotateZone === 'number') this._rotateZone = h.rotateZone;
        const hs = h.handle;
        if (hs) {
          if (typeof hs.size === 'number') this._hSize = hs.size;
          if (typeof hs.zoomFollow === 'number') this._hZoomFollow = Math.max(0, Math.min(1, hs.zoomFollow));
          if (hs.shape) this._hShape = hs.shape;
          if (hs.fill != null) this._hFill = hs.fill;
          if (hs.stroke != null) this._hStroke = hs.stroke;
          if (typeof hs.strokeWidth === 'number') this._hStrokeWidth = hs.strokeWidth;
        }
        const bx = h.box;
        if (bx) {
          if (typeof bx.enabled === 'boolean') this._boxEnabled = bx.enabled;
          if (bx.stroke != null) this._boxStroke = bx.stroke;
          if (typeof bx.width === 'number') this._boxWidth = bx.width;
          if (typeof bx.alpha === 'number') this._boxAlpha = bx.alpha;
          if (typeof bx.dash === 'number') this._boxDash = Math.max(0, bx.dash);
          if (typeof bx.gap === 'number') this._boxGap = Math.max(0, bx.gap);
        }
      }
    }

    // 툴팁 옵션 파싱.
    const tt = config.tooltip;
    if (tt) {
      this._tooltipEnabled = true;
      if (typeof tt === 'object') {
        if (tt.enabled === false) this._tooltipEnabled = false;
        if (Array.isArray(tt.propertyOrder)) this._tooltipOrder = tt.propertyOrder.slice();
        if (tt.hiddenKeyPattern instanceof RegExp) this._tooltipHiddenPattern = tt.hiddenKeyPattern;
        if (Array.isArray(tt.hiddenKeys)) this._tooltipHiddenKeys = new Set(tt.hiddenKeys);
      }
    }

    // shallow merge — config 가 일부만 override 가능.
    this.nodeDefaults = { ...DEFAULT_PIXIGRAPH_STYLE.node, ...(config.style?.node ?? {}) };
    this.edgeDefaults = { ...DEFAULT_PIXIGRAPH_STYLE.edge, ...(config.style?.edge ?? {}) };

    // 기본 규칙 — base group style + 시스템 rules. 외부 graph.style() 호출 시에도 시스템 rules 보존.
    this.styleEngine.setRules([
      { selector: 'node', style: this.nodeDefaults },
      { selector: 'edge', style: this.edgeDefaults },
      ...this._systemStyleRules,
    ]);

    // 이벤트 위임 — graph 가 elementAt(hit-test) 만 노출. DOM 은 외부 책임.
    this.eventBus = new PixiGraphEventBus({
      elementAt: (x, y) => this.elementAt(x, y),
    });

    // 하이라이트 매니저 — 외부 시스템 (trace / 검색 / ...) 이 그룹 단위 inline style 부여.
    //   auto-dim: highlights 활성 시 그룹에 안 속한 element 들에 자동으로 .dim 클래스 부여.
    this.highlightManager = new HighlightManager({
      _restyleElement: (ele) => this._restyleElement(ele),
      elements: () => [...this.elementMap.values()],
    });
    this.previewManager = new PixiGraphPreview(this);
    this.history = new PixiGraphHistory(this);

    // hidden 모드 자동 hover-reveal — 사용자 등록 핸들러보다 먼저 등록 (반영 순서 무관).
    //   mouseover: hidden 모드면 element 에 .temporarily-visible 추가 → style rule 매칭으로 reveal.
    //   mouseout:  항상 .temporarily-visible 제거 (hidden 해제 후에도 잔존 방지).
    this.eventBus.on('mouseover', ({ target }) => {
      if (this._hidden && target) target.addClass('temporarily-visible');
    });
    this.eventBus.on('mouseout', ({ target }) => {
      if (target) target.removeClass('temporarily-visible');
    });
  }

  // ──────────────────────────────────────────────────────────
  // 이벤트 — delegation. D-B (graph 는 DOM 미관여, 외부에서 feed).
  // ──────────────────────────────────────────────────────────

  /**
   * 이벤트 핸들러 등록.
   *   `graph.on('tap', (e) => ...)`               — 모든 hit + background
   *   `graph.on('tap', 'node', (e) => ...)`       — 노드 hit 만
   *   `graph.on('cxttap', '.foo', handler)`       — class foo 매칭
   *   `graph.on('mouseover', 'node:selected', h)` — selected 노드 진입만
   *
   * 핸들러 호출 시 payload = { type, target, x, y, native }.
   * mouseover / mouseout 은 target 이 항상 non-null.
   * tap / cxttap 의 background hit (target=null) 는 selector 없는 핸들러만 호출.
   */
  on(type: PixiGraphEventType, selectorOrFn: string | PixiGraphHandler, maybeFn?: PixiGraphHandler): void {
    this.eventBus.on(type, selectorOrFn, maybeFn);
  }

  /**
   * 핸들러 제거.
   *   `graph.off('tap', handler)` — fn 한 개
   *   `graph.off('tap')`          — 해당 type 전부
   *   `graph.off()`               — 전부
   */
  off(type?: PixiGraphEventType, fn?: PixiGraphHandler): void {
    this.eventBus.off(type, fn);
  }

  /**
   * 외부 DOM 이벤트에서 호출 — graph-local 좌표로 변환 후 hit-test + 핸들러 호출.
   *  - 'tap' / 'cxttap': 단일 hit-test → 매칭 핸들러 호출.
   *  - 'mousemove': hover 추적 → 이전과 다르면 mouseout/mouseover 자동 발행.
   *
   * 사용 패턴:
   *   host.addEventListener('contextmenu', (e) => {
   *     const { x, y } = screenToGraphLocal(e.clientX, e.clientY);
   *     graph.feed('cxttap', x, y, e);
   *   });
   */
  feed(type: PixiGraphFeedType, x: number, y: number, native: Event | null = null): void {
    this.eventBus.feed(type, x, y, native);
  }

  /** host 가 마우스 벗어났을 때 — 현재 hover element 강제 mouseout 발행. */
  clearHover(native: Event | null = null): void {
    this.eventBus.clearHover(native);
  }

  // ──────────────────────────────────────────────────────────
  // 데이터 추가 / 제거
  // ──────────────────────────────────────────────────────────

  /**
   * 노드 + 엣지 일괄 추가. 노드 먼저 등록되어야 엣지가 끝점을 찾을 수 있으므로
   * 항상 노드 → 엣지 순으로 처리. 이미 등록된 id 는 무시 (중복 방지).
   *
   * 엣지의 src 또는 tgt 노드가 graph 에 없으면 그 엣지는 skip.
   */
  add(input: PixiGraphAddInput): void {
    if (this.destroyed) return;
    const nodes = input.nodes ?? [];
    const edges = input.edges ?? [];

    const newIds: string[] = [];
    nodes.forEach((n) => { this.addNode(n); newIds.push(n.id); });
    edges.forEach((e) => { this.addEdge(e); newIds.push(e.id); });
    // history 자동 기록 — added 만(스냅샷은 추가 직후 한 번).
    if (this.history?.shouldRecord()) {
      const created = newIds.map((id) => this.elementMap.get(id)).filter((el): el is PixiGraphElement => !!el);
      this.history.recordAdd(created);
    }
  }

  private addNode(input: PixiGraphNodeInput): void {
    if (!input.id) return;
    if (this.elementMap.has(input.id)) return;
    if (!Number.isFinite(input.bbox?.w) || !Number.isFinite(input.bbox?.h)) return;

    const gfx = new Graphics();
    this.nodesLayer.addChild(gfx);
    const ele = new PixiGraphElement({
      id: input.id,
      group: 'node',
      data: input.data ?? {},
      bbox: { ...input.bbox },
      view: gfx,
      graph: this,
    });
    this.elementMap.set(input.id, ele);
    // 모양/기하 — 1급 속성으로 설정(라이브러리는 도메인 데이터 안 봄).
    if (input.shape) ele.shape(input.shape);
    if (input.polygonPoints) ele.polygonPoints(input.polygonPoints);
    // 새 element 가 현재 hidden / highlight-dim 상태 상속 — class add 가 renderElement 자동 트리거.
    if (this._hidden) ele.addClass('hidden');
    if (this.highlightManager.isAnyActive()) ele.addClass('dim');
    if (!this._hidden && !this.highlightManager.isAnyActive()) this.renderElement(ele);
    this.eventBus.emit('add', ele);
  }

  private addEdge(input: PixiGraphEdgeInput): void {
    if (!input.id || !input.source || !input.target) return;
    if (this.elementMap.has(input.id)) return;

    const src = this.elementMap.get(input.source);
    const tgt = this.elementMap.get(input.target);
    if (!src || !src.isNode() || !tgt || !tgt.isNode()) return;

    const { srcExit, tgtEntry, bbox } = this._computeEdgeGeometry(src, tgt);
    const edgeMeta: EdgeMeta = {
      srcId: input.source,
      tgtId: input.target,
      src: srcExit,
      tgt: tgtEntry,
    };

    const gfx = new Graphics();
    this.edgesLayer.addChild(gfx);
    const ele = new PixiGraphElement({
      id: input.id,
      group: 'edge',
      data: input.data ?? {},
      bbox,
      view: gfx,
      graph: this,
      edgeMeta,
    });
    this.elementMap.set(input.id, ele);
    // pair 인덱스 등록 — 양방향 같은 키 사용.
    const pk = this._pairKey(input.source, input.target);
    let set = this._edgesByPair.get(pk);
    if (!set) { set = new Set(); this._edgesByPair.set(pk, set); }
    set.add(ele);
    // hidden / dim 클래스 상속 — class add 가 renderElement 자동 트리거.
    if (this._hidden) ele.addClass('hidden');
    if (this.highlightManager.isAnyActive()) ele.addClass('dim');
    if (!this._hidden && !this.highlightManager.isAnyActive()) this.renderElement(ele);
    // 같은 source/target 쌍의 기존 엣지들 — 곡률 재계산 위해 재렌더.
    this._reRenderParallels(ele);
    this.eventBus.emit('add', ele);
  }

  /** edge pair 인덱스 키 — 양방향 같은 키. */
  private _pairKey(srcId: string, tgtId: string): string {
    return srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
  }

  /** id 에 해당하는 element 제거. 노드 제거 시 연결된 엣지는 자동 제거 안 함 (caller 책임). */
  remove(id: string): void {
    const ele = this.elementMap.get(id);
    if (!ele) return;
    // history 자동 기록 — 제거 직전 snapshot.
    if (this.history?.shouldRecord()) this.history.recordRemove([ele]);
    // 'remove' 이벤트 — 실제 제거 직전 발행(구독자가 element 정보 읽을 수 있게).
    this.eventBus.emit('remove', ele);
    const wasEdge = ele.isEdge();
    const parallels = wasEdge ? this._parallelEdges(ele).filter((e) => e !== ele) : [];
    // pair 인덱스 정리 — 엣지 제거 시.
    if (wasEdge) {
      const src = ele.source(); const tgt = ele.target();
      if (src && tgt) {
        const set = this._edgesByPair.get(this._pairKey(src.id(), tgt.id()));
        if (set) { set.delete(ele); if (set.size === 0) this._edgesByPair.delete(this._pairKey(src.id(), tgt.id())); }
      }
    }
    this.highlightManager._onElementRemoved(ele);
    try { ele.view.destroy(); } catch { /* noop */ }
    this.elementMap.delete(id);
    parallels.forEach((e) => this.renderElement(e));
  }

  /** ele 가 엣지면, 같은 source/target 쌍의 다른 엣지들을 재렌더(곡률 변경 반영). */
  private _reRenderParallels(ele: PixiGraphElement): void {
    if (!ele.isEdge()) return;
    const par = this._parallelEdges(ele);
    if (par.length <= 1) return;
    par.forEach((e) => { if (e !== ele) this.renderElement(e); });
  }

  /** 모든 element 제거. graph.view 자체는 유지 (다시 add 가능). highlight 그룹도 같이 clear. */
  clear(): void {
    this.elementMap.forEach((ele) => {
      this.highlightManager._onElementRemoved(ele);
      try { ele.view.destroy(); } catch { /* noop */ }
    });
    this.elementMap.clear();
    this._edgesByPair.clear();
    // 모든 element 가 사라졌으므로 그룹들도 다 빈 상태 — 정리.
    this.highlightManager.clear();
    this._renderHandles(); // 선택 사라짐 → 핸들 제거
  }

  // ──────────────────────────────────────────────────────────
  // 쿼리
  // ──────────────────────────────────────────────────────────

  /** id 직접 조회. 없으면 null. */
  element(id: string): PixiGraphElement | null {
    return this.elementMap.get(id) ?? null;
  }

  /**
   * 간이 selector — 현재 iteration 은 `#id` 형식만 지원.
   * 향후 `:selected`, `.classname`, `node`, `edge` 등으로 확장될 자리.
   */
  $(selector: string): PixiGraphElement | null {
    if (selector.startsWith('#')) return this.element(selector.slice(1));
    return null;
  }

  /** 모든 element. 삽입 순서 보존. */
  elements(): PixiGraphElement[] {
    return [...this.elementMap.values()];
  }

  nodes(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => { if (e.isNode()) out.push(e); });
    return out;
  }

  edges(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => { if (e.isEdge()) out.push(e); });
    return out;
  }

  /** element 개수. */
  size(): number { return this.elementMap.size; }

  // ──────────────────────────────────────────────────────────
  // Highlights — 그룹 단위 inline style override.
  // ──────────────────────────────────────────────────────────

  /**
   * Highlight 그룹 추가/교체 — element 들에 inline style 부여.
   * 같은 id 로 재호출하면 기존 그룹 해제 후 교체.
   * 우선순위: cascade rules → highlight 그룹들 (등록 순). 후순위 그룹이 동일 prop 을 이김.
   *
   * 사용 예:
   *   graph.highlight({ id: 'trace-1', elements: [n1, e1, n2], style: { fill: '#ef4444', alpha: 0.6 } });
   *   graph.highlight({ id: 'search-match', elements: [n5], style: { stroke: '#0ea5e9', width: 14 } });
   */
  highlight(input: PixiGraphHighlightInput): void {
    this.highlightManager.add(input);
  }

  /** id 그룹 해제. */
  unhighlight(id: string): void {
    this.highlightManager.remove(id);
  }

  /** prefix 로 시작하는 그룹 일괄 해제 (예: 'trace-' 모든 trace path 해제). */
  unhighlightByPrefix(prefix: string): void {
    this.highlightManager.removeByPrefix(prefix);
  }

  /** 모든 highlight 그룹 해제. */
  clearHighlights(): void {
    this.highlightManager.clear();
  }

  /** 그룹 존재 여부. */
  hasHighlight(id: string): boolean {
    return this.highlightManager.has(id);
  }

  /** 등록된 모든 highlight 그룹 id (등록 순서). */
  highlightIds(): string[] {
    return this.highlightManager.ids();
  }

  /**
   * Focus color set/clear — 특정 색의 highlight 그룹에 속한 element 만 강조 유지.
   * 나머지는 자동으로 `.focus-dim` 클래스 부여 → 흐릿하게 보임.
   *
   * 사용 예 (trace path 색 lock):
   *   graph.setFocusColor('#ef4444');  // 빨간 trace path 만 강조
   *   graph.setFocusColor(null);       // focus 해제
   */
  setFocusColor(color: number | string | null): void {
    this.highlightManager.setFocusColor(color);
  }

  /** 현재 focus color (hex int) 또는 null. */
  getFocusColor(): number | null {
    return this.highlightManager.getFocusColor();
  }

  // ──────────────────────────────────────────────────────────
  // Hidden mode
  // ──────────────────────────────────────────────────────────

  /**
   * 전체 hidden 모드 토글.
   *  - true:  모든 element 에 `.hidden` 클래스 add → style rule (`.hidden`) 매칭으로 invisible.
   *           hover 시 PixiGraph 내부 핸들러가 `.temporarily-visible` 추가해 자동 reveal.
   *  - false: 모든 element 에서 `.hidden`/`.temporarily-visible` 제거.
   *
   * 인자 없이 호출하면 현재 상태 반환 (cytoscape getter/setter 관용).
   */
  hidden(value?: boolean): boolean {
    if (value === undefined) return this._hidden;
    const next = !!value;
    if (next === this._hidden) return this._hidden;
    this._hidden = next;
    this.elementMap.forEach((ele) => {
      if (next) ele.addClass('hidden');
      else { ele.removeClass('hidden'); ele.removeClass('temporarily-visible'); }
    });
    return this._hidden;
  }

  // ──────────────────────────────────────────────────────────
  // 상태 (selected / classes) — element-level helpers
  // ──────────────────────────────────────────────────────────

  /** 현재 selected element 목록. cytoscape `cy.elements(':selected')` 와 동등. */
  selected(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => { if (e.selected()) out.push(e); });
    return out;
  }

  /** 선택 상태 변경 통지 (ElementGraphHandle) — 'select'/'unselect' 이벤트 발행 + 핸들 갱신. */
  _emitSelectionChange(ele: PixiGraphElement, selected: boolean): void {
    this.eventBus.emit(selected ? 'select' : 'unselect', ele);
    this._renderHandles();
  }

  /** data(key, value) 변경 통지 (ElementGraphHandle) — 'data' 이벤트 발행. key/value 는 native 에 wrap. */
  _emitDataChange(ele: PixiGraphElement, key: string, value: unknown): void {
    this.eventBus.emit('data', ele, { key, value } as unknown as Event);
  }

  // ──────────────────────────────────────────────────────────
  // 선택 핸들 (리사이즈) — 단일 노드 선택 시 bbox 둘레에 표시.
  // ──────────────────────────────────────────────────────────

  /** 핸들 표시 on/off. */
  setSelectionHandles(enabled: boolean): void {
    this._handlesEnabled = !!enabled;
    this._renderHandles();
  }

  /**
   * 뷰 scale 갱신 — 핸들/선택박스를 화면상 일정 크기로 유지(graph-local = screenPx / scale).
   * 외부(viewer)가 줌 변경 시 호출. setHitTolerance 와 같은 타이밍.
   */
  setViewScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || scale === this._viewScale) return;
    this._viewScale = scale;
    this._renderHandles();
  }

  /** 리사이즈 가능한(선택 + ele.resizable() + handleMode='rect') 노드들. 핸들/리사이즈 대상.
   *   handleMode='vertex' 면 호출부 오버레이(폴리곤 정점 편집)가 핸들을 그리므로 라이브러리는 skip. */
  resizableSelected(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => {
      if (e.selected() && e.isNode() && e.resizable() && e.handleMode() === 'rect') out.push(e);
    });
    return out;
  }

  /** 회전 가능한(선택 + ele.rotatable()) 노드들. 회전 핸들/zone 대상. */
  rotatableSelected(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => {
      if (e.selected() && e.isNode() && e.rotatable()) out.push(e);
    });
    return out;
  }

  /** 이동 가능한(선택 + ele.movable()) 노드들. 드래그 이동 대상. */
  movableSelected(): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => {
      if (e.selected() && e.isNode() && e.movable()) out.push(e);
    });
    return out;
  }

  /** 노드 이동 활성 여부(전역). 요소별은 ele.movable(). */
  get selectOnGrabEnabled(): boolean { return this._selectOnGrab; }
  /** 전역 선택 활성. */
  get selectableEnabled(): boolean { return this._selectable; }
  /** union 모드 — 다중선택을 합집합 1박스로 다룸. each(false)면 노드별 개별. */
  get unionEnabled(): boolean { return this._handleUnion; }
  /** 호버 툴팁 시스템 활성. 렌더링은 PixiGraphTooltip 컴포넌트가 담당. */
  get tooltipEnabled(): boolean { return this._tooltipEnabled; }

  /**
   * element properties → 정렬된 [[key,value]] 엔트리 (툴팁용).
   * tooltipOrder 키 우선, 그 외 입력순. hiddenKeyPattern/hiddenKeys 매칭은 제외.
   */
  tooltipEntries(ele: PixiGraphElement): [string, string][] {
    const props = (ele.data('properties') as Record<string, unknown> | undefined) ?? {};
    const out: [string, string][] = [];
    const seen = new Set<string>();
    for (const k of this._tooltipOrder) {
      const v = props[k];
      if (v != null && String(v).trim()) { out.push([k, String(v).trim()]); seen.add(k); }
    }
    for (const [k, v] of Object.entries(props)) {
      if (seen.has(k) || (this._tooltipHiddenPattern && this._tooltipHiddenPattern.test(k)) || this._tooltipHiddenKeys.has(k) || v == null) continue;
      const s = String(v).trim();
      if (s) out.push([k, s]);
    }
    return out;
  }

  /** 리사이즈 가능한 선택 노드들의 합집합 bbox(그룹). 없으면 null. */
  selectionBbox(): GraphBbox | null {
    let r: GraphBbox | null = null;
    for (const e of this.resizableSelected()) {
      const b = e.bbox();
      if (!r) { r = { x: b.x, y: b.y, w: b.w, h: b.h }; continue; }
      const x2 = Math.max(r.x + r.w, b.x + b.w), y2 = Math.max(r.y + r.h, b.y + b.h);
      r.x = Math.min(r.x, b.x); r.y = Math.min(r.y, b.y); r.w = x2 - r.x; r.h = y2 - r.y;
    }
    return r;
  }

  /** 핸들을 그릴 bbox 들 — union 모드면 그룹 1개(회전 0), each(기본) 모드면 노드별(회전 반영). */
  private _handleBoxes(): { bbox: GraphBbox; nodeId: string | null; rotation: number }[] {
    if (this._handleUnion) {
      const b = this.selectionBbox();
      return b ? [{ bbox: b, nodeId: null, rotation: 0 }] : [];
    }
    return this.resizableSelected().map((n) => ({ bbox: n.bbox(), nodeId: n.id(), rotation: n.rotation() }));
  }

  /** 점 배열을 dash/gap 으로 끊어서 g 에 moveTo/lineTo 누적. dash <= 0 이면 실선.
   *  offset 양수면 dash 가 path 시작쪽으로 밀려 보이고 (시각 흐름: end→start),
   *  음수면 반대 (start→end). 흐름 시뮬레이션에서 음수로 감소시켜 sc→tc 방향 흐름 효과.
   */
  private _dashPolyline(g: Graphics, pts: GraphPoint[], dash: number, gap: number, offset = 0): void {
    if (pts.length < 2) return;
    if (dash <= 0) {
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      return;
    }
    // offset 정규화 → [0, dash+gap).
    const period = dash + gap;
    const o = ((offset % period) + period) % period;
    let drawing: boolean; let remaining: number;
    if (o < dash) { drawing = true; remaining = dash - o; }
    else { drawing = false; remaining = period - o; }
    let curX = pts[0].x, curY = pts[0].y;
    g.moveTo(curX, curY);
    for (let i = 1; i < pts.length; i++) {
      let nx = pts[i].x, ny = pts[i].y;
      let segLen = Math.hypot(nx - curX, ny - curY);
      while (segLen > 1e-6) {
        const step = Math.min(remaining, segLen);
        const t = step / segLen;
        const x = curX + (nx - curX) * t;
        const y = curY + (ny - curY) * t;
        if (drawing) g.lineTo(x, y); else g.moveTo(x, y);
        curX = x; curY = y;
        segLen -= step;
        remaining -= step;
        if (remaining <= 0) { drawing = !drawing; remaining = drawing ? dash : gap; }
      }
    }
  }

  /** (x1,y1)→(x2,y2) 를 dash/gap 으로 끊어서 g 에 moveTo/lineTo 누적 (stroke 는 caller). */
  private _dashLine(g: Graphics, x1: number, y1: number, x2: number, y2: number, dash: number, gap: number): void {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len <= 0 || dash <= 0) { g.moveTo(x1, y1).lineTo(x2, y2); return; }
    const ux = dx / len, uy = dy / len, step = dash + Math.max(gap, 0);
    let d = 0;
    while (d < len) {
      const a = d, b = Math.min(d + dash, len);
      g.moveTo(x1 + ux * a, y1 + uy * a).lineTo(x1 + ux * b, y1 + uy * b);
      d += step;
    }
  }

  /** 점을 center 기준 r 라디안 회전. */
  private _rot(px: number, py: number, cx: number, cy: number, r: number): { x: number; y: number } {
    if (!r) return { x: px, y: py };
    const cos = Math.cos(r), sin = Math.sin(r), dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  /** 한 bbox 의 핸들 중심들(회전 적용) — corners/edges/rotate 옵션 반영. */
  private _bboxHandles(b: GraphBbox, rotation: number): { key: string; x: number; y: number }[] {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, x2 = b.x + b.w, y2 = b.y + b.h;
    const raw: { key: string; x: number; y: number }[] = [];
    if (this._handleCorners) {
      raw.push({ key: 'nw', x: b.x, y: b.y }, { key: 'ne', x: x2, y: b.y },
        { key: 'se', x: x2, y: y2 }, { key: 'sw', x: b.x, y: y2 });
    }
    if (this._handleEdges) {
      raw.push({ key: 'n', x: cx, y: b.y }, { key: 'e', x: x2, y: cy },
        { key: 's', x: cx, y: y2 }, { key: 'w', x: b.x, y: cy });
    }
    if (this._handleRotate && this._rotateMode === 'handle') {
      raw.push({ key: 'rotate', x: cx, y: b.y - this._rotateGap / (this._viewScale || 1) });
    }
    return raw.map((p) => ({ key: p.key, ...this._rot(p.x, p.y, cx, cy, rotation) }));
  }

  /** 모든 핸들 중심 좌표 + 소속(nodeId=null 이면 union 그룹). */
  handlePositions(): { key: string; x: number; y: number; nodeId: string | null }[] {
    if (!this._handlesEnabled) return [];
    const out: { key: string; x: number; y: number; nodeId: string | null }[] = [];
    for (const box of this._handleBoxes()) {
      for (const h of this._bboxHandles(box.bbox, box.rotation)) out.push({ ...h, nodeId: box.nodeId });
    }
    return out;
  }

  /** 핸들 한 변/지름의 graph-local 크기 — 줌 추종 반영(화면크기 = size·vs^zoomFollow). */
  private _handleLocalSize(): number {
    const vs = this._viewScale || 1;
    return this._hSize / Math.pow(vs, 1 - this._hZoomFollow);
  }

  /** resize 커서 표시 옵션 여부. */
  get resizeCursorEnabled(): boolean { return this._resizeCursor; }
  /** 중심 기준 리사이즈 기본값(Ctrl 로 일시 토글). */
  get centerResizeEnabled(): boolean { return this._centerResize; }
  /** 비율 유지 리사이즈 기본값(Shift 로 일시 토글). */
  get keepAspectEnabled(): boolean { return this._keepAspect; }
  /** 노드 이동(드래그) 활성 여부. */
  get moveEnabled(): boolean { return this._handleMove; }

  /** 핸들 key → CSS resize 커서. */
  static handleCursor(key: string): string {
    switch (key) {
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'rotate': return 'grab';
      default: return 'default';
    }
  }

  /** (x,y) graph-local 에서 핸들 위면 {key, nodeId, rotation}, 아니면 null. rotation=해당 노드/그룹 회전(rad). */
  handleAt(x: number, y: number): { key: string; nodeId: string | null; rotation: number } | null {
    const half = this._handleLocalSize() / 2;
    for (const box of this._handleBoxes()) {
      for (const h of this._bboxHandles(box.bbox, box.rotation)) {
        const hit = this._hShape === 'circle'
          ? Math.hypot(x - h.x, y - h.y) <= half
          : (x >= h.x - half && x <= h.x + half && y >= h.y - half && y <= h.y + half);
        if (hit) return { key: h.key, nodeId: box.nodeId, rotation: box.rotation };
      }
    }
    return null;
  }

  /**
   * (x,y) 가 코너 핸들 바깥 회전 ring 안이면 {nodeId, angle}, 아니면 null. (zone 모드, 피그마식)
   * angle = 코너 키별 정규화 각도(±45°/±135°) + 노드 회전 — bbox 종횡비와 무관하게 일관.
   * 코너 핸들 중심에서 [half, half+ring] 거리 — 핸들 위(handleAt)가 아닌 바로 바깥.
   */
  rotateZoneAt(x: number, y: number): { nodeId: string | null; angle: number } | null {
    if (!this._handlesEnabled || !this._handleRotate || this._rotateMode !== 'zone' || !this._handleCorners) return null;
    const half = this._handleLocalSize() / 2;
    const outer = half + this._rotateZone / (this._viewScale || 1);
    // 코너 정규화 각도(nw, ne, se, sw 순서) — bbox 가 비정형이어도 ±45°/±135° 로 고정.
    const CORNER_ANGLES = [-3 * Math.PI / 4, -Math.PI / 4, Math.PI / 4, 3 * Math.PI / 4];
    // local 사분면 표시(코너 outside 방향): nw=(-,-), ne=(+,-), se=(+,+), sw=(-,+).
    const CORNER_SIGN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const rotBoxes = this._handleUnion
      ? (this.selectionBbox() ? [{ bbox: this.selectionBbox()!, nodeId: null, rotation: 0 }] : [])
      : this.rotatableSelected().map((n) => ({ bbox: n.bbox(), nodeId: n.id() as string | null, rotation: n.rotation() }));
    for (const box of rotBoxes) {
      const b = box.bbox, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      // 점을 local(미회전) 좌표로 역회전 → 사분면 비교가 단순.
      let lx = x, ly = y;
      if (box.rotation) {
        const cos = Math.cos(-box.rotation), sin = Math.sin(-box.rotation);
        const dx = x - cx, dy = y - cy;
        lx = cx + dx * cos - dy * sin;
        ly = cy + dx * sin + dy * cos;
      }
      const localCorners = [
        { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
      ];
      for (let i = 0; i < 4; i++) {
        const lc = localCorners[i];
        const d = Math.hypot(lx - lc.x, ly - lc.y);
        if (d <= half || d > outer) continue; // ring 밖
        // outside 사분면 검사 — 코너 바깥쪽(핸들 사각형 밖) 만 회전 zone.
        const [sx, sy] = CORNER_SIGN[i];
        const outsideX = sx > 0 ? lx >= lc.x : lx <= lc.x;
        const outsideY = sy > 0 ? ly >= lc.y : ly <= lc.y;
        if (outsideX && outsideY) return { nodeId: box.nodeId, angle: CORNER_ANGLES[i] + box.rotation };
      }
    }
    return null;
  }

  /** 핸들/선택박스 다시 그림 — each(노드별)/union(그룹) 모드의 각 bbox 마다(회전 반영). */
  private _renderHandles(): void {
    const g = this.handlesGfx;
    g.clear();
    if (!this._handlesEnabled) return;
    const boxes = this._handleBoxes();
    if (!boxes.length) return;
    const vs = this._viewScale || 1;
    const s = this._handleLocalSize();
    for (const { bbox: b, rotation: r } of boxes) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      // 선택 박스(outline) — 회전 시 4코너 polygon. dash > 0 이면 dashed.
      if (this._boxEnabled && this._boxWidth > 0) {
        const c = [
          this._rot(b.x, b.y, cx, cy, r), this._rot(b.x + b.w, b.y, cx, cy, r),
          this._rot(b.x + b.w, b.y + b.h, cx, cy, r), this._rot(b.x, b.y + b.h, cx, cy, r),
        ];
        if (this._boxDash > 0) {
          // dash/gap 은 화면 px → graph-local 환산(viewScale 역수).
          const dash = this._boxDash / vs;
          const gap = (this._boxGap > 0 ? this._boxGap : this._boxDash) / vs;
          for (let i = 0; i < 4; i++) {
            const a = c[i], n = c[(i + 1) % 4];
            this._dashLine(g, a.x, a.y, n.x, n.y, dash, gap);
          }
          g.stroke({ color: this._boxStroke, width: this._boxWidth / vs, alpha: this._boxAlpha, cap: 'butt' });
        } else {
          g.poly(c.flatMap((p) => [p.x, p.y]))
            .stroke({ color: this._boxStroke, width: this._boxWidth / vs, alpha: this._boxAlpha });
        }
      }
      const handles = this._bboxHandles(b, r);
      // 회전 핸들 연결선 (상단변 중앙 → 회전 핸들).
      const rot = handles.find((h) => h.key === 'rotate');
      if (rot) {
        const top = this._rot(cx, b.y, cx, cy, r);
        g.moveTo(top.x, top.y).lineTo(rot.x, rot.y)
          .stroke({ color: this._hStroke, width: Math.max(this._hStrokeWidth, 1) / vs, alpha: 1 });
      }
      // 핸들 — 회전 핸들은 원, 나머지는 모양 옵션. 사각형은 노드 회전 r 만큼 같이 기울어짐.
      const hCos = Math.cos(r), hSin = Math.sin(r);
      const hh = s / 2;
      for (const h of handles) {
        if (h.key === 'rotate' || this._hShape === 'circle') {
          g.circle(h.x, h.y, hh);
        } else if (r) {
          // 회전 사각형 — 4코너 polygon.
          const corners = [[-hh, -hh], [hh, -hh], [hh, hh], [-hh, hh]];
          const flat = corners.flatMap(([dx, dy]) => [h.x + dx * hCos - dy * hSin, h.y + dx * hSin + dy * hCos]);
          g.poly(flat);
        } else {
          g.rect(h.x - hh, h.y - hh, s, s);
        }
      }
      g.fill({ color: this._hFill, alpha: 1 });
      if (this._hStrokeWidth > 0) g.stroke({ color: this._hStroke, width: this._hStrokeWidth / vs, alpha: 1 });
    }
  }

  /** target(id | element | 배열) → 우리 element[] 로 해석. */
  private _resolveTargets(target: string | PixiGraphElement | (string | PixiGraphElement)[]): PixiGraphElement[] {
    const arr = Array.isArray(target) ? target : [target];
    const out: PixiGraphElement[] = [];
    for (const t of arr) {
      const id = typeof t === 'string' ? t : t?.id?.();
      const e = id ? this.elementMap.get(id) : null;
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * 요소 선택. cytoscape `eles.select()` + 단일선택 모드 통합.
   * @param additive false(기본)=기존 선택 해제 후 선택, true=추가 선택.
   * 각 element.select() 가 'select' 이벤트 발행.
   */
  select(target: string | PixiGraphElement | (string | PixiGraphElement)[], opts: { additive?: boolean } = {}): void {
    if (!this._selectable) return; // 전역 선택 비활성
    const targets = this._resolveTargets(target).filter((e) => e.selectable());
    const keep = new Set(targets.map((e) => e.id()));
    if (!opts.additive) {
      this.elementMap.forEach((e) => { if (e.selected() && !keep.has(e.id())) e.unselect(); });
    }
    targets.forEach((e) => e.select());
  }

  /** 요소 선택 해제. */
  unselect(target: string | PixiGraphElement | (string | PixiGraphElement)[]): void {
    this._resolveTargets(target).forEach((e) => e.unselect());
  }

  /** 모든 element 의 selected 해제. 선택 요소가 0개여도 핸들 잔상(cut ghost 등) 정리. */
  unselectAll(): void {
    this.elementMap.forEach((e) => e.unselect());
    this._renderHandles();
  }

  /** 선택 핸들 재렌더 — 호출부가 외부에서 강제로 다시 그리고 싶을 때 (예: 삭제 후 핸들 정리). */
  redrawHandles(): void {
    this._renderHandles();
  }

  /** 전역 dash offset — 흐름 시뮬 등 dash 애니메이션. dash 가 있는 엣지만 재렌더 → 비싸지 않음. */
  setDashOffset(offset: number): void {
    if (this._dashOffsetGlobal === offset) return;
    this._dashOffsetGlobal = offset;
    this.elementMap.forEach((ele) => {
      if (!ele.isEdge()) return;
      const eff = this.styleEngine.computeStyle(ele, this.edgeDefaults);
      const hStyle = this.highlightManager.styleFor(ele);
      const s = hStyle ? { ...eff, ...hStyle } : eff;
      const ld = Number(s.lineDash ?? this.edgeDefaults.lineDash ?? 0);
      if (ld > 0) this.renderElement(ele);
    });
  }

  /** 클래스 가진 element 모두 — cytoscape `cy.elements('.cls')` 와 동등. */
  byClass(cls: string): PixiGraphElement[] {
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((e) => { if (e.hasClass(cls)) out.push(e); });
    return out;
  }

  /**
   * rect(graph-local) 와 bbox 가 겹치는 element 들 — 러버밴드(shift+drag) 박스선택용.
   * eye-off(`unselected`)·hidden 은 제외. rect 는 정규화(양수 w/h) 가정.
   * @param opts.nodes/edges 포함 여부(기본 둘 다).
   */
  elementsIn(rect: GraphBbox, opts: { nodes?: boolean; edges?: boolean } = {}): PixiGraphElement[] {
    const { nodes = true, edges = true } = opts;
    const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
    const out: PixiGraphElement[] = [];
    this.elementMap.forEach((ele) => {
      if (ele.hasClass('unselected') || ele.hasClass('hidden')) return;
      if (ele.isNode() ? !nodes : !edges) return;
      const b = ele.bbox();
      if (b.x <= x2 && b.x + b.w >= rect.x && b.y <= y2 && b.y + b.h >= rect.y) out.push(ele);
    });
    return out;
  }

  /**
   * 다각형 노드의 polygon 꼭짓점 — 절대 graph-local 좌표 flat. element 의 정규화 [0,1] 데이터를 bbox 로 절대화.
   * (도메인별 변환/legacy 처리는 호출부 책임.)
   */
  private _nodePolygonPoints(ele: PixiGraphElement): number[] | null {
    if (!ele.isNode()) return null;
    const pts = ele.polygonPoints();
    if (!Array.isArray(pts) || pts.length < 6) return null;
    const b = ele.bbox();
    const flat: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      flat.push(b.x + (pts[i] as number) * b.w);
      flat.push(b.y + (pts[i + 1] as number) * b.h);
    }
    return flat.length >= 6 ? flat : null;
  }

  /**
   * 노드 모양 — ele.shape() 명시값 우선, 미지정이면 polygonPoints 있으면 polygon, 없으면 rect.
   */
  private _nodeShape(ele: PixiGraphElement): 'rect' | 'circle' | 'polygon' {
    const s = ele.shape();
    if (s === 'circle' || s === 'polygon' || s === 'rect') return s;
    const pts = ele.polygonPoints();
    return Array.isArray(pts) && pts.length >= 6 ? 'polygon' : 'rect';
  }

  /**
   * center 에서 toward 방향으로 엣지가 노드 표면에 닿는 점.
   *  - polygon 노드: 외곽선과 교차점(없으면 bbox fallback) — 큰 bbox 에 엣지 끝이 허공에 뜨는 문제 방지.
   *  - 그 외: bbox 경계.
   * (circle 도 bbox 로 충분 — tee/elbow 는 작아 차이 미미.)
   */
  private _clipToNode(node: PixiGraphElement, center: GraphPoint, toward: GraphPoint): GraphPoint {
    if (this._nodeShape(node) === 'polygon') {
      const poly = this._nodePolygonPoints(node);
      if (poly) {
        const p = rayPolygonExit(center, toward, poly);
        if (p) return p;
      }
    }
    return clipRayToBbox(center, node.bbox(), toward);
  }

  /** 두 노드 사이 엣지의 끝점(표면 clip) + AABB. addEdge / 노드 이동 재계산 공용.
   *  노드끼리 겹치면(한쪽 중심이 다른 쪽 bbox 안) clip 이 반대편으로 튀어 선 방향이 반전됨 →
   *  이 경우 중심 그대로 사용해서 sc → tc 방향 유지(arrow 방향 보존).
   */
  private _computeEdgeGeometry(src: PixiGraphElement, tgt: PixiGraphElement): {
    srcExit: GraphPoint; tgtEntry: GraphPoint; bbox: GraphBbox;
  } {
    const sc = src.position(), tc = tgt.position();
    const sb = src.bbox(), tb = tgt.bbox();
    // bbox AABB 겹침이면(접점 포함) clip 시 srcExit/tgtEntry 가 뒤바뀌어 방향 반전 → center 그대로.
    const aabbOverlap = sb.x < tb.x + tb.w && tb.x < sb.x + sb.w
                     && sb.y < tb.y + tb.h && tb.y < sb.y + sb.h;
    let srcExit: GraphPoint;
    let tgtEntry: GraphPoint;
    if (aabbOverlap) {
      srcExit = { x: sc.x, y: sc.y };
      tgtEntry = { x: tc.x, y: tc.y };
    } else {
      srcExit = this._clipToNode(src, sc, tc);
      tgtEntry = this._clipToNode(tgt, tc, sc);
    }
    const bbox = {
      x: Math.min(srcExit.x, tgtEntry.x),
      y: Math.min(srcExit.y, tgtEntry.y),
      w: Math.abs(tgtEntry.x - srcExit.x),
      h: Math.abs(tgtEntry.y - srcExit.y),
    };
    return { srcExit, tgtEntry, bbox };
  }

  /** 엣지 끝점/AABB 재계산 + 재렌더 (연결 노드 이동/리사이즈 시). */
  private _recomputeEdge(edge: PixiGraphElement): void {
    const src = edge.source(), tgt = edge.target();
    if (!src || !tgt) return;
    const { srcExit, tgtEntry, bbox } = this._computeEdgeGeometry(src, tgt);
    edge._setEdgePoints(srcExit, tgtEntry);
    edge._setBbox(bbox);
    this.renderElement(edge);
  }

  /**
   * 노드 bbox 변경(리사이즈/이동) — 노드 + 연결 엣지 끝점 + 핸들 재렌더.
   * @returns 변경 적용 여부.
   */
  setNodeBbox(id: string, bbox: GraphBbox): boolean {
    const ele = this.elementMap.get(id);
    if (!ele || !ele.isNode()) return false;
    if (!Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) return false;
    ele._setBbox(bbox);
    this.renderElement(ele);
    ele.connectedEdges().forEach((e) => this._recomputeEdge(e));
    this._renderHandles();
    this.eventBus.emit('bbox', ele);
    return true;
  }

  /**
   * polygon 노드의 bbox + polygonPoints 함께 설정 (정점 편집 라이브 + undo).
   * data.properties 직렬화 동기는 호출자가 commit 시점에 별도 처리.
   */
  setNodePolygon(id: string, bbox: GraphBbox, polygonPoints: number[]): boolean {
    const ele = this.elementMap.get(id);
    if (!ele || !ele.isNode()) return false;
    if (!Number.isFinite(bbox.w) || !Number.isFinite(bbox.h)) return false;
    ele._setBbox(bbox);
    ele.polygonPoints(polygonPoints.slice());
    this.renderElement(ele);
    ele.connectedEdges().forEach((e) => this._recomputeEdge(e));
    this._renderHandles();
    this.eventBus.emit('polygon', ele);
    return true;
  }

  /** 여러 노드 회전 일괄 변경(라디안). 핸들 1회 재렌더. */
  setNodesRotations(updates: { id: string; rotation: number }[]): void {
    const changed: PixiGraphElement[] = [];
    for (const u of updates) {
      const ele = this.elementMap.get(u.id);
      if (!ele || !ele.isNode() || !Number.isFinite(u.rotation)) continue;
      ele._setRotation(u.rotation);
      this.renderElement(ele);
      changed.push(ele);
    }
    this._renderHandles();
    changed.forEach((ele) => this.eventBus.emit('rotation', ele));
  }

  /** 여러 노드 bbox 일괄 변경 — 그룹 리사이즈용. 영향 엣지/핸들은 1회만 재렌더. */
  setNodesBboxes(updates: { id: string; bbox: GraphBbox }[]): void {
    const touched = new Set<PixiGraphElement>();
    const changed: PixiGraphElement[] = [];
    for (const u of updates) {
      const ele = this.elementMap.get(u.id);
      if (!ele || !ele.isNode() || !Number.isFinite(u.bbox.w) || !Number.isFinite(u.bbox.h)) continue;
      ele._setBbox(u.bbox);
      this.renderElement(ele);
      ele.connectedEdges().forEach((e) => touched.add(e));
      changed.push(ele);
    }
    touched.forEach((e) => this._recomputeEdge(e));
    this._renderHandles();
    changed.forEach((ele) => this.eventBus.emit('bbox', ele));
  }

  /**
   * bbox 를 핸들 앵커(반대편 변/코너, center 면 중심) 기준으로 (sx,sy) 배율 스케일.
   * 다중선택 each 모드에서 한 노드 드래그 배율을 나머지에 동일 적용할 때 사용.
   */
  static scaleBboxAbout(orig: GraphBbox, key: string, sx: number, sy: number, center = false): GraphBbox {
    const affW = key.includes('e') || key.includes('w');
    const affH = key.includes('n') || key.includes('s');
    const nw = affW ? orig.w * sx : orig.w;
    const nh = affH ? orig.h * sy : orig.h;
    if (center) {
      const cx = orig.x + orig.w / 2, cy = orig.y + orig.h / 2;
      return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    }
    const x = affW ? (key.includes('w') ? orig.x + orig.w - nw : orig.x) : orig.x;
    const y = affH ? (key.includes('n') ? orig.y + orig.h - nh : orig.y) : orig.y;
    return { x, y, w: nw, h: nh };
  }

  /** 핸들 드래그 → 새 bbox 계산(순수 기하). orig=원본 bbox, key=핸들, (px,py)=포인터 graph-local. */
  static computeResizedBbox(
    orig: GraphBbox, key: string, px: number, py: number,
    opts: { center?: boolean; keepAspect?: boolean } = {},
  ): GraphBbox {
    const { center = false, keepAspect = false } = opts;
    const MIN = 1;
    const ar = orig.h > 0 ? orig.w / orig.h : 1; // width per height
    const cx = orig.x + orig.w / 2, cy = orig.y + orig.h / 2;
    const x2 = orig.x + orig.w, y2 = orig.y + orig.h;
    const affW = key.includes('e') || key.includes('w');
    const affH = key.includes('n') || key.includes('s');

    if (center) {
      let halfW = orig.w / 2, halfH = orig.h / 2;
      if (affW) halfW = Math.abs(px - cx);
      if (affH) halfH = Math.abs(py - cy);
      if (keepAspect) {
        if (affW && affH) {
          const sc = Math.max(halfW / (orig.w / 2 || 1), halfH / (orig.h / 2 || 1));
          halfW = (orig.w / 2) * sc; halfH = (orig.h / 2) * sc;
        } else if (affW) halfH = halfW / ar;
        else if (affH) halfW = halfH * ar;
      }
      halfW = Math.max(MIN / 2, halfW); halfH = Math.max(MIN / 2, halfH);
      return { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
    }

    // 반대편 변/코너 고정.
    const anchorX = key.includes('w') ? x2 : orig.x;
    const anchorY = key.includes('n') ? y2 : orig.y;
    let newW = affW ? Math.abs(px - anchorX) : orig.w;
    let newH = affH ? Math.abs(py - anchorY) : orig.h;
    const signX = affW ? (Math.sign(px - anchorX) || (key.includes('w') ? -1 : 1)) : 1;
    const signY = affH ? (Math.sign(py - anchorY) || (key.includes('n') ? -1 : 1)) : 1;

    if (keepAspect) {
      if (affW && affH) {
        const sc = Math.max(newW / (orig.w || 1), newH / (orig.h || 1));
        newW = orig.w * sc; newH = orig.h * sc;
      } else if (affW) newH = newW / ar;
      else if (affH) newW = newH * ar;
    }
    newW = Math.max(MIN, newW); newH = Math.max(MIN, newH);

    let rx = affW ? (signX >= 0 ? anchorX : anchorX - newW) : orig.x;
    let ry = affH ? (signY >= 0 ? anchorY : anchorY - newH) : orig.y;
    // 단축(변) + 비율유지 시 파생 치수는 가운데 정렬.
    if (keepAspect && affW && !affH) ry = cy - newH / 2;
    if (keepAspect && affH && !affW) rx = cx - newW / 2;
    return { x: rx, y: ry, w: newW, h: newH };
  }

  /** 노드 hit 판정 — polygon/타원/사각형 실제 모양 기준. (x,y) graph-local. 회전 시 local 좌표로 역변환. */
  private _nodeHit(ele: PixiGraphElement, x: number, y: number): boolean {
    const b = ele.bbox();
    const r = ele.rotation();
    if (r) { // 점을 노드 local(미회전) 좌표로 역회전
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const cos = Math.cos(-r), sin = Math.sin(-r);
      const dx = x - cx, dy = y - cy;
      x = cx + dx * cos - dy * sin;
      y = cy + dx * sin + dy * cos;
    }
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false; // bbox 빠른 reject
    const shape = this._nodeShape(ele);
    if (shape === 'polygon') {
      const poly = this._nodePolygonPoints(ele);
      return poly ? pointInPolygon(x, y, poly) : true;
    }
    if (shape === 'circle') {
      const rx = b.w / 2 || 1, ry = b.h / 2 || 1;
      const nx = (x - (b.x + b.w / 2)) / rx, ny = (y - (b.y + b.h / 2)) / ry;
      return nx * nx + ny * ny <= 1;
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────
  // Hit-test
  // ──────────────────────────────────────────────────────────

  /**
   * graph-local 좌표 (x, y) 에서 가장 가까운/위에 있는 element.
   *
   *  - 노드 우선 (cytoscape z-order: nodes drawn on top of edges).
   *  - 노드: bbox 안에 점 포함. 중첩 시 가장 작은 면적 우선 (작은 노드가 위에 있다고 가정).
   *  - 엣지: 선분 거리 ≤ stroke 반경 + 1px padding 이면 후보. 거리 가까운 것 우선.
   *
   * @returns 최우선 매칭 element, 없으면 null.
   */
  elementAt(x: number, y: number): PixiGraphElement | null {
    let foundNode: PixiGraphElement | null = null;
    let nodeArea = Infinity;
    let foundEdge: PixiGraphElement | null = null;
    let edgeDist = Infinity;

    this.elementMap.forEach((ele) => {
      if (ele.hasClass('unselected') || ele.hasClass('preview')) return; // 비활성/미리보기는 hit 제외
      if (ele.isNode()) {
        if (this._nodeHit(ele, x, y)) {
          const b = ele.bbox();
          const area = Math.max(1, b.w * b.h);
          if (area < nodeArea) { nodeArea = area; foundNode = ele; }
        }
        return;
      }
      // edge — 현재 effective width 기반 threshold (per-edge style 반영).
      const s = ele.sourcePoint();
      const t = ele.targetPoint();
      if (!s || !t) return;
      const eff = this.styleEngine.computeStyle(ele, this.edgeDefaults);
      const threshold = Number(eff.width ?? this.edgeDefaults.width ?? 1) + this._hitTolerance;
      // 곡선 엣지면 marker 저장된 sample point 들 중 가장 가까운 segment.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const samples = (ele as any)._renderedCurve as GraphPoint[] | undefined;
      let d: number;
      if (samples && samples.length >= 2) {
        d = Infinity;
        for (let i = 0; i + 1 < samples.length; i++) {
          const dd = distancePointSegment(x, y, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y);
          if (dd < d) d = dd;
        }
      } else {
        d = distancePointSegment(x, y, s.x, s.y, t.x, t.y);
      }
      if (d < threshold && d < edgeDist) { edgeDist = d; foundEdge = ele; }
    });

    return foundNode ?? foundEdge;
  }

  /** 엣지 hit-test 허용 거리(graph-local px) 설정. viewer 가 줌 변경 시 갱신. */
  setHitTolerance(px: number): void {
    if (Number.isFinite(px) && px >= 0) this._hitTolerance = px;
  }

  /** node 만 hit-test — elementAt 와 동일 규칙. */
  nodeAt(x: number, y: number): PixiGraphElement | null {
    let found: PixiGraphElement | null = null;
    let bestArea = Infinity;
    this.elementMap.forEach((ele) => {
      if (!ele.isNode() || ele.hasClass('unselected') || ele.hasClass('preview')) return;
      if (this._nodeHit(ele, x, y)) {
        const b = ele.bbox();
        const area = Math.max(1, b.w * b.h);
        if (area < bestArea) { bestArea = area; found = ele; }
      }
    });
    return found;
  }

  /** edge 만 hit-test — elementAt 와 동일 규칙. */
  edgeAt(x: number, y: number): PixiGraphElement | null {
    let found: PixiGraphElement | null = null;
    let bestDist = Infinity;
    this.elementMap.forEach((ele) => {
      if (!ele.isEdge() || ele.hasClass('unselected') || ele.hasClass('preview')) return;
      const s = ele.sourcePoint(); const t = ele.targetPoint();
      if (!s || !t) return;
      const eff = this.styleEngine.computeStyle(ele, this.edgeDefaults);
      const threshold = Number(eff.width ?? this.edgeDefaults.width ?? 1) + this._hitTolerance;
      const d = distancePointSegment(x, y, s.x, s.y, t.x, t.y);
      if (d < threshold && d < bestDist) { bestDist = d; found = ele; }
    });
    return found;
  }

  // ──────────────────────────────────────────────────────────
  // 스타일 — declarative rules
  // ──────────────────────────────────────────────────────────

  /**
   * 스타일 규칙 전체 교체 (cytoscape `cy.style()` 동작). 모든 element 재렌더 트리거.
   * 빈 배열을 넘기면 user 규칙 없음 → 시스템 rules (`.dim` 등) + group defaults 만 사용.
   *
   * 시스템 클래스 (`.dim` 등) 는 라이브러리가 자동 prepend — user 가 같은 selector 를 명시하면
   * 선언 순서 cascade 로 이김. 즉 시각 override 가능하지만 정의 강제는 안 함.
   */
  style(rules: PixiGraphStyleRule[]): void {
    this._userStyleRules = rules ?? [];
    this.styleEngine.setRules([...this._systemStyleRules, ...this._userStyleRules]);
    this.elementMap.forEach((ele) => this.renderElement(ele));
  }

  /**
   * 한 element 만 재렌더 — 상태 변경 (addClass/removeClass/select/unselect) 시 PixiGraphElement
   * 가 호출. ElementGraphHandle 인터페이스의 _restyleElement 구현.
   */
  _restyleElement(ele: PixiGraphElement): void {
    if (this.destroyed) return;
    this.renderElement(ele);
  }

  // ──────────────────────────────────────────────────────────
  // 렌더링 (내부)
  // ──────────────────────────────────────────────────────────

  /**
   * element 1개를 effective style 로 다시 그림.
   *  - 노드 group defaults → 매칭 규칙 cascade → highlight 그룹 override
   *  - 노드: rect + fill({fill, alpha})
   *  - 엣지: moveTo/lineTo + stroke({stroke, width, alpha})
   *  - fill/stroke 가 미정이면 group defaults 의 값 사용 (안전 fallback).
   */
  private renderElement(ele: PixiGraphElement): void {
    const g = ele.view;
    g.clear();
    const defaults = ele.isNode() ? this.nodeDefaults : this.edgeDefaults;
    const cascade = this.styleEngine.computeStyle(ele, defaults);
    const hStyle = this.highlightManager.styleFor(ele);
    const s = hStyle ? { ...cascade, ...hStyle } : cascade;

    if (ele.isNode()) {
      const b = ele.bbox();
      // 회전: 중심 기준. pivot=position=center 로 두면 절대좌표로 그린 모양이 center 기준 회전.
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      g.pivot.set(cx, cy); g.position.set(cx, cy); g.rotation = ele.rotation();
      // 모양 디스패치(node_type): polygon → poly(polygonPoints), circle → 타원, 그 외 rect.
      const shape = this._nodeShape(ele);
      const flat = shape === 'polygon' ? this._nodePolygonPoints(ele) : null;
      if (flat) g.poly(flat);
      else if (shape === 'circle') g.ellipse(cx, cy, b.w / 2, b.h / 2);
      else g.rect(b.x, b.y, b.w, b.h);
      g.fill({
        color: s.fill ?? this.nodeDefaults.fill ?? 0x000000,
        alpha: s.alpha ?? this.nodeDefaults.alpha ?? 1,
      });
      return;
    }
    // edge
    let sp = ele.sourcePoint(); let tp = ele.targetPoint();
    if (!sp || !tp) return;
    const color = s.stroke ?? this.edgeDefaults.stroke ?? 0x000000;
    const rawWidth = Number(s.width ?? this.edgeDefaults.width ?? 1);
    const alpha = s.alpha ?? this.edgeDefaults.alpha ?? 1;
    const arrowShape = (s.arrowShape ?? this.edgeDefaults.arrowShape ?? 'none') as ('triangle' | 'none');
    const arrowSize = Number(s.arrowSize ?? this.edgeDefaults.arrowSize ?? rawWidth * 3);
    const lineCap = (s.lineCap ?? this.edgeDefaults.lineCap ?? 'butt') as ('butt' | 'round');
    const lineDash = Number(s.lineDash ?? this.edgeDefaults.lineDash ?? 0);
    const lineGap = Number(s.lineGap ?? this.edgeDefaults.lineGap ?? lineDash);
    // dashOffset — per-edge style 우선, 없으면 graph 전역 offset(애니메이션용).
    const lineDashOffset = Number(s.lineDashOffset ?? this._dashOffsetGlobal);
    const dx0 = tp.x - sp.x, dy0 = tp.y - sp.y;
    const len0 = Math.hypot(dx0, dy0);
    const hasArrow = arrowShape === 'triangle' && arrowSize > 0;
    const isRound = lineCap === 'round';
    // parallel count 먼저 계산 → compact 판정에 필요.
    let parallelCount = 1;
    let normOffset = 0; // -1 ~ +1 (count 무관 일정)
    let dirSign = 1;
    if (len0 > 0) {
      const par = this._parallelEdges(ele);
      const count = par.length;
      parallelCount = count;
      if (count > 1) {
        const idx = par.indexOf(ele);
        const offsetIdx = idx - (count - 1) / 2;
        const maxAbs = (count - 1) / 2 || 1;
        normOffset = offsetIdx / maxAbs; // 가장 바깥 ±1, 안쪽은 비례.
        dirSign = (sp.x < tp.x || (sp.x === tp.x && sp.y < tp.y)) ? 1 : -1;
      }
    }
    // 다중 엣지면 굵기 반 + 화살표 약간 축소.
    const width = parallelCount > 1 ? rawWidth * 0.5 : rawWidth;
    const halfW = width / 2;
    const arrowScale = parallelCount > 1 ? 0.7 : 1;
    const scaledArrowSize = arrowSize * arrowScale;
    // 다중일 때 compact 가 나올 길이(arrowSize 이하)면 — center-to-center(노드 중심) 로 sp/tp 바꿔서 곡선만 그림.
    //   compact 모드 자체는 적용 안 함(line 항상 그림). 단일 엣지면 기존 compact 유지.
    if (parallelCount > 1 && len0 > 0 && len0 <= scaledArrowSize) {
      const src = ele.source(); const tgt = ele.target();
      if (src && tgt) {
        sp = { x: src.position().x, y: src.position().y };
        tp = { x: tgt.position().x, y: tgt.position().y };
      }
    }
    // 다중 + 가운데 아닌 엣지면 fan-out + curve 적용.
    let cpX = 0, cpY = 0, isCurve = false;
    if (parallelCount > 1 && normOffset !== 0) {
      const ndx = tp.x - sp.x, ndy = tp.y - sp.y;
      const nlen = Math.hypot(ndx, ndy);
      if (nlen > 0) {
        const ux0 = ndx / nlen, uy0 = ndy / nlen;
        const px0 = -uy0, py0 = ux0;
        const src = ele.source(); const tgt = ele.target();
        const srcMin = src ? Math.min(src.bbox().w, src.bbox().h) : 30;
        const tgtMin = tgt ? Math.min(tgt.bbox().w, tgt.bbox().h) : 30;
        const endShift = Math.max(8, Math.min(20, Math.min(srcMin, tgtMin) * 0.35));
        sp = { x: sp.x + px0 * endShift * normOffset * dirSign, y: sp.y + py0 * endShift * normOffset * dirSign };
        tp = { x: tp.x + px0 * endShift * normOffset * dirSign, y: tp.y + py0 * endShift * normOffset * dirSign };
        const midX = (sp.x + tp.x) / 2, midY = (sp.y + tp.y) / 2;
        const spacing = Math.max(20, Math.min(45, 1500 / Math.max(40, nlen)));
        cpX = midX + px0 * spacing * normOffset * dirSign;
        cpY = midY + py0 * spacing * normOffset * dirSign;
        isCurve = true;
      }
    }
    // 단일 엣지만 compact 모드. 다중은 위에서 center-to-center 로 처리됨.
    const segLen = Math.hypot(tp.x - sp.x, tp.y - sp.y);
    const isCompact = hasArrow && parallelCount === 1 && segLen <= scaledArrowSize;
    const drawLine = !hasArrow || parallelCount > 1 || segLen > scaledArrowSize;
    const drawArrow = hasArrow && (segLen > 0 || isCurve);
    // 양 끝 접선 방향 — 직선이면 (tp-sp), 곡선이면 source 쪽은 (cp-sp), target 쪽은 (tp-cp).
    const srcAwayX = (isCurve ? cpX : tp.x) - sp.x;
    const srcAwayY = (isCurve ? cpY : tp.y) - sp.y;
    const srcAwayLen = Math.hypot(srcAwayX, srcAwayY) || 1;
    const sux = srcAwayX / srcAwayLen, suy = srcAwayY / srcAwayLen;
    const tgtAwayX = tp.x - (isCurve ? cpX : sp.x);
    const tgtAwayY = tp.y - (isCurve ? cpY : sp.y);
    const tgtAwayLen = Math.hypot(tgtAwayX, tgtAwayY) || 1;
    const tux = tgtAwayX / tgtAwayLen, tuy = tgtAwayY / tgtAwayLen;
    const effArrowSize = isCompact ? scaledArrowSize * 0.6 : scaledArrowSize;
    const startX = isRound ? sp.x + sux * halfW : sp.x;
    const startY = isRound ? sp.y + suy * halfW : sp.y;
    const arrowTipX = tp.x;
    const arrowTipY = tp.y;
    const endX = hasArrow ? arrowTipX - tux * effArrowSize : (isRound ? tp.x - tux * halfW : tp.x);
    const endY = hasArrow ? arrowTipY - tuy * effArrowSize : (isRound ? tp.y - tuy * halfW : tp.y);
    if (drawLine) {
      if (lineDash > 0) {
        // dashed — 곡선은 24 sample 로 sampling 후 polyline dash.
        const pts: GraphPoint[] = [{ x: startX, y: startY }];
        if (isCurve) {
          const SAMPLES = 24;
          for (let i = 1; i < SAMPLES; i++) {
            const t = i / SAMPLES, u = 1 - t;
            pts.push({ x: u * u * startX + 2 * u * t * cpX + t * t * endX, y: u * u * startY + 2 * u * t * cpY + t * t * endY });
          }
        }
        pts.push({ x: endX, y: endY });
        this._dashPolyline(g, pts, lineDash, lineGap, lineDashOffset);
      } else if (isCurve) g.moveTo(startX, startY).quadraticCurveTo(cpX, cpY, endX, endY);
      else g.moveTo(startX, startY).lineTo(endX, endY);
      g.stroke({ color, width, alpha, cap: lineCap });
    }
    if (drawArrow) {
      const px = -tuy, py = tux;
      g.poly([
        arrowTipX, arrowTipY,
        endX + px * effArrowSize * 0.5, endY + py * effArrowSize * 0.5,
        endX - px * effArrowSize * 0.5, endY - py * effArrowSize * 0.5,
      ]).fill({ color, alpha });
    }
    // 곡선/shift 된 경우 hit-test 가 실제 렌더링 모양 따라가도록 sample 저장.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eleAny = ele as any;
    if (isCurve) {
      const SAMPLES = 16;
      const pts: GraphPoint[] = [{ x: startX, y: startY }];
      for (let i = 1; i < SAMPLES; i++) {
        const t = i / SAMPLES, u = 1 - t;
        pts.push({ x: u * u * startX + 2 * u * t * cpX + t * t * endX, y: u * u * startY + 2 * u * t * cpY + t * t * endY });
      }
      pts.push({ x: endX, y: endY });
      eleAny._renderedCurve = pts;
    } else {
      eleAny._renderedCurve = undefined;
    }
  }

  /** 같은 source/target 쌍(양방향 포함) 인 엣지 모음 — id 정렬, 자기 자신 포함. */
  private _parallelEdges(ele: PixiGraphElement): PixiGraphElement[] {
    const src = ele.source(); const tgt = ele.target();
    if (!src || !tgt) return [ele];
    const set = this._edgesByPair.get(this._pairKey(src.id(), tgt.id()));
    if (!set || set.size === 0) return [ele];
    return [...set].sort((a, b) => a.id().localeCompare(b.id()));
  }

  // ──────────────────────────────────────────────────────────
  // 토폴로지 — 엣지 분기 / 인라인 삽입 / 체인 빼내기.
  //   순수 그래프 데이터 조작 — 인터랙션은 호출부(viewer) 가 처리.
  // ──────────────────────────────────────────────────────────

  /**
   * 점 p 에 가장 가까운 엣지(threshold 내). 자기 자신에 연결된 엣지, `.preview` 클래스는 제외.
   * @param p             검사 점 (graph-local)
   * @param threshold     허용 거리(graph-local px)
   * @param excludeNodeId 이 노드에 연결된 엣지는 제외 (자기 자신 인라인 삽입 방지)
   */
  findEdgeNear(p: GraphPoint, threshold: number, excludeNodeId?: string): PixiGraphElement | null {
    let best: PixiGraphElement | null = null;
    let minD = Infinity;
    this.edges().forEach((e) => {
      if (e.hasClass('preview')) return;
      const s = e.source(); const t = e.target();
      if (!s || !t) return;
      if (excludeNodeId && (s.id() === excludeNodeId || t.id() === excludeNodeId)) return;
      const sc = s.position(); const tc = t.position();
      const d = ptSegDist(p, sc, tc);
      if (d < minD) { minD = d; best = e; }
    });
    return minD < threshold ? best : null;
  }

  /**
   * 점 p 를 엣지에 투영해 그 위치 반환 (노드 침범 방지 클램프 적용).
   * 호출부가 분기점 / 미리보기 Tee 위치 등에 사용.
   */
  projectOnEdge(edge: PixiGraphElement, p: GraphPoint): GraphPoint | null {
    if (!edge.isEdge()) return null;
    const s = edge.source(); const t = edge.target();
    if (!s || !t) return null;
    return projectOnSeg(p, s.position(), t.position());
  }

  /**
   * 노드가 "엣지-노드-엣지" 체인인지 검출 — incoming(타겟=노드) + outgoing(소스=노드) 정확히 2 엣지.
   * 양 끝이 다른 노드 (self-loop 제외).
   */
  detectChain(node: PixiGraphElement): {
    incoming: PixiGraphElement; outgoing: PixiGraphElement;
    src: PixiGraphElement; tgt: PixiGraphElement;
  } | null {
    if (!node || !node.isNode()) return null;
    const conn = node.connectedEdges();
    if (conn.length !== 2) return null;
    const nid = node.id();
    const incoming = conn.find((e) => e.target()?.id() === nid && e.source()?.id() !== nid);
    const outgoing = conn.find((e) => e.source()?.id() === nid && e.target()?.id() !== nid);
    if (!incoming || !outgoing || incoming === outgoing) return null;
    const src = incoming.source(); const tgt = outgoing.target();
    if (!src || !tgt || src.id() === tgt.id()) return null;
    return { incoming, outgoing, src, tgt };
  }

  /**
   * 체인의 두 엣지를 제거하고 src→tgt 단일 엣지로 병합. incoming 의 properties 우선 보존.
   * @returns 새 엣지 id (실패 시 null)
   */
  mergeChain(chain: { incoming: PixiGraphElement; outgoing: PixiGraphElement; src: PixiGraphElement; tgt: PixiGraphElement }): string | null {
    if (!chain) return null;
    const { incoming, outgoing, src, tgt } = chain;
    const props = (incoming.data?.('properties') as object | undefined)
      ?? (outgoing.data?.('properties') as object | undefined)
      ?? {};
    this.history.beginBatch();
    try { this.remove(incoming.id()); } catch { /* noop */ }
    try { this.remove(outgoing.id()); } catch { /* noop */ }
    const id = `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_merged`;
    this.add({ edges: [{ id, source: src.id(), target: tgt.id(), data: { properties: { ...props } } }] });
    this.history.endBatch();
    return id;
  }

  /**
   * 기존 노드를 엣지에 인라인 삽입.
   *   기존 엣지 제거 + 노드의 모든 연결 엣지 제거 + src→node, node→tgt 두 갈래 신규.
   *   주로 Alt+드래그로 노드를 다른 엣지로 끌어 놓을 때 사용.
   * @returns 새로 생긴 두 엣지 id (실패 시 null)
   */
  insertNodeIntoEdge(nodeId: string, edgeId: string): { e1: string; e2: string } | null {
    const node = this.element(nodeId);
    const edge = this.element(edgeId);
    if (!node || !node.isNode() || !edge || !edge.isEdge()) return null;
    const src = edge.source(); const tgt = edge.target();
    if (!src || !tgt) return null;
    const ep = (edge.data?.('properties') as object | undefined) ?? {};
    this.history.beginBatch();
    node.connectedEdges().forEach((e) => { try { this.remove(e.id()); } catch { /* noop */ } });
    try { this.remove(edgeId); } catch { /* noop */ }
    const ts = Date.now();
    const e1 = `edge_${ts}_${Math.random().toString(36).slice(2, 6)}_a`;
    const e2 = `edge_${ts}_${Math.random().toString(36).slice(2, 6)}_b`;
    this.add({ edges: [
      { id: e1, source: src.id(), target: nodeId, data: { properties: { ...ep } } },
      { id: e2, source: nodeId, target: tgt.id(), data: { properties: { ...ep } } },
    ] });
    this.history.endBatch();
    return { e1, e2 };
  }

  /**
   * 엣지에 새 노드를 분기 — 클릭 위치 투영점에 노드 생성 + src→node, node→tgt 두 갈래.
   *   E 모드(엣지 생성) 의 "빈 엣지 분기" 동작.
   * @param edgeId       분기될 엣지
   * @param nodeBbox     생성될 노드 bbox
   * @param nodeInput    노드 추가 옵션(shape, polygonPoints, data 등) — id 는 자동 생성.
   * @returns { nodeId, e1, e2 } 또는 null
   */
  splitEdgeAt(edgeId: string, nodeBbox: GraphBbox, nodeInput?: Omit<PixiGraphNodeInput, 'id' | 'bbox'>): { nodeId: string; e1: string; e2: string } | null {
    const edge = this.element(edgeId);
    if (!edge || !edge.isEdge()) return null;
    const src = edge.source(); const tgt = edge.target();
    if (!src || !tgt) return null;
    const ep = (edge.data?.('properties') as object | undefined) ?? {};
    const ts = Date.now();
    const rnd = () => Math.random().toString(36).slice(2, 6);
    const nodeId = `node_${ts}_${rnd()}_split`;
    const e1 = `edge_${ts}_${rnd()}_a`;
    const e2 = `edge_${ts}_${rnd()}_b`;
    this.history.beginBatch();
    try { this.remove(edgeId); } catch { /* noop */ }
    this.add({
      nodes: [{ ...(nodeInput || {}), id: nodeId, bbox: nodeBbox }],
      edges: [
        { id: e1, source: src.id(), target: nodeId, data: { properties: { ...ep } } },
        { id: e2, source: nodeId, target: tgt.id(), data: { properties: { ...ep } } },
      ],
    });
    this.history.endBatch();
    return { nodeId, e1, e2 };
  }

  // ── 토폴로지 미리보기 (Alt+드래그 insert/extract) — PreviewManager 위임 ──
  /** 인라인 삽입 미리보기 — target 엣지에 dim + 두 갈래 preview. 같은 (node,edge) 면 no-op. */
  previewInsert(nodeId: string, targetEdge: PixiGraphElement): boolean {
    return this.previewManager.previewInsert(nodeId, targetEdge);
  }
  /** 체인 빼내기 미리보기 — 두 엣지 preview-removed + 병합 preview. 같은 체인이면 no-op. */
  previewMerge(chain: { incoming: PixiGraphElement; outgoing: PixiGraphElement; src: PixiGraphElement; tgt: PixiGraphElement }): boolean {
    return this.previewManager.previewMerge(chain);
  }
  /** 활성 미리보기의 insert target 엣지 element. */
  currentPreviewInsertTarget(): PixiGraphElement | null {
    return this.previewManager.currentInsertTargetEdge();
  }
  /** 미리보기 활성 여부 (sig 있음). */
  hasActivePreview(): boolean { return this.previewManager.isActive(); }
  /** 모든 미리보기 정리 (preview-dim/preview-removed 해제 + .preview 임시 요소 제거). */
  clearPreviews(): void { this.previewManager.clear(); }

  /** 두 노드 연결 — 새 엣지 id 자동 생성. 같은 노드면 null. */
  connect(sourceId: string, targetId: string, props: object = {}): string | null {
    if (!sourceId || !targetId || sourceId === targetId) return null;
    const id = `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_new`;
    this.add({ edges: [{ id, source: sourceId, target: targetId, data: { properties: { ...props } } }] });
    return id;
  }

  // ──────────────────────────────────────────────────────────
  // 복사/붙여넣기 — PixiGraphClipboard 에 delegate.
  //   상태는 모듈 레벨이라 같은 페이지의 여러 PixiGraph 인스턴스가 공유 (탭 간 복붙).
  // ──────────────────────────────────────────────────────────
  copySelection(): boolean { return ClipboardModule.copySelection(this); }
  cutSelection(): boolean { return ClipboardModule.cutSelection(this); }
  copyProperties(): boolean { return ClipboardModule.copyProperties(this); }
  paste(model: GraphPoint): string[] { return ClipboardModule.paste(this, model); }
  pasteProperties(): number { return ClipboardModule.pasteProperties(this); }
  duplicate(): string[] { return ClipboardModule.duplicate(this); }
  hasClipboard(): boolean { return ClipboardModule.hasClipboard(); }
  hasPropertyClipboard(): boolean { return ClipboardModule.hasPropertyClipboard(); }
  beginCopyDrag(): boolean { return ClipboardModule.beginCopyDrag(this); }
  updateCopyDrag(dx: number, dy: number): void { ClipboardModule.updateCopyDrag(this, dx, dy); }
  commitCopyDrag(dx: number, dy: number): string[] { return ClipboardModule.commitCopyDrag(this, dx, dy); }
  cancelCopyDrag(): void { ClipboardModule.cancelCopyDrag(this); }
  isCopyDragActive(): boolean { return ClipboardModule.isCopyDragActive(); }

  // ──────────────────────────────────────────────────────────
  // lifecycle
  // ──────────────────────────────────────────────────────────

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.eventBus.destroy();
    this.clear();
    try { this.edgesLayer.destroy({ children: true }); } catch { /* noop */ }
    try { this.nodesLayer.destroy({ children: true }); } catch { /* noop */ }
    try { this.view.parent?.removeChild(this.view); } catch { /* noop */ }
    try { this.view.destroy({ children: true }); } catch { /* noop */ }
  }

  /** 외부에서 graph 가 살아있는지 확인 (option). */
  isDestroyed(): boolean { return this.destroyed; }
}
