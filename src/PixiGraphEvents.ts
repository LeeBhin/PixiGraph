/**
 * PixiGraphEvents — cytoscape 식 이벤트 위임 (delegation) 시스템.
 *
 * 디자인 (D-B): graph 는 DOM 을 모름. 외부 코드가 host 의 pointer 이벤트를 잡아서
 *   graph.feed('tap' | 'cxttap' | 'mousemove', localX, localY, nativeEvent) 호출.
 *   graph 는 hit-test 후 selector 매칭되는 핸들러들을 호출.
 *
 * 이벤트 종류:
 *   - `tap`       — 좌클릭 (외부에서 pointertap/click 시 feed). ele=null 이면 background tap.
 *   - `cxttap`    — 우클릭 (contextmenu). ele=null 이면 background.
 *   - `mouseover` — element 진입. graph 가 mousemove feed 시 자동 발행 (이전 hover 와 다르면).
 *   - `mouseout`  — element 이탈. 마찬가지로 자동.
 *   - 외부에서 'mouseover'/'mouseout' 을 직접 feed 할 일은 없음. mousemove 만 feed.
 *
 * 등록:
 *   - `graph.on(type, handler)` — selector 없음 (모든 element + background).
 *   - `graph.on(type, selector, handler)` — selector 매칭 element 만.
 *     mouseover/mouseout 은 element 한정 — selector 없는 핸들러는 ele 가 항상 non-null.
 *
 * 핸들러 호출 순서: 등록 순서. selector 매칭하는 핸들러만 호출.
 * 핸들러 시그니처: `(payload: PixiGraphEventPayload) => void`.
 */

import { parseSelector, matchesSelector, type ParsedSelector } from './PixiGraphStyle';
import type { PixiGraphElement } from './PixiGraphElement';

// pointer 위임 이벤트(tap/cxttap/mouseover/mouseout) + 상태변경 이벤트(select/unselect)
// + 데이터 이벤트(add/remove/bbox/rotation/polygon/data).
//   상태/데이터 이벤트는 hit-test/좌표가 없고 graph 가 emit() 으로 직접 발행. cytoscape cy.on(...) 컨셉.
export type PixiGraphEventType =
  | 'tap' | 'cxttap' | 'mouseover' | 'mouseout'
  | 'select' | 'unselect'
  | 'add' | 'remove'
  | 'bbox' | 'rotation' | 'polygon' | 'data';

/** 외부 feed 가 같이 사용하는 — 'mousemove' 는 자동 mouseover/mouseout 으로 분기되는 내부 표현. */
export type PixiGraphFeedType = PixiGraphEventType | 'mousemove';

/** 핸들러가 받는 payload. cytoscape `event.target` 과 동일 컨셉. */
export interface PixiGraphEventPayload {
  /** 이벤트 타입. */
  type: PixiGraphEventType;
  /** hit-test 대상 element. background 이벤트면 null. mouseover/mouseout 은 항상 non-null. */
  target: PixiGraphElement | null;
  /** feed 가 받은 graph-local 좌표. */
  x: number;
  y: number;
  /** 원본 DOM 이벤트 (외부에서 preventDefault / stopPropagation 등에 사용). */
  native: Event | null;
}

export type PixiGraphHandler = (payload: PixiGraphEventPayload) => void;

interface HandlerEntry {
  type: PixiGraphEventType;
  /** null 이면 selector 없음 — 모든 hit (background 포함) 대상. */
  selector: ParsedSelector | null;
  fn: PixiGraphHandler;
}

/** PixiGraph 가 element hit-test 를 위해 필요로 하는 최소 인터페이스. */
export interface EventBusGraphHandle {
  elementAt(x: number, y: number): PixiGraphElement | null;
}

export class PixiGraphEventBus {
  private readonly handlers: HandlerEntry[] = [];
  private readonly graph: EventBusGraphHandle;
  /** 마지막 mousemove feed 시점의 hover element — mouseover/mouseout 자동 발행에 사용. */
  private lastHover: PixiGraphElement | null = null;

  constructor(graph: EventBusGraphHandle) { this.graph = graph; }

  /**
   * 이벤트 핸들러 등록.
   *  - `on(type, fn)` — selector 없음.
   *  - `on(type, selector, fn)` — selector 매칭.
   */
  on(type: PixiGraphEventType, selectorOrFn: string | PixiGraphHandler, maybeFn?: PixiGraphHandler): void {
    let selector: ParsedSelector | null = null;
    let fn: PixiGraphHandler;
    if (typeof selectorOrFn === 'function') {
      fn = selectorOrFn;
    } else {
      selector = parseSelector(selectorOrFn);
      if (typeof maybeFn !== 'function') return;
      fn = maybeFn;
    }
    this.handlers.push({ type, selector, fn });
  }

  /**
   * 핸들러 제거.
   *  - `off(type, fn)` — 해당 fn 한 개 제거.
   *  - `off(type)` — 해당 type 의 모든 핸들러 제거.
   *  - `off()` — 전부 제거.
   */
  off(type?: PixiGraphEventType, fn?: PixiGraphHandler): void {
    if (!type) { this.handlers.length = 0; return; }
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      if (h.type !== type) continue;
      if (fn && h.fn !== fn) continue;
      this.handlers.splice(i, 1);
    }
  }

  /**
   * 외부에서 pointer 이벤트를 graph 좌표로 변환해 호출.
   *  - tap / cxttap: hit-test 후 매칭 핸들러 호출 (background 포함 가능).
   *  - mousemove: 이전 hover 와 비교해 mouseout/mouseover 자동 발행.
   */
  feed(type: PixiGraphFeedType, x: number, y: number, native: Event | null = null): void {
    if (type === 'mousemove') {
      const cur = this.graph.elementAt(x, y);
      if (cur !== this.lastHover) {
        if (this.lastHover) this.dispatch('mouseout', this.lastHover, x, y, native);
        if (cur) this.dispatch('mouseover', cur, x, y, native);
        this.lastHover = cur;
      }
      return;
    }
    const target = this.graph.elementAt(x, y);
    this.dispatch(type, target, x, y, native);
  }

  /**
   * 상태변경 이벤트(select/unselect) 직접 발행 — hit-test/좌표 없음.
   * graph 가 element 선택 상태 변경 시 호출. selector 매칭은 dispatch 가 처리.
   */
  emit(type: PixiGraphEventType, target: PixiGraphElement, native: Event | null = null): void {
    this.dispatch(type, target, 0, 0, native);
  }

  /** 외부에서 host pointer 가 떠났을 때 — 강제로 mouseout 발행 + lastHover 클리어. */
  clearHover(native: Event | null = null): void {
    if (!this.lastHover) return;
    this.dispatch('mouseout', this.lastHover, 0, 0, native);
    this.lastHover = null;
  }

  /** 등록된 핸들러 중 selector 매칭하는 것들을 등록 순서로 호출. */
  private dispatch(
    type: PixiGraphEventType,
    target: PixiGraphElement | null,
    x: number, y: number,
    native: Event | null,
  ): void {
    const payload: PixiGraphEventPayload = { type, target, x, y, native };
    for (const h of this.handlers) {
      if (h.type !== type) continue;
      // mouseover/mouseout: target 필수.
      if ((type === 'mouseover' || type === 'mouseout') && !target) continue;
      if (h.selector) {
        if (!target) continue;             // selector 있으면 background hit 은 skip
        if (!matchesSelector(target, h.selector)) continue;
      }
      try { h.fn(payload); } catch { /* swallow — 한 핸들러 에러가 나머지 막지 않게 */ }
    }
  }

  /** 라이브러리 destroy 시 호출. */
  destroy(): void {
    this.handlers.length = 0;
    this.lastHover = null;
  }
}
