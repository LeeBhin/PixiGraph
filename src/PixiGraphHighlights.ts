/**
 * PixiGraphHighlights — graph element 그룹 단위 inline style override.
 *
 * 동기: trace 결과 / 검색 매치 / 연결 보기 / SymbolsTab 강조 등 외부 시스템이 동시에 여러 그룹을
 *      활성화. 같은 element 가 여러 그룹에 속할 수 있고, 그룹별 색이 다름.
 *
 * 설계:
 *  - 그룹 = `{ id, elements, style }`. id 로 추가/교체/제거.
 *  - 한 element 가 N 개 그룹에 속하면: 등록 순서 cascade (후순위 그룹 prop 이 동일 prop 을 이김).
 *  - cytoscape 의 `ele.style({...})` 와 동등하되 "그룹 관리" 가 라이브러리 안에 포함.
 *  - HighlightManager 가 element 의 `_highlightGroupIds` 만 mutate, 시각 변화는 graph._restyleElement.
 *
 * PixiGraph.renderElement 가 cascade rules 결과 위에 `manager.styleFor(ele)` 를 머지.
 */

import type { PixiGraphElement } from './PixiGraphElement';
import type { PixiGraphStyleProps } from './PixiGraphStyle';

/** color (hex int | '#rrggbb' | 'rrggbb') → hex int. 부적합 입력 → null. */
const colorToInt = (c: number | string | undefined | null): number | null => {
  if (c == null) return null;
  if (typeof c === 'number') return c;
  const s = c.startsWith('#') ? c.slice(1) : c;
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : null;
};

export interface PixiGraphHighlightInput {
  /** 그룹 식별자 — 같은 id 로 재호출하면 기존 그룹 elements 의 highlight 해제 후 교체. */
  id: string;
  /** 강조할 element 목록. 빈 배열이면 그룹 add skip. */
  elements: PixiGraphElement[];
  /** 매칭 element 에 적용할 inline style. fill/stroke/alpha/width 등. */
  style: PixiGraphStyleProps;
  /**
   * true 면 이 그룹은 auto-dim 트리거에서 제외 — 다른 그룹이 활성일 때처럼 나머지 element 를
   * `.dim` 처리하지 않음. 협업 selection lock 처럼 "표시만 하고 나머지는 그대로" 용도.
   * 기본 false.
   */
  noDim?: boolean;
}

/** PixiGraph 가 manager 에 주입 — element 재렌더 + 전체 element 접근. */
export interface HighlightManagerGraphHandle {
  _restyleElement(ele: PixiGraphElement): void;
  /** 모든 element 반환 — auto-dim 갱신에 사용. */
  elements(): PixiGraphElement[];
}

interface ResolvedHighlight {
  id: string;
  elements: PixiGraphElement[];
  style: PixiGraphStyleProps;
  noDim: boolean;
}

/** PixiGraphElement 의 internal highlight set 접근용 — 외부 노출 X. */
interface HighlightableElement extends PixiGraphElement {
  _highlightGroupIds: Set<string>;
}

export class HighlightManager {
  private readonly graph: HighlightManagerGraphHandle;
  /** 등록 순서 보존 (JS Map 사양). cascade 우선순위에 사용. */
  private readonly highlights = new Map<string, ResolvedHighlight>();

  /**
   * Focus color — set 되면 그 색의 highlight 그룹에 속한 element 만 강조, 나머지는 .focus-dim 적용.
   * Trace lock (trace 색 클릭 후 다른 trace path 흐릿하게 유지) 등에 사용.
   * null 이면 일반 dim 모드 (highlights 활성 시 그룹 외 element 만 .dim).
   */
  private _focusColor: number | null = null;

  constructor(graph: HighlightManagerGraphHandle) { this.graph = graph; }

  /**
   * 그룹 추가 / 교체. 같은 id 로 재호출하면 기존 그룹 해제 후 새로 등록.
   * 빈 elements 면 (기존 그룹은 제거하지만) 새 그룹 add skip.
   */
  add(input: PixiGraphHighlightInput): void {
    if (!input?.id) return;
    if (this.highlights.has(input.id)) this.remove(input.id, { skipDim: true });
    if (input.elements.length === 0) { this._updateDim(); return; }

    const resolved: ResolvedHighlight = {
      id: input.id,
      elements: [...input.elements],
      style: { ...input.style },
      noDim: !!input.noDim,
    };
    this.highlights.set(input.id, resolved);
    resolved.elements.forEach((ele) => {
      (ele as HighlightableElement)._highlightGroupIds.add(input.id);
      this.graph._restyleElement(ele);
    });
    this._updateDim();
  }

  /** id 그룹 제거. element 에서 group id 빼고 재렌더. */
  remove(id: string, opts: { skipDim?: boolean } = {}): void {
    const h = this.highlights.get(id);
    if (!h) return;
    this.highlights.delete(id);
    h.elements.forEach((ele) => {
      (ele as HighlightableElement)._highlightGroupIds.delete(id);
      this.graph._restyleElement(ele);
    });
    if (!opts.skipDim) this._updateDim();
  }

  /** prefix 로 시작하는 모든 그룹 제거 — 예: `removeByPrefix('trace-')`. */
  removeByPrefix(prefix: string): void {
    if (!prefix) return;
    for (const id of [...this.highlights.keys()]) {
      if (id.startsWith(prefix)) this.remove(id, { skipDim: true });
    }
    this._updateDim();
  }

  /** 모든 그룹 해제. */
  clear(): void {
    for (const id of [...this.highlights.keys()]) this.remove(id, { skipDim: true });
    this._updateDim();
  }

  /** dim 트리거용 — noDim 그룹은 제외하고 카운트. PixiGraph 가 add 시 새 element dim 결정에 사용. */
  isAnyActive(): boolean {
    for (const h of this.highlights.values()) { if (!h.noDim) return true; }
    return false;
  }

  /** 등록된 모든 그룹 개수 (noDim 포함). 호환성/디버깅용. */
  totalCount(): number { return this.highlights.size; }

  /**
   * Focus color set/clear — null 이면 focus 모드 해제.
   * Set 되면 그 색의 highlight 그룹에 속한 element 만 강조 유지, 나머지는 `.focus-dim` 자동 부여.
   *
   * 예: trace path 색 lock 시 graph.setFocusColor('#ef4444') → 빨간 trace path 만 살아남고
   *     다른 색 (다른 trace path / search match / symbols 등) 은 모두 흐릿.
   */
  setFocusColor(color: number | string | null): void {
    const next = colorToInt(color);
    if (this._focusColor === next) return;
    this._focusColor = next;
    this._updateDim();
  }

  /** 현재 focus color (hex int) 또는 null. */
  getFocusColor(): number | null { return this._focusColor; }

  /** element 가 focus color 매칭 highlight 그룹에 속하는지. focus null 이면 항상 false. */
  private _matchesFocus(ele: PixiGraphElement): boolean {
    if (this._focusColor == null) return false;
    const groupIds = (ele as HighlightableElement)._highlightGroupIds;
    for (const id of groupIds) {
      const h = this.highlights.get(id);
      if (!h) continue;
      const c = colorToInt(h.style.fill) ?? colorToInt(h.style.stroke);
      if (c != null && c === this._focusColor) return true;
    }
    return false;
  }

  /**
   * 자동 dim 갱신. 두 가지 모드:
   *  - focus 모드 (focusColor !== null):
   *      • focus 색 그룹에 속한 element → 강조 (dim 없음)
   *      • 다른 그룹 / 그룹 없음 → `.focus-dim` (alpha 0.18, 흐릿하지만 보임)
   *  - 일반 모드 (focusColor === null):
   *      • highlight 활성 + 그룹 외 → `.dim` (alpha 0.06, 거의 안 보임)
   *      • 그룹 내 또는 highlight 비활성 → dim 없음
   *
   * `.dim` 과 `.focus-dim` 둘 다 PixiGraph 의 _systemStyleRules 가 시각 정의 — 외부 코드 추가 안 해도 동작.
   */
  _updateDim(): void {
    // noDim 그룹은 dim 트리거에서 제외.
    const anyActive = this.isAnyActive();
    const focus = this._focusColor;
    this.graph.elements().forEach((ele) => {
      const inGroup = (ele as HighlightableElement)._highlightGroupIds.size > 0;
      let dimClass: 'dim' | 'focus-dim' | null = null;
      if (focus != null) {
        dimClass = this._matchesFocus(ele) ? null : 'focus-dim';
      } else if (anyActive && !inGroup) {
        dimClass = 'dim';
      }
      // 적용 — 다른 dim 클래스는 제거.
      if (dimClass === 'dim') {
        if (!ele.hasClass('dim')) ele.addClass('dim');
        if (ele.hasClass('focus-dim')) ele.removeClass('focus-dim');
      } else if (dimClass === 'focus-dim') {
        if (!ele.hasClass('focus-dim')) ele.addClass('focus-dim');
        if (ele.hasClass('dim')) ele.removeClass('dim');
      } else {
        if (ele.hasClass('dim')) ele.removeClass('dim');
        if (ele.hasClass('focus-dim')) ele.removeClass('focus-dim');
      }
    });
  }

  /** 그룹 존재 여부. */
  has(id: string): boolean { return this.highlights.has(id); }

  /** 등록된 모든 그룹 id (등록 순서). */
  ids(): string[] { return [...this.highlights.keys()]; }

  /**
   * element 에 적용할 머지된 highlight style. 활성 그룹 없으면 null.
   * 등록 순서로 cascade — 후순위 그룹 prop 이 동일 prop 을 이김 (CSS-like).
   */
  styleFor(ele: PixiGraphElement): PixiGraphStyleProps | null {
    const groupIds = (ele as HighlightableElement)._highlightGroupIds;
    if (groupIds.size === 0) return null;
    let merged: PixiGraphStyleProps | null = null;
    this.highlights.forEach((h) => {
      if (!groupIds.has(h.id)) return;
      if (!merged) merged = {};
      Object.assign(merged, h.style);
    });
    return merged;
  }

  /**
   * element 가 graph 에서 제거될 때 호출 — 모든 그룹에서 해당 element 제거 + element 의 group set 클리어.
   * 그룹 자체는 유지 (다른 element 가 남아있을 수 있음). dim 갱신은 호출자(PixiGraph) 가 시점 결정.
   */
  _onElementRemoved(ele: PixiGraphElement): void {
    const groupIds = (ele as HighlightableElement)._highlightGroupIds;
    if (groupIds.size === 0) return;
    for (const groupId of [...groupIds]) {
      const h = this.highlights.get(groupId);
      if (!h) continue;
      h.elements = h.elements.filter((e) => e !== ele);
    }
    groupIds.clear();
  }
}
