/**
 * PixiGraphHistory — undo/redo 매니저.
 *
 * 자동 기록: graph.add / graph.remove / graph.setNodeBbox(es) / graph.setNodesRotations / element.data(key, value).
 *   (단, history.isRestoring 또는 isSuspended 면 기록 안 됨 — 초기 buildGraph, undo/redo 자체 무한루프 방지)
 *
 * 명시적 기록: viewer 인터랙션(드래그 release 등)에서 `recordBboxChanges` / `recordRotationChanges` 호출.
 *   드래그 중간 프레임마다 setNodesBboxes 가 불리는데 매번 기록되면 곤란하므로,
 *   드래그는 history.suspend() 로 자동 기록 끔 → release 시 한 번 명시 기록 권장.
 *
 * 배치: `beginBatch()` ~ `endBatch()` 사이의 모든 push 는 batch action 하나로 묶임 → 한 번의 undo 로 일괄 복원.
 *   라이브러리 compound 메소드(insertNodeIntoEdge, mergeChain, splitEdgeAt, paste 등)가 내부적으로 사용.
 *
 * 메모리: 기본 100 step (oldest drop).
 */

import type { PixiGraph } from './PixiGraph';
import type { PixiGraphElement } from './PixiGraphElement';
import type { GraphBbox } from './types';

interface NodeSnapshot {
  kind: 'node';
  id: string;
  bbox: GraphBbox;
  shape: 'rect' | 'circle' | 'polygon' | null;
  polygonPoints: number[] | null;
  rotation: number;
  classes: string[];
  data: Record<string, unknown>;
}
interface EdgeSnapshot {
  kind: 'edge';
  id: string;
  source: string;
  target: string;
  classes: string[];
  data: Record<string, unknown>;
}
type ElementSnapshot = NodeSnapshot | EdgeSnapshot;

interface BboxChange { id: string; before: GraphBbox; after: GraphBbox }
interface RotationChange { id: string; before: number; after: number }
interface DataChange { id: string; key: string; before: unknown; after: unknown }
interface PolygonChange { id: string; before: { bbox: GraphBbox; points: number[] }; after: { bbox: GraphBbox; points: number[] } }

type Action =
  | { type: 'addRemove'; added: ElementSnapshot[]; removed: ElementSnapshot[] }
  | { type: 'bbox'; changes: BboxChange[] }
  | { type: 'rotation'; changes: RotationChange[] }
  | { type: 'data'; changes: DataChange[] }
  | { type: 'polygon'; changes: PolygonChange[] }
  | { type: 'batch'; actions: Action[] };
// 배치 중 deferred — 실제 snapshot 은 endBatch 시점에 수행(요소의 최종 class/회전 등 반영).
type PendingAction =
  | Action
  | { type: '_deferredAdd'; elements: PixiGraphElement[] };

const snapshot = (el: PixiGraphElement): ElementSnapshot => {
  if (el.isNode()) {
    const b = el.bbox();
    const pp = el.polygonPoints?.() ?? null;
    return {
      kind: 'node',
      id: el.id(),
      bbox: { x: b.x, y: b.y, w: b.w, h: b.h },
      shape: el.shape?.() ?? null,
      polygonPoints: pp ? [...pp] : null,
      rotation: el.rotation?.() ?? 0,
      classes: el.classes ? [...el.classes()] : [],
      data: JSON.parse(JSON.stringify(el.data() || {})),
    };
  }
  const s = el.source(); const t = el.target();
  return {
    kind: 'edge',
    id: el.id(),
    source: s ? s.id() : '',
    target: t ? t.id() : '',
    classes: el.classes ? [...el.classes()] : [],
    data: JSON.parse(JSON.stringify(el.data() || {})),
  };
};

const restoreElements = (graph: PixiGraph, snaps: ElementSnapshot[]): void => {
  if (snaps.length === 0) return;
  const nodes = snaps.filter((s): s is NodeSnapshot => s.kind === 'node');
  const edges = snaps.filter((s): s is EdgeSnapshot => s.kind === 'edge');
  graph.add({
    nodes: nodes.map((n) => ({
      id: n.id,
      bbox: { ...n.bbox },
      shape: n.shape ?? undefined,
      polygonPoints: n.polygonPoints ?? undefined,
      data: JSON.parse(JSON.stringify(n.data)),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: JSON.parse(JSON.stringify(e.data)),
    })),
  });
  snaps.forEach((s) => {
    const el = graph.element(s.id);
    if (!el) return;
    s.classes.forEach((c) => el.addClass(c));
    if (s.kind === 'node' && s.rotation) {
      // 라이브러리 setter (chainable, public).
      graph.setNodesRotations([{ id: s.id, rotation: s.rotation }]);
    }
  });
};

export class PixiGraphHistory {
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  private batchStack: PendingAction[][] = [];
  private _restoring = false;
  // 카운터 — 중첩 suspend/resume 안전(viewer drag + Preview 내부 suspend 동시 가능).
  private _suspendDepth = 0;
  private listeners = new Set<() => void>();
  private maxSize = 100;

  constructor(private readonly graph: PixiGraph) {}

  // ── 게이트 ──
  /** undo/redo 진행 중 — 자동 기록 차단. 내부 사용. */
  isRestoring(): boolean { return this._restoring; }
  /** suspend 상태 — viewer 가 초기 로드/드래그 중 자동 기록 차단. */
  isSuspended(): boolean { return this._suspendDepth > 0; }
  /** 자동 기록 일시 정지 / 재개 — 카운터, 중첩 안전. */
  suspend(): void { this._suspendDepth++; }
  resume(): void { if (this._suspendDepth > 0) this._suspendDepth--; }
  /** 기록 가능 여부 — graph 가 mutator 안에서 체크. */
  shouldRecord(): boolean { return !this._restoring && this._suspendDepth === 0; }

  // ── 배치 ──
  beginBatch(): void { this.batchStack.push([]); }
  endBatch(): void {
    const acts = this.batchStack.pop();
    if (!acts || acts.length === 0) return;
    // deferred add 를 endBatch 시점에 snapshot — 그동안 추가된 class/rotation/data 반영.
    const finalized: Action[] = acts.map((a) => {
      if (a.type === '_deferredAdd') {
        const snaps = a.elements
          .filter((el) => this.graph.element(el.id()))
          .map(snapshot);
        return { type: 'addRemove' as const, added: snaps, removed: [] };
      }
      return a;
    }).filter((a) => {
      if (a.type === 'addRemove') return a.added.length > 0 || a.removed.length > 0;
      if (a.type === 'bbox') return a.changes.length > 0;
      if (a.type === 'rotation') return a.changes.length > 0;
      if (a.type === 'data') return a.changes.length > 0;
      return true;
    });
    if (finalized.length === 0) return;
    if (finalized.length === 1) this.push(finalized[0]);
    else this.push({ type: 'batch', actions: finalized });
  }

  // ── 명시적 기록 ──
  /** 일반 push — 자동 기록(graph mutator) 도 이걸 호출. 외부 record* 메소드 권장. */
  push(action: Action): void {
    if (!this.shouldRecord()) return;
    if (this.batchStack.length > 0) {
      this.batchStack[this.batchStack.length - 1].push(action);
      return;
    }
    this.undoStack.push(action);
    this.redoStack = [];
    while (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this._emit();
  }

  recordAdd(elements: PixiGraphElement[]): void {
    if (!this.shouldRecord() || elements.length === 0) return;
    // 배치 중이면 deferred — endBatch 시점에 최종 class/rotation 반영해 snapshot.
    if (this.batchStack.length > 0) {
      this.batchStack[this.batchStack.length - 1].push({ type: '_deferredAdd', elements: [...elements] });
      return;
    }
    this.push({ type: 'addRemove', added: elements.map(snapshot), removed: [] });
  }
  recordRemove(elements: PixiGraphElement[]): void {
    if (!this.shouldRecord() || elements.length === 0) return;
    this.push({ type: 'addRemove', added: [], removed: elements.map(snapshot) });
  }
  recordBboxChanges(changes: BboxChange[]): void {
    if (!this.shouldRecord()) return;
    // no-op(이동 거리 0) 제거.
    const filtered = changes.filter((c) =>
      c.before.x !== c.after.x || c.before.y !== c.after.y ||
      c.before.w !== c.after.w || c.before.h !== c.after.h);
    if (filtered.length === 0) return;
    this.push({ type: 'bbox', changes: filtered.map((c) => ({ id: c.id, before: { ...c.before }, after: { ...c.after } })) });
  }
  recordRotationChanges(changes: RotationChange[]): void {
    if (!this.shouldRecord()) return;
    const filtered = changes.filter((c) => c.before !== c.after);
    if (filtered.length === 0) return;
    this.push({ type: 'rotation', changes: filtered.map((c) => ({ ...c })) });
  }
  recordPolygonChange(changes: PolygonChange[]): void {
    if (!this.shouldRecord() || changes.length === 0) return;
    this.push({ type: 'polygon', changes: changes.map((c) => ({
      id: c.id,
      before: { bbox: { ...c.before.bbox }, points: [...c.before.points] },
      after: { bbox: { ...c.after.bbox }, points: [...c.after.points] },
    })) });
  }
  recordDataChange(id: string, key: string, before: unknown, after: unknown): void {
    if (!this.shouldRecord()) return;
    // 동일 값이면 기록 안 함 (얕은 ref 또는 JSON 비교).
    if (before === after) return;
    try {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
    } catch { /* noop */ }
    this.push({ type: 'data', changes: [{ id, key, before, after }] });
  }

  // ── undo/redo ──
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): boolean {
    if (this.undoStack.length === 0) return false;
    const action = this.undoStack.pop()!;
    this._restoring = true;
    try { this._applyInverse(action); } finally { this._restoring = false; }
    this.redoStack.push(action);
    this._emit();
    return true;
  }
  redo(): boolean {
    if (this.redoStack.length === 0) return false;
    const action = this.redoStack.pop()!;
    this._restoring = true;
    try { this._applyForward(action); } finally { this._restoring = false; }
    this.undoStack.push(action);
    this._emit();
    return true;
  }

  clear(): void { this.undoStack = []; this.redoStack = []; this._emit(); }

  // ── 구독 ──
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private _emit(): void { this.listeners.forEach((f) => { try { f(); } catch { /* noop */ } }); }

  // ── apply ──
  private _applyForward(a: Action): void {
    if (a.type === 'addRemove') {
      a.removed.forEach((s) => { try { this.graph.remove(s.id); } catch { /* noop */ } });
      restoreElements(this.graph, a.added);
    } else if (a.type === 'bbox') {
      this.graph.setNodesBboxes(a.changes.map((c) => ({ id: c.id, bbox: { ...c.after } })));
    } else if (a.type === 'rotation') {
      this.graph.setNodesRotations(a.changes.map((c) => ({ id: c.id, rotation: c.after })));
    } else if (a.type === 'data') {
      a.changes.forEach((c) => { const el = this.graph.element(c.id); if (el) el.data(c.key, c.after); });
    } else if (a.type === 'polygon') {
      a.changes.forEach((c) => this.graph.setNodePolygon(c.id, c.after.bbox, c.after.points));
    } else if (a.type === 'batch') {
      a.actions.forEach((x) => this._applyForward(x));
    }
  }
  private _applyInverse(a: Action): void {
    if (a.type === 'addRemove') {
      a.added.forEach((s) => { try { this.graph.remove(s.id); } catch { /* noop */ } });
      restoreElements(this.graph, a.removed);
    } else if (a.type === 'bbox') {
      this.graph.setNodesBboxes(a.changes.map((c) => ({ id: c.id, bbox: { ...c.before } })));
    } else if (a.type === 'rotation') {
      this.graph.setNodesRotations(a.changes.map((c) => ({ id: c.id, rotation: c.before })));
    } else if (a.type === 'data') {
      a.changes.forEach((c) => { const el = this.graph.element(c.id); if (el) el.data(c.key, c.before); });
    } else if (a.type === 'polygon') {
      a.changes.forEach((c) => this.graph.setNodePolygon(c.id, c.before.bbox, c.before.points));
    } else if (a.type === 'batch') {
      for (let i = a.actions.length - 1; i >= 0; i--) this._applyInverse(a.actions[i]);
    }
  }
}
