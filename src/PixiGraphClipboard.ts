/**
 * PixiGraphClipboard — 그래프 복사/붙여넣기/복제 시스템.
 *
 * 상태(노드/엣지 spec, properties)는 모듈 레벨 static — 같은 페이지의 모든 PixiGraph 인스턴스가 공유 (탭 간 복붙).
 *
 * 동작 단위는 그래프 자체 (PixiGraph 메소드로 delegate) — 외부에서는 graph.copySelection() / graph.paste(model) 등만 호출.
 *
 * Ctrl+드래그 같은 인터랙션 lifecycle 도 라이브러리가 제공:
 *   beginCopyDrag(graph)              — 선택 capture + preview clone 생성(원위치). 성공 시 true.
 *   updateCopyDrag(graph, dx, dy)     — preview 들을 dx,dy 만큼 이동.
 *   commitCopyDrag(graph, dx, dy)     — preview 제거 후 실제 복사본 생성. 새 노드 id[] 반환.
 *   cancelCopyDrag(graph)             — preview 제거(commit 안 함).
 */

import type { PixiGraph } from './PixiGraph';
import type { GraphPoint } from './types';

interface NodeSpec {
  _idx: number;
  _origId: string;
  relX: number; relY: number;
  w: number; h: number;
  shape: 'rect' | 'circle' | 'polygon' | null;
  polygonPoints: number[] | null;
  rotation: number;
  classes: string[];
  data: Record<string, unknown>;
}
interface EdgeSpec {
  srcIdx: number; tgtIdx: number;
  classes: string[];
  data: Record<string, unknown>;
}
interface ClipboardState {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  centroid: GraphPoint | null;
  properties: Record<string, unknown> | null;
}

const _state: ClipboardState = { nodes: [], edges: [], centroid: null, properties: null };

// Ctrl+drag preview 트래킹 (인스턴스 무관 — 한 번에 하나만 진행).
interface CopyDragState {
  graph: PixiGraph;
  nodeIds: string[];
  edgeIds: string[];
  centroidOrig: GraphPoint;
}
let _copyDrag: CopyDragState | null = null;

const newId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const computeCentroid = (nodes: Array<{ bbox(): { x: number; y: number; w: number; h: number } }>): GraphPoint | null => {
  if (nodes.length === 0) return null;
  let x = 0, y = 0;
  nodes.forEach((n) => { const b = n.bbox(); x += b.x + b.w / 2; y += b.y + b.h / 2; });
  return { x: x / nodes.length, y: y / nodes.length };
};

/** 클립보드 보유 여부 — context menu enable/disable 등에 사용. */
export const hasClipboard = (): boolean => _state.nodes.length > 0;
export const hasPropertyClipboard = (): boolean => _state.properties != null;

/** 현재 그래프 선택을 클립보드에 저장. 노드 0 개면 false. */
export const copySelection = (graph: PixiGraph): boolean => {
  if (!graph) return false;
  const selected = graph.selected() || [];
  const nodes = selected.filter((e) => e.isNode());
  if (nodes.length === 0) return false;
  const nodeIds = new Set(nodes.map((n) => n.id()));
  const edges = graph.edges().filter((e) => {
    const s = e.source()?.id(); const t = e.target()?.id();
    return s && t && nodeIds.has(s) && nodeIds.has(t);
  });
  const centroid = computeCentroid(nodes)!;
  _state.nodes = nodes.map((n, idx) => {
    const b = n.bbox();
    return {
      _idx: idx,
      _origId: n.id(),
      relX: (b.x + b.w / 2) - centroid.x,
      relY: (b.y + b.h / 2) - centroid.y,
      w: b.w, h: b.h,
      shape: n.shape?.() ?? null,
      polygonPoints: n.polygonPoints?.() ?? null,
      rotation: n.rotation?.() ?? 0,
      classes: (n.classes?.() || []).filter(
        (c) => c !== 'hovered' && c !== 'preselect' && !c.startsWith('preview'),
      ),
      data: JSON.parse(JSON.stringify(n.data?.() || {})),
    };
  });
  const idToIdx = new Map(nodes.map((n, i) => [n.id(), i]));
  _state.edges = edges.map((e) => ({
    srcIdx: idToIdx.get(e.source()!.id())!,
    tgtIdx: idToIdx.get(e.target()!.id())!,
    classes: (e.classes?.() || []).filter((c) => c !== 'hovered' && !c.startsWith('preview')),
    data: JSON.parse(JSON.stringify(e.data?.() || {})),
  }));
  _state.centroid = centroid;
  return true;
};

/** 선택 첫 노드 properties 만 속성 클립보드에. */
export const copyProperties = (graph: PixiGraph): boolean => {
  if (!graph) return false;
  const selected = graph.selected() || [];
  const node = selected.find((e) => e.isNode());
  if (!node) return false;
  const props = (node.data?.('properties') as Record<string, unknown> | undefined) || {};
  _state.properties = JSON.parse(JSON.stringify(props));
  return true;
};

/** 클립보드 → 그래프 (model 좌표를 클립보드 centroid 에 정렬). 새 노드 id[] 반환. */
export const paste = (graph: PixiGraph, model: GraphPoint): string[] => {
  if (!graph || _state.nodes.length === 0 || !model) return [];
  const idMap = new Map<number, string>();
  const nodeInputs = _state.nodes.map((n) => {
    const id = newId('node');
    idMap.set(n._idx, id);
    const cx = model.x + n.relX, cy = model.y + n.relY;
    return {
      id,
      bbox: { x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h },
      shape: n.shape ?? undefined,
      polygonPoints: n.polygonPoints ?? undefined,
      data: JSON.parse(JSON.stringify(n.data)),
    };
  });
  const edgeInputs = _state.edges.map((e) => ({
    id: newId('edge'),
    source: idMap.get(e.srcIdx)!,
    target: idMap.get(e.tgtIdx)!,
    data: JSON.parse(JSON.stringify(e.data)),
  }));
  graph.history.beginBatch();
  graph.add({ nodes: nodeInputs, edges: edgeInputs });
  _state.nodes.forEach((n) => {
    const el = graph.element(idMap.get(n._idx)!);
    if (!el) return;
    n.classes.forEach((c) => el.addClass(c));
    if (n.rotation) graph.setNodesRotations([{ id: idMap.get(n._idx)!, rotation: n.rotation }]);
  });
  _state.edges.forEach((e, i) => {
    const el = graph.element(edgeInputs[i].id);
    if (!el) return;
    e.classes.forEach((c) => el.addClass(c));
  });
  graph.history.endBatch();
  return nodeInputs.map((n) => n.id);
};

/**
 * 잘라내기 — copySelection + 선택 요소 + 연결 엣지 모두 제거.
 *   클립보드에는 선택만 저장(연결 엣지는 paste 시 묶음 외 연결이라 의미 없음 — 내부 엣지만 복원).
 */
export const cutSelection = (graph: PixiGraph): boolean => {
  if (!graph) return false;
  if (!copySelection(graph)) return false;
  const nodeIds = new Set(_state.nodes.map((n) => n._origId));
  const edgesToRemove = new Set<string>();
  graph.edges().forEach((e) => {
    const s = e.source()?.id(); const t = e.target()?.id();
    if (!s || !t) return;
    if (nodeIds.has(s) || nodeIds.has(t)) edgesToRemove.add(e.id());
  });
  graph.history.beginBatch();
  edgesToRemove.forEach((id) => { try { graph.remove(id); } catch { /* noop */ } });
  nodeIds.forEach((id) => { try { graph.remove(id); } catch { /* noop */ } });
  graph.history.endBatch();
  return true;
};

/** 우하단 근접 offset 으로 즉시 복제 — 클립보드는 건드리지 않음. */
export const duplicate = (graph: PixiGraph): string[] => {
  if (!graph) return [];
  const ok = copySelection(graph);
  if (!ok) return [];
  const c = _state.centroid!;
  let maxR = 0;
  _state.nodes.forEach((n) => {
    maxR = Math.max(maxR, Math.abs(n.relX) + n.w / 2, Math.abs(n.relY) + n.h / 2);
  });
  const off = Math.max(maxR * 0.15, 8);
  return paste(graph, { x: c.x + off, y: c.y + off });
};

/** 속성 클립보드 → 현재 선택 노드들. 적용된 노드 수 반환. */
export const pasteProperties = (graph: PixiGraph): number => {
  if (!graph || _state.properties == null) return 0;
  const selected = (graph.selected() || []).filter((e) => e.isNode());
  if (selected.length === 0) return 0;
  selected.forEach((n) => {
    const cur = (n.data?.('properties') as Record<string, unknown> | undefined) || {};
    n.data?.('properties', { ...cur, ..._state.properties! });
  });
  return selected.length;
};

// ──────────────────────────────────────────────────────────
// Ctrl+드래그 복제 미리보기 lifecycle.
// ──────────────────────────────────────────────────────────

export const isCopyDragActive = (): boolean => _copyDrag != null;

/** 선택을 클립보드에 capture + preview clone (원본 데이터/클래스 그대로) 생성. 진행 중이면 false. */
export const beginCopyDrag = (graph: PixiGraph): boolean => {
  if (_copyDrag) return false;
  if (!copySelection(graph)) return false;
  if (_state.nodes.length === 0 || !_state.centroid) return false;
  graph.history.suspend(); // preview 요소는 기록 안 함.
  const centroid: GraphPoint = { ...(_state.centroid as GraphPoint) };
  const idMap = new Map<number, string>();
  const nodeInputs = _state.nodes.map((n) => {
    const id = newId('preview-copy');
    idMap.set(n._idx, id);
    const cx = centroid.x + n.relX, cy = centroid.y + n.relY;
    return {
      id, bbox: { x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h },
      shape: n.shape ?? undefined, polygonPoints: n.polygonPoints ?? undefined,
      data: JSON.parse(JSON.stringify(n.data)),
    };
  });
  const edgeInputs = _state.edges.map((e) => ({
    id: newId('preview-copy-e'),
    source: idMap.get(e.srcIdx)!,
    target: idMap.get(e.tgtIdx)!,
    data: JSON.parse(JSON.stringify(e.data)),
  }));
  graph.add({ nodes: nodeInputs, edges: edgeInputs });
  _state.nodes.forEach((n, i) => {
    const el = graph.element(nodeInputs[i].id);
    if (!el) return;
    n.classes.forEach((c) => el.addClass(c));
    el.addClass('preview');
  });
  _state.edges.forEach((e, i) => {
    const el = graph.element(edgeInputs[i].id);
    if (!el) return;
    e.classes.forEach((c) => el.addClass(c));
    el.addClass('preview');
  });
  _copyDrag = {
    graph,
    nodeIds: nodeInputs.map((n) => n.id),
    edgeIds: edgeInputs.map((e) => e.id),
    centroidOrig: centroid,
  };
  // suspend 는 cancel/commit 까지 유지 — preview lifecycle 동안 일관.
  return true;
};

/** 진행 중인 preview 들을 (dx, dy) offset 으로 이동. */
export const updateCopyDrag = (graph: PixiGraph, dx: number, dy: number): void => {
  if (!_copyDrag || _copyDrag.graph !== graph) return;
  const c = _copyDrag.centroidOrig;
  const updates = _copyDrag.nodeIds.map((id, i) => {
    const n = _state.nodes[i];
    const cx = c.x + n.relX + dx, cy = c.y + n.relY + dy;
    return { id, bbox: { x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h } };
  });
  graph.setNodesBboxes(updates);
};

/** preview 제거 + 실제 복사본 생성. 새 노드 id[] 반환. */
export const commitCopyDrag = (graph: PixiGraph, dx: number, dy: number): string[] => {
  if (!_copyDrag || _copyDrag.graph !== graph) return [];
  const c = _copyDrag.centroidOrig;
  const target = { x: c.x + dx, y: c.y + dy };
  cancelCopyDrag(graph);
  return paste(graph, target);
};

/** preview 제거 (commit 없음). */
export const cancelCopyDrag = (graph: PixiGraph): void => {
  if (!_copyDrag) return;
  if (_copyDrag.graph !== graph) return;
  _copyDrag.nodeIds.forEach((id) => { try { graph.remove(id); } catch { /* noop */ } });
  _copyDrag.edgeIds.forEach((id) => { try { graph.remove(id); } catch { /* noop */ } });
  _copyDrag = null;
  graph.history.resume();
};
