/**
 * PixiGraphElement — cytoscape `ele` 와 동일 컨셉의 element 래퍼.
 *
 * 외부 사용자는 이 클래스를 직접 생성하지 않는다. PixiGraph 가 add() 호출 시 만들고,
 * graph.element(id) / graph.elements() / graph.nodes() 등으로 받는다.
 *
 * 책임:
 *  - id / group / data / bbox 노출 (read-only)
 *  - 그래프 탐색 (source/target/connectedEdges)
 *  - 상태: classes (.addClass/.removeClass/...) + selected (.select/.unselect/.selected)
 *  - 내부 pixi Graphics 핸들 보유 (.view) — 외부에서 직접 grab 하지 말 것 권장.
 *
 * 비-책임 (향후 다른 모듈로):
 *  - 시각 스타일 결정 — 상태/클래스 변경 시 PixiGraph 가 style rules 로 재렌더 (C 단계)
 *  - 이벤트 발행 (D 단계)
 *
 * 클래스/선택 상태 변경 자체는 데이터 mutation 만 — 시각 재렌더는 PixiGraph 가
 * style rules 적용 단계에서 트리거. 이번 B 단계엔 데이터 모델만.
 */

import type { Graphics } from 'pixi.js';
import type { ElementGroup, GraphBbox, GraphPoint } from './types';

/** 엣지 전용 메타 — 양 끝 노드 id 와 사전 계산된 끝점 좌표. */
export interface EdgeMeta {
  srcId: string;
  tgtId: string;
  /** src 노드 중심 (image-local). PixiGraph.add 가 한 번만 계산해 저장. */
  src: GraphPoint;
  /** tgt 노드 중심. */
  tgt: GraphPoint;
}

/** PixiGraph 가 graph 인스턴스를 element 에 주입할 때 사용하는 최소 인터페이스. */
export interface ElementGraphHandle {
  element(id: string): PixiGraphElement | null;
  edges(): PixiGraphElement[];
  /**
   * 한 element 의 시각만 재렌더 — 상태 (classes/selected) 변경 시 element 가 호출.
   * PixiGraph 가 구현 (C 단계). 미구현 graph 라면 옵셔널이라 호출 safe.
   */
  _restyleElement?(ele: PixiGraphElement): void;
  /**
   * 선택 상태 변경 통지 — select()/unselect() 시 element 가 호출.
   * PixiGraph 가 'select'/'unselect' 이벤트로 발행 → 외부(React) 구독 가능.
   */
  _emitSelectionChange?(ele: PixiGraphElement, selected: boolean): void;
  /**
   * data(key, value) 변경 통지 — element 가 호출.
   * PixiGraph 가 'data' 이벤트로 발행 → 외부 구독 가능(useDeltaTracker 등).
   */
  _emitDataChange?(ele: PixiGraphElement, key: string, value: unknown): void;
}

export class PixiGraphElement {
  /** pixi Graphics 핸들. 외부에서 직접 그리지 말 것 (PixiGraph 가 관리). */
  public readonly view: Graphics;

  private readonly _id: string;
  private readonly _group: ElementGroup;
  private readonly _data: Record<string, unknown>;
  private _bbox: GraphBbox;            // 리사이즈/이동으로 변경 가능 (graph 가 _setBbox 로 갱신).
  private _edgeMeta: EdgeMeta | null;  // 끝점은 노드 이동 시 graph 가 _setEdgePoints 로 갱신.
  private _rotation = 0;               // 노드 회전각(라디안), 중심 기준. graph 가 _setRotation 으로 갱신.
  // 노드 모양/기하 — 도메인 무관 1급 속성. 라이브러리는 도메인 데이터(data.properties.*) 안 봄.
  private _shape: 'rect' | 'circle' | 'polygon' | null = null;
  private _polygonPoints: number[] | null = null; // bbox 기준 [0,1] 정규화
  // 노드 시각을 image/SVG 로 렌더 — graph 가 texture-fill 로 bbox 에 stretch.
  private _image: string | null = null;
  // 요소별 편집 가능 플래그(cytoscape 스타일). 노드 한정 의미 있는 것도 있음.
  private _selectable = true;
  private _resizable = true;
  private _rotatable = true;
  private _movable = true;
  // 선택 시 표시할 핸들 종류 — 'rect'(기본: 사각 리사이즈 핸들) / 'vertex'(polygon 정점 편집).
  // 'vertex' 면 라이브러리는 그 노드에 사각 핸들 안 그림 — 호출부(viewer/editor)가 정점 핸들 오버레이로 처리.
  private _handleMode: 'rect' | 'vertex' = 'rect';
  private readonly _graph: ElementGraphHandle;
  /** cytoscape `ele.classes()` 와 동일 — 임의 문자열 클래스 set. */
  private readonly _classes: Set<string> = new Set();
  /** cytoscape `:selected` pseudo-state — `.classes` 와 별개로 관리. */
  private _selected = false;
  /**
   * HighlightManager 가 mutate — 이 element 가 속한 highlight 그룹 id 들.
   * 외부에서 직접 mutate 하지 말 것 (graph.highlight/unhighlight API 사용).
   */
  public readonly _highlightGroupIds: Set<string> = new Set();

  constructor(args: {
    id: string;
    group: ElementGroup;
    data: Record<string, unknown>;
    bbox: GraphBbox;
    view: Graphics;
    graph: ElementGraphHandle;
    edgeMeta?: EdgeMeta;
  }) {
    this._id = args.id;
    this._group = args.group;
    // shallow-copy — args.data 가 Redux/Immer frozen 객체일 수 있어 in-place mutation 불가.
    //   data(key, value) 가 this._data[key] = value 로 쓰므로 root 만 unfrozen 이면 됨.
    //   nested object 는 호출부가 새 객체로 교체하는 패턴(예: ele.data('properties', { ...next }))이라 OK.
    this._data = { ...args.data };
    this._bbox = args.bbox;
    this.view = args.view;
    this._graph = args.graph;
    this._edgeMeta = args.edgeMeta ?? null;
  }

  // ── 식별 / 분류 ──────────────────────────────────────────

  id(): string { return this._id; }
  group(): ElementGroup { return this._group; }
  isNode(): boolean { return this._group === 'node'; }
  isEdge(): boolean { return this._group === 'edge'; }

  // ── 데이터 ──────────────────────────────────────────────

  /** 전체 data 객체 반환. */
  data(): Record<string, unknown>;
  /** key 한 개 조회. */
  data<T = unknown>(key: string): T | undefined;
  /** key 값 설정 — chainable. in-place mutation. */
  data(key: string, value: unknown): this;
  data(key?: string, value?: unknown): unknown {
    if (key === undefined) return this._data;
    if (arguments.length < 2) return this._data[key];
    this._data[key] = value;
    this._graph._emitDataChange?.(this, key, value);
    return this;
  }

  // ── 위치 / 영역 ─────────────────────────────────────────

  /** image-local bbox 반환. node 는 영역, edge 는 src↔tgt 끼리의 AABB. */
  bbox(): GraphBbox { return this._bbox; }

  /** 내부 — graph 가 리사이즈/이동 시 bbox 갱신 (직접 호출 금지, graph.setNodeBbox 사용). */
  _setBbox(b: GraphBbox): void { this._bbox = { x: b.x, y: b.y, w: b.w, h: b.h }; }

  /** 노드 회전각(라디안). 중심 기준. */
  rotation(): number { return this._rotation; }
  /** 내부 — graph 가 회전 갱신 (graph.setNodeRotation 사용). */
  _setRotation(r: number): void { this._rotation = r; }

  // ── 노드 모양 / 기하 ───────────────────────────────────
  /** 명시된 모양('rect'|'circle'|'polygon')또는 미지정(null). graph 는 미지정 시 polygonPoints 유무로 추론. */
  shape(): 'rect' | 'circle' | 'polygon' | null;
  shape(v: 'rect' | 'circle' | 'polygon' | null): this;
  shape(v?: 'rect' | 'circle' | 'polygon' | null): ('rect' | 'circle' | 'polygon' | null) | this {
    if (v === undefined) return this._shape;
    this._shape = v; return this;
  }
  /** 다각형 꼭짓점 — bbox 기준 [0,1] 정규화 flat 배열. graph 가 절대좌표로 변환해 렌더/hit. */
  polygonPoints(): number[] | null;
  polygonPoints(v: number[] | null): this;
  polygonPoints(v?: number[] | null): (number[] | null) | this {
    if (v === undefined) return this._polygonPoints;
    this._polygonPoints = v ? v.slice() : null; return this;
  }
  /**
   * 노드 시각용 image/SVG URL. null 이면 기본 color fill.
   * 설정 시 graph 가 texture 비동기 로드 + 캐시 후 재렌더 트리거.
   */
  image(): string | null;
  image(v: string | null): this;
  image(v?: string | null): (string | null) | this {
    if (v === undefined) return this._image;
    this._image = v || null;
    this._graph._restyleElement?.(this);
    return this;
  }

  // ── 요소별 편집 플래그 (cytoscape 스타일 getter/setter — 인자 없으면 read, 있으면 set+chainable) ──
  selectable(): boolean;
  selectable(v: boolean): this;
  selectable(v?: boolean): boolean | this {
    if (v === undefined) return this._selectable;
    this._selectable = !!v; return this;
  }
  resizable(): boolean;
  resizable(v: boolean): this;
  resizable(v?: boolean): boolean | this {
    if (v === undefined) return this._resizable;
    this._resizable = !!v; return this;
  }
  rotatable(): boolean;
  rotatable(v: boolean): this;
  rotatable(v?: boolean): boolean | this {
    if (v === undefined) return this._rotatable;
    this._rotatable = !!v; return this;
  }
  /** 선택 시 표시할 핸들 종류 — 'rect'(기본 사각 리사이즈) / 'vertex'(polygon 정점 편집 — 호출부 오버레이가 담당, 라이브러리는 핸들 미표시). */
  handleMode(): 'rect' | 'vertex';
  handleMode(v: 'rect' | 'vertex'): this;
  handleMode(v?: 'rect' | 'vertex'): ('rect' | 'vertex') | this {
    if (v === undefined) return this._handleMode;
    this._handleMode = v; return this;
  }
  movable(): boolean;
  movable(v: boolean): this;
  movable(v?: boolean): boolean | this {
    if (v === undefined) return this._movable;
    this._movable = !!v; return this;
  }

  /** 내부 — 연결 노드 이동/리사이즈 시 graph 가 엣지 끝점 갱신. */
  _setEdgePoints(src: GraphPoint, tgt: GraphPoint): void {
    if (this._edgeMeta) { this._edgeMeta.src = src; this._edgeMeta.tgt = tgt; }
  }

  /** 중심점. node 는 bbox 중심, edge 는 src↔tgt 중간. */
  position(): GraphPoint {
    return {
      x: this._bbox.x + this._bbox.w / 2,
      y: this._bbox.y + this._bbox.h / 2,
    };
  }

  // ── 상태: classes ────────────────────────────────────────
  //
  // 모든 mutator 는 graph._restyleElement 콜백으로 자기 자신을 재렌더 트리거.
  // (변경 없는 경우 — addClass 가 이미 있는 클래스 — 도 콜백 호출. cheap.)

  /** 클래스 추가. 이미 있으면 no-op. chainable. */
  addClass(cls: string): this {
    if (!cls) return this;
    const changed = !this._classes.has(cls);
    this._classes.add(cls);
    if (changed) this._graph._restyleElement?.(this);
    return this;
  }

  /** 클래스 제거. 없으면 no-op. chainable. */
  removeClass(cls: string): this {
    if (!cls) return this;
    const changed = this._classes.delete(cls);
    if (changed) this._graph._restyleElement?.(this);
    return this;
  }

  /** 클래스 토글. chainable. */
  toggleClass(cls: string): this {
    if (!cls) return this;
    if (this._classes.has(cls)) this._classes.delete(cls);
    else this._classes.add(cls);
    this._graph._restyleElement?.(this);
    return this;
  }

  /** 클래스 존재 여부. */
  hasClass(cls: string): boolean {
    return this._classes.has(cls);
  }

  /** 모든 클래스 — string array (cytoscape 호환). */
  classes(): string[] {
    return [...this._classes];
  }

  // ── 상태: selected ──────────────────────────────────────

  /** selected 상태로 설정. chainable. */
  select(): this {
    if (!this._selected) {
      this._selected = true;
      this._graph._restyleElement?.(this);
      this._graph._emitSelectionChange?.(this, true);
    }
    return this;
  }

  /** selected 해제. chainable. */
  unselect(): this {
    if (this._selected) {
      this._selected = false;
      this._graph._restyleElement?.(this);
      this._graph._emitSelectionChange?.(this, false);
    }
    return this;
  }

  /** selected 여부. */
  selected(): boolean { return this._selected; }

  /** 이 element 가 속한 highlight 그룹 id 들 (read-only snapshot). */
  highlights(): string[] { return [...this._highlightGroupIds]; }
  /** 특정 highlight 그룹 속함 여부. */
  hasHighlight(id: string): boolean { return this._highlightGroupIds.has(id); }

  // ── 그래프 탐색 ─────────────────────────────────────────

  /** edge 전용 — src 노드 element. node 또는 src 노드 미등록이면 null. */
  source(): PixiGraphElement | null {
    if (!this._edgeMeta) return null;
    return this._graph.element(this._edgeMeta.srcId);
  }

  /** edge 전용 — tgt 노드 element. */
  target(): PixiGraphElement | null {
    if (!this._edgeMeta) return null;
    return this._graph.element(this._edgeMeta.tgtId);
  }

  /** edge 전용 — src 끝점 좌표 (사전 계산값). 렌더링/탐색에 사용. */
  sourcePoint(): GraphPoint | null {
    return this._edgeMeta ? this._edgeMeta.src : null;
  }

  /** edge 전용 — tgt 끝점 좌표. */
  targetPoint(): GraphPoint | null {
    return this._edgeMeta ? this._edgeMeta.tgt : null;
  }

  /** node 전용 — 이 노드를 src 또는 tgt 로 가지는 모든 edge. */
  connectedEdges(): PixiGraphElement[] {
    if (!this.isNode()) return [];
    return this._graph.edges().filter((e) => {
      const src = e.source(); const tgt = e.target();
      return src?.id() === this._id || tgt?.id() === this._id;
    });
  }
}
