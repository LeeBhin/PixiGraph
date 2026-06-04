/**
 * PixiGraphPreview — Alt+드래그 인라인 삽입/체인 빼내기 미리보기 상태.
 *
 *  - .preview      : 임시 추가된 graph 요소(두 갈래 / 병합 엣지) — 라이브러리 hit-test 제외.
 *  - .preview-dim  : 분기 후보 원본 엣지(흐리게).
 *  - .preview-removed : 빼내기 시 사라질 체인 엣지(시각상 제거된 것처럼).
 *
 * 시그니처(sig) 기반 재진입 회피 — 같은 대상 반복 호출 시 no-op. 호출부(viewer)는 매 프레임 부담 없이 호출 가능.
 */

import type { PixiGraph } from './PixiGraph';
import type { PixiGraphElement } from './PixiGraphElement';

interface PreviewState {
  sig: string | null;
  // insert: 분기 target 엣지 + 두 갈래 preview 엣지.
  insertDimEdgeId: string | null;
  insertHalfIds: string[];
  // extract: 체인 두 엣지(preview-removed) + 병합 preview 엣지.
  extractRemovedIds: string[];
  extractMergedId: string | null;
}

const newPvState = (): PreviewState => ({
  sig: null, insertDimEdgeId: null, insertHalfIds: [],
  extractRemovedIds: [], extractMergedId: null,
});

const newId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** PixiGraph 가 인스턴스당 하나 보유. */
export class PixiGraphPreview {
  private state: PreviewState = newPvState();
  constructor(private readonly graph: PixiGraph) {}

  /** 현재 미리보기 시그니처 — viewer 가 외부에서 확인하고 싶을 때. */
  signature(): string | null { return this.state.sig; }

  /** 활성 미리보기 있음. */
  isActive(): boolean { return this.state.sig != null; }

  /**
   * 인라인 삽입 미리보기 — target 엣지에 dim 클래스 + src→nodeId, nodeId→tgt 두 갈래 preview 엣지.
   * 같은 (nodeId, edgeId) 면 no-op + false.
   */
  previewInsert(nodeId: string, targetEdge: PixiGraphElement): boolean {
    const sig = `insert:${nodeId}:${targetEdge.id()}`;
    if (this.state.sig === sig) return false;
    this.clear();
    if (!targetEdge.isEdge()) return false;
    const src = targetEdge.source(); const tgt = targetEdge.target();
    if (!src || !tgt) return false;
    const ep = (targetEdge.data('properties') as object | undefined) || {};
    const e1 = newId('preview-h1');
    const e2 = newId('preview-h2');
    this.graph.history.suspend();
    this.graph.add({ edges: [
      { id: e1, source: src.id(), target: nodeId, data: { properties: { ...ep } } },
      { id: e2, source: nodeId, target: tgt.id(), data: { properties: { ...ep } } },
    ] });
    this.graph.history.resume();
    this.graph.element(e1)?.addClass('preview');
    this.graph.element(e2)?.addClass('preview');
    targetEdge.addClass('preview-dim');
    this.state.sig = sig;
    this.state.insertDimEdgeId = targetEdge.id();
    this.state.insertHalfIds = [e1, e2];
    return true;
  }

  /** 인라인 삽입 미리보기 활성 시 dim 된 target 엣지 element 반환. */
  currentInsertTargetEdge(): PixiGraphElement | null {
    return this.state.insertDimEdgeId ? this.graph.element(this.state.insertDimEdgeId) : null;
  }

  /**
   * 체인 빼내기 미리보기 — 두 엣지 preview-removed + 병합 엣지 preview.
   * 같은 체인이면 no-op + false.
   */
  previewMerge(chain: {
    incoming: PixiGraphElement; outgoing: PixiGraphElement;
    src: PixiGraphElement; tgt: PixiGraphElement;
  }): boolean {
    const sig = `extract:${chain.incoming.id()}:${chain.outgoing.id()}`;
    if (this.state.sig === sig) return false;
    this.clear();
    const ep = (chain.incoming.data('properties') as object | undefined)
      ?? (chain.outgoing.data('properties') as object | undefined) ?? {};
    const mergedId = newId('preview-merged');
    this.graph.history.suspend();
    this.graph.add({ edges: [{ id: mergedId, source: chain.src.id(), target: chain.tgt.id(), data: { properties: { ...ep } } }] });
    this.graph.history.resume();
    this.graph.element(mergedId)?.addClass('preview');
    chain.incoming.addClass('preview-removed');
    chain.outgoing.addClass('preview-removed');
    this.state.sig = sig;
    this.state.extractRemovedIds = [chain.incoming.id(), chain.outgoing.id()];
    this.state.extractMergedId = mergedId;
    return true;
  }

  /** 모든 미리보기 정리 (클래스 + 임시 요소). */
  clear(): void {
    if (this.state.insertDimEdgeId) {
      try { this.graph.element(this.state.insertDimEdgeId)?.removeClass('preview-dim'); } catch { /* noop */ }
    }
    // preview 임시 요소 제거 — history 기록 차단(원래 없던 것).
    this.graph.history.suspend();
    this.state.insertHalfIds.forEach((id) => { try { this.graph.remove(id); } catch { /* noop */ } });
    this.state.extractRemovedIds.forEach((id) => {
      try { this.graph.element(id)?.removeClass('preview-removed'); } catch { /* noop */ }
    });
    if (this.state.extractMergedId) { try { this.graph.remove(this.state.extractMergedId); } catch { /* noop */ } }
    this.graph.history.resume();
    this.state = newPvState();
  }
}
