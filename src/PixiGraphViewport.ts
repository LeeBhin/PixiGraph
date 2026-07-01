/**
 * PixiGraphViewport — pan/zoom 카메라.
 *
 * 라이브러리 옵션 `viewport: true | object` 로 활성. 활성 시 graph.view 가 viewport 의
 *   outer Container 가 되어, 그래프 내용(노드/엣지/핸들)은 내부 world 컨테이너 안에 들어감.
 *   pan/zoom 은 world 의 transform 을 조작.
 *
 * 기본 동작:
 *  - 프로그램 API: zoom/pan/setZoom/setPan/fit/center/panToElement/reset
 *  - tween 애니메이션 (duration/easing/onUpdate/onComplete, cancel 가능)
 *  - 자동 setViewScale — zoom 바뀔 때마다 PixiGraph 의 _viewScale 동기화 (핸들 크기 자동)
 *  - 자동 setHitTolerance — zoom 바뀌면 hit 영역 화면-px 일정 유지 (옵션 `hitTolerancePx`)
 *
 * 옵션 핸들러 (opt-in):
 *  - `wheel: true` — wheel zoom 자동 처리. host canvas 가 필요해 attach(canvas) 호출.
 *  - `drag: true` — 드래그 pan 자동 처리. 마우스 버튼/modifier 지정 가능. attach 필요.
 *
 * 비활성(`viewport: false`, 기본) — 기존과 동일. graph.view 는 그래프 콘텐츠 컨테이너.
 *   consumer 가 자체 world 컨테이너 만들고 pan/zoom 직접 관리.
 */

import { Container } from 'pixi.js';
import type { PixiGraph } from './PixiGraph';
import type { PixiGraphElement } from './PixiGraphElement';
import type { GraphBbox, GraphPoint } from './types';

export interface PixiGraphViewportConfig {
  /** wheel-zoom 자동 핸들러 활성. attach(canvas) 필요. 기본 false. */
  wheel?: boolean;
  /** wheel 한 deltaY(px) 단위당 zoom factor 계수. 기본 0.0015. */
  wheelSensitivity?: number;
  /**
   * 이 값(정규화된 |deltaY| px) 미만이면 트랙패드로 간주해 wheelFineBoost 를 곱한다.
   *   마우스 휠은 한 notch 당 delta 가 커서(≈100+) 영향 없음. 기본 40.
   */
  wheelFineThreshold?: number;
  /** 트랙패드(작은 연속 delta)의 sensitivity 배율 — 마우스 대비 답답함 보정. 기본 3. */
  wheelFineBoost?: number;
  /** drag-pan 자동 핸들러 활성. attach(canvas) 필요. 기본 false. */
  drag?: boolean;
  /** drag-pan 마우스 버튼. 기본 'middle'. (left 는 consumer 의 selection 과 충돌). */
  dragButton?: 'left' | 'middle' | 'right';
  /** drag-pan 시작 modifier. 'shift'|'ctrl'|'alt'|null. 기본 null. */
  dragModifier?: 'shift' | 'ctrl' | 'alt' | null;
  /** 최소 zoom. 기본 0.01. */
  minZoom?: number;
  /** 최대 zoom. 기본 20. */
  maxZoom?: number;
  /** hit tolerance 화면-px (zoom 따라 graph-local 환산). 기본 6. 0 이면 동기화 안 함. */
  hitTolerancePx?: number;
  /** transform 변경(setZoom/setPan/tween/wheel/drag) 시마다 호출. mini-map 동기화 등에. */
  onChange?: () => void;
}

export interface PanOptions {
  /** 애니메이션 ms. 0 이면 즉시 (기본 0). */
  duration?: number;
  /** easing 함수 t∈[0,1] → [0,1]. 기본 easeOutCubic. */
  easing?: (t: number) => number;
  /** fit padding — viewport 의 각 변 ratio (0~0.5). 기본 0.1. */
  padding?: number;
  /** 목표 zoom 직접 지정 — 미지정 시 padding 으로 fit. */
  zoom?: number;
  /** panToElement 단일 요소 시 ratio (요소가 화면 차지 비율). 기본 0.18. */
  ratio?: number;
  /** 결과 zoom 상한 (clamp). */
  maxZoom?: number;
  /** panToElement 호출 시 대상 자동 선택. 기본 true. */
  select?: boolean;
  onUpdate?: () => void;
  onComplete?: () => void;
}

export interface ViewportTween {
  cancel: () => void;
}

export class PixiGraphViewport {
  /** consumer 가 stage 에 add 하는 외부 컨테이너. */
  readonly view: Container;
  /** 내부 — graph content (graph.view) 가 자식으로 들어가는 카메라 컨테이너. */
  private readonly _world: Container;
  private readonly _graph: PixiGraph;
  private readonly _cfg: Required<PixiGraphViewportConfig>;
  private _hostCanvas: HTMLCanvasElement | null = null;
  private _activeTween: ViewportTween | null = null;
  private _wheelHandler: ((e: WheelEvent) => void) | null = null;
  private _pointerDownHandler: ((e: PointerEvent) => void) | null = null;
  private _pointerMoveHandler: ((e: PointerEvent) => void) | null = null;
  private _pointerUpHandler: ((e: PointerEvent) => void) | null = null;
  private _isDragPanning = false;
  private _dragLast: { x: number; y: number } | null = null;
  private _onChange: (() => void) | null = null;

  constructor(graph: PixiGraph, graphView: Container, config?: PixiGraphViewportConfig) {
    this._graph = graph;
    this.view = new Container();
    this._world = new Container();
    this.view.addChild(this._world);
    this._world.addChild(graphView);
    this._cfg = {
      wheel: config?.wheel ?? false,
      wheelSensitivity: config?.wheelSensitivity ?? 0.0015,
      wheelFineThreshold: config?.wheelFineThreshold ?? 40,
      wheelFineBoost: config?.wheelFineBoost ?? 3,
      drag: config?.drag ?? false,
      dragButton: config?.dragButton ?? 'middle',
      dragModifier: config?.dragModifier ?? null,
      minZoom: config?.minZoom ?? 0.01,
      maxZoom: config?.maxZoom ?? 20,
      hitTolerancePx: config?.hitTolerancePx ?? 6,
      onChange: config?.onChange ?? (() => undefined),
    };
    this._onChange = config?.onChange ?? null;
  }

  /** transform 변경 콜백 동적 갱신 (생성 후에도 가능). */
  setOnChange(cb: (() => void) | null): this {
    this._onChange = cb;
    return this;
  }

  /** host canvas attach — wheel/drag 핸들러 등록. consumer 가 호출. */
  attach(canvas: HTMLCanvasElement): void {
    this._hostCanvas = canvas;
    if (this._cfg.wheel) {
      this._wheelHandler = (e) => this._onWheel(e);
      canvas.addEventListener('wheel', this._wheelHandler, { passive: false });
    }
    if (this._cfg.drag) {
      this._pointerDownHandler = (e) => this._onPointerDown(e);
      this._pointerMoveHandler = (e) => this._onPointerMove(e);
      this._pointerUpHandler = () => this._onPointerUp();
      canvas.addEventListener('pointerdown', this._pointerDownHandler);
      window.addEventListener('pointermove', this._pointerMoveHandler);
      window.addEventListener('pointerup', this._pointerUpHandler);
    }
    // 초기 transform 적용으로 viewScale/hitTolerance 동기화.
    this._afterTransform();
  }

  /** 핸들러 detach + 진행 중 tween 취소. */
  destroy(): void {
    this._cancelTween();
    if (this._hostCanvas) {
      if (this._wheelHandler) this._hostCanvas.removeEventListener('wheel', this._wheelHandler);
      if (this._pointerDownHandler) this._hostCanvas.removeEventListener('pointerdown', this._pointerDownHandler);
    }
    if (this._pointerMoveHandler) window.removeEventListener('pointermove', this._pointerMoveHandler);
    if (this._pointerUpHandler) window.removeEventListener('pointerup', this._pointerUpHandler);
    this._hostCanvas = null;
    this._wheelHandler = null;
    this._pointerDownHandler = null;
    this._pointerMoveHandler = null;
    this._pointerUpHandler = null;
  }

  // ── camera state ──────────────────────────────────────────

  get zoom(): number { return this._world.scale.x; }
  get pan(): GraphPoint { return { x: this._world.x, y: this._world.y }; }
  /** 내부 world 컨테이너 — consumer 가 좌표 변환 등에 직접 참조 필요한 경우. */
  get world(): Container { return this._world; }

  setZoom(z: number, anchor?: { x: number; y: number }): this {
    const clamped = this._clampZoom(z);
    if (anchor) {
      const wx = (anchor.x - this._world.x) / this._world.scale.x;
      const wy = (anchor.y - this._world.y) / this._world.scale.x;
      this._world.scale.set(clamped);
      this._world.x = anchor.x - wx * clamped;
      this._world.y = anchor.y - wy * clamped;
    } else {
      this._world.scale.set(clamped);
    }
    this._afterTransform();
    return this;
  }

  setPan(x: number, y: number): this {
    this._world.x = x;
    this._world.y = y;
    this._afterTransform();
    return this;
  }

  /**
   * 현재 viewport(host canvas) 화면 중심에 오는 graph-local(world) 좌표.
   *   pan 은 화면-px 오프셋이라 canvas 크기가 다르면 같은 pan 이어도 중심 좌표가 달라진다.
   *   서로 다른 크기의 뷰어 간 위치 복원은 pan 대신 이 값(+zoom)을 옮겨 centerOnWorld 로 복원.
   */
  get centerWorld(): GraphPoint {
    const view = this._viewportSize();
    const s = this._world.scale.x || 1;
    return {
      x: (view.w / 2 - this._world.x) / s,
      y: (view.h / 2 - this._world.y) / s,
    };
  }

  /** graph-local(world) 좌표를 현재 화면 중심에 오도록 pan(+선택적 zoom) 설정. tween 없음. */
  centerOnWorld(x: number, y: number, zoom?: number): this {
    if (zoom != null) this._world.scale.set(this._clampZoom(zoom));
    const view = this._viewportSize();
    const s = this._world.scale.x || 1;
    this._world.x = view.w / 2 - x * s;
    this._world.y = view.h / 2 - y * s;
    this._afterTransform();
    return this;
  }

  /** zoom=1, pan=(0,0). */
  reset(): this {
    this._cancelTween();
    this._world.scale.set(1);
    this._world.x = 0;
    this._world.y = 0;
    this._afterTransform();
    return this;
  }

  /** 진행 중 tween 즉시 중단. */
  cancel(): this {
    this._cancelTween();
    return this;
  }

  // ── fit / center / panToElement ───────────────────────────

  /** elements (또는 전체) 의 합집합 bbox 에 padding 두고 fit. */
  fit(elements?: PixiGraphElement[], opts?: PanOptions): boolean {
    const els = elements ?? this._graph.elements();
    if (!els.length) return false;
    const bbox = this._unionBbox(els);
    if (!bbox) return false;
    return this._panToBbox(bbox, { padding: opts?.padding ?? 0.1, ...opts });
  }

  /** elements 의 중심으로 pan — zoom 유지. */
  center(elements?: PixiGraphElement[], opts?: PanOptions): boolean {
    const els = elements ?? this._graph.elements();
    if (!els.length) return false;
    const bbox = this._unionBbox(els);
    if (!bbox) return false;
    const view = this._viewportSize();
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    const s = this._world.scale.x;
    return this._animateTo({ x: view.w / 2 - cx * s, y: view.h / 2 - cy * s, scale: s }, opts || {});
  }

  /**
   * id / element / 배열 / {ids:[]} / {path:[]} 으로 pan + 선택.
   *  - 단일 요소 + (zoom/padding 미지정) → ratio 기반 zoom 자동 산정 (요소가 화면의 ratio 비율 차지).
   *  - 여러 요소 → 합집합 bbox fit (padding 기본 0.1, opts 로 override).
   */
  panToElement(
    target: string | PixiGraphElement | (string | PixiGraphElement)[] | { ids?: (string | PixiGraphElement)[]; path?: (string | PixiGraphElement)[] },
    opts?: PanOptions,
  ): boolean {
    const els = this._resolveElements(target);
    if (!els.length) return false;
    const { select = true, ratio = 0.18, ...rest } = opts || {};
    if (select) {
      this._graph.unselectAll?.();
      els.forEach((e) => e.select?.());
    }
    const bbox = this._unionBbox(els);
    if (!bbox) return false;
    const panOpts: PanOptions = { ...rest };
    if (els.length === 1 && rest.zoom == null && rest.padding == null) {
      const view = this._viewportSize();
      const maxDim = Math.max(bbox.w, bbox.h) || 1;
      const minContainer = Math.min(view.w, view.h);
      panOpts.zoom = Math.min(rest.maxZoom ?? 3, Math.max(0.2, (minContainer * ratio) / maxDim));
    } else if (panOpts.padding == null) {
      panOpts.padding = 0.1;
    }
    return this._panToBbox(bbox, panOpts);
  }

  panToElements(
    targets: (string | PixiGraphElement)[],
    opts?: PanOptions,
  ): boolean {
    return this.panToElement(targets, opts);
  }

  /**
   * 임의 graph-local rect 에 fit (예: 이미지 영역). elements 없이 직접 bbox 지정.
   *  - opts.zoom 지정 시 그 줌으로, 미지정 시 padding 으로 fit.
   */
  panToBbox(bbox: GraphBbox, opts?: PanOptions): boolean {
    return this._panToBbox(bbox, opts || {});
  }

  // ── internal ──────────────────────────────────────────────

  private _panToBbox(bbox: GraphBbox, opts: PanOptions): boolean {
    const view = this._viewportSize();
    if (view.w <= 0 || view.h <= 0) return false;
    const pad = opts.padding ?? 0;
    const availW = view.w * (1 - pad * 2);
    const availH = view.h * (1 - pad * 2);
    let s: number;
    if (opts.zoom != null) {
      s = opts.zoom;
    } else {
      s = Math.min(availW / Math.max(bbox.w, 1), availH / Math.max(bbox.h, 1));
    }
    if (opts.maxZoom != null) s = Math.min(s, opts.maxZoom);
    s = this._clampZoom(s);
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    return this._animateTo({ x: view.w / 2 - cx * s, y: view.h / 2 - cy * s, scale: s }, opts);
  }

  private _animateTo(target: { x: number; y: number; scale: number }, opts: PanOptions): boolean {
    this._cancelTween();
    const duration = opts.duration ?? 0;
    if (duration <= 0) {
      this._world.x = target.x;
      this._world.y = target.y;
      this._world.scale.set(target.scale);
      this._afterTransform();
      opts.onUpdate?.();
      opts.onComplete?.();
      return true;
    }
    const start = { x: this._world.x, y: this._world.y, scale: this._world.scale.x };
    const easing = opts.easing ?? ((t: number) => 1 - Math.pow(1 - t, 3));
    const startTime = performance.now();
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      const e = easing(t);
      this._world.x = start.x + (target.x - start.x) * e;
      this._world.y = start.y + (target.y - start.y) * e;
      this._world.scale.set(start.scale + (target.scale - start.scale) * e);
      this._afterTransform();
      opts.onUpdate?.();
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        opts.onComplete?.();
        this._activeTween = null;
      }
    };
    raf = requestAnimationFrame(tick);
    this._activeTween = {
      cancel: () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        this._activeTween = null;
      },
    };
    return true;
  }

  private _cancelTween(): void {
    this._activeTween?.cancel();
  }

  private _afterTransform(): void {
    const s = this._world.scale.x || 1;
    this._graph.setViewScale?.(s);
    if (this._cfg.hitTolerancePx > 0) {
      this._graph.setHitTolerance?.(this._cfg.hitTolerancePx / s);
    }
    if (this._onChange) {
      try { this._onChange(); } catch { /* noop */ }
    }
  }

  private _clampZoom(z: number): number {
    if (!Number.isFinite(z) || z <= 0) return this._cfg.minZoom;
    return Math.max(this._cfg.minZoom, Math.min(this._cfg.maxZoom, z));
  }

  private _viewportSize(): { w: number; h: number } {
    if (!this._hostCanvas) return { w: 0, h: 0 };
    return { w: this._hostCanvas.clientWidth, h: this._hostCanvas.clientHeight };
  }

  private _resolveElements(target: unknown): PixiGraphElement[] {
    if (target == null) return [];
    let arr: unknown[];
    if (Array.isArray(target)) {
      arr = target;
    } else if (typeof target === 'object') {
      const o = target as { ids?: unknown[]; path?: unknown[] };
      if (Array.isArray(o.ids)) arr = o.ids;
      else if (Array.isArray(o.path)) arr = o.path;
      else arr = [target];
    } else {
      arr = [target];
    }
    const out: PixiGraphElement[] = [];
    for (const t of arr) {
      if (typeof t === 'string') {
        const el = this._graph.element(t);
        if (el && typeof (el as PixiGraphElement).bbox === 'function') out.push(el as PixiGraphElement);
      } else if (t && typeof (t as PixiGraphElement).bbox === 'function') {
        out.push(t as PixiGraphElement);
      }
    }
    return out;
  }

  private _unionBbox(els: PixiGraphElement[]): GraphBbox | null {
    let bbox: GraphBbox | null = null;
    for (const e of els) {
      const b = e.bbox?.();
      if (!b || !Number.isFinite(b.w) || !Number.isFinite(b.h)) continue;
      if (!bbox) {
        bbox = { x: b.x, y: b.y, w: b.w, h: b.h };
        continue;
      }
      const x2 = Math.max(bbox.x + bbox.w, b.x + b.w);
      const y2 = Math.max(bbox.y + bbox.h, b.y + b.h);
      bbox.x = Math.min(bbox.x, b.x);
      bbox.y = Math.min(bbox.y, b.y);
      bbox.w = x2 - bbox.x;
      bbox.h = y2 - bbox.y;
    }
    return bbox;
  }

  // ── pointer/wheel ─────────────────────────────────────────

  private _onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this._hostCanvas) return;
    const rect = this._hostCanvas.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // deltaMode 정규화 → px. (Firefox 마우스휠은 LINE 단위라 값이 훨씬 작게 들어온다.)
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;                                          // LINE → px
    else if (e.deltaMode === 2) dy *= this._hostCanvas.clientHeight || 800;   // PAGE → px

    // 트랙패드는 이벤트당 delta 가 작아(≈2~15px) 마우스 휠(한 notch ≈100+)보다 줌이 답답하다.
    // 임계값 미만이면 트랙패드로 보고 boost 를 곱해 체감을 맞춘다(마우스는 임계값 이상이라 영향 없음).
    const sens = Math.abs(dy) < this._cfg.wheelFineThreshold
      ? this._cfg.wheelSensitivity * this._cfg.wheelFineBoost
      : this._cfg.wheelSensitivity;

    const factor = Math.exp(-dy * sens);
    this.setZoom(this._world.scale.x * factor, anchor);
  }

  private _onPointerDown(e: PointerEvent): void {
    const wantBtn = { left: 0, middle: 1, right: 2 }[this._cfg.dragButton];
    if (e.button !== wantBtn) return;
    const mod = this._cfg.dragModifier;
    if (mod === 'shift' && !e.shiftKey) return;
    if (mod === 'ctrl' && !(e.ctrlKey || e.metaKey)) return;
    if (mod === 'alt' && !e.altKey) return;
    this._isDragPanning = true;
    this._dragLast = { x: e.clientX, y: e.clientY };
  }

  private _onPointerMove(e: PointerEvent): void {
    if (!this._isDragPanning || !this._dragLast) return;
    this._world.x += e.clientX - this._dragLast.x;
    this._world.y += e.clientY - this._dragLast.y;
    this._dragLast = { x: e.clientX, y: e.clientY };
    this._afterTransform();
  }

  private _onPointerUp(): void {
    this._isDragPanning = false;
    this._dragLast = null;
  }
}
