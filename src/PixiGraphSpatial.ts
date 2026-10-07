/**
 * 균일 격자 공간 인덱스 — hit-test(elementsAt/nodeAt/edgeAt)·영역 질의(elementsIn)가 전 element 를
 * 훑지 않고 질의 영역이 걸친 칸의 후보만 보게 한다.
 *
 * 기하가 바뀐 element 는 PixiGraph 가 모아 두었다가 다음 질의 때 그것만 빼고 다시 넣는다(remove/insert) —
 * 드래그는 매 프레임 노드 하나와 연결 엣지 몇 개만 갱신. 많이 바뀌면(초기 로드 등) 통째로 다시 만든다.
 * 칸 범위(원점·크기)는 만들 때 정해지고, 범위 밖으로 나간 element 는 가장자리 칸에 든다(정확성은 유지).
 * 후보는 등록 순서(seq)로 돌려준다 — 동점 정렬이 종전(elementMap 순회)과 같게.
 */

import type { PixiGraphElement } from './PixiGraphElement';

/** element 하나의 색인 영역(graph-local AABB). */
export interface SpatialItem {
  ele: PixiGraphElement;
  seq: number;
  x1: number; y1: number; x2: number; y2: number;
}

/** 한 축 칸 수 상한 — 칸이 너무 잘면 긴 엣지가 많은 칸에 중복 등록된다. */
const MAX_CELLS_PER_AXIS = 64;

export class SpatialGrid {
  private readonly cells = new Map<number, SpatialItem[]>();
  /** element → 들어 있는 칸 키 — remove 용. */
  private readonly keysOf = new Map<PixiGraphElement, { item: SpatialItem; keys: number[] }>();
  private readonly ox: number;
  private readonly oy: number;
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(items: SpatialItem[]) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
      if (it.x1 < x1) x1 = it.x1;
      if (it.y1 < y1) y1 = it.y1;
      if (it.x2 > x2) x2 = it.x2;
      if (it.y2 > y2) y2 = it.y2;
    }
    if (!Number.isFinite(x1)) { x1 = 0; y1 = 0; x2 = 1; y2 = 1; }
    this.ox = x1;
    this.oy = y1;
    this.cell = Math.max(1, Math.max(x2 - x1, y2 - y1) / MAX_CELLS_PER_AXIS);
    this.cols = Math.max(1, Math.ceil((x2 - x1) / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil((y2 - y1) / this.cell) + 1);
    for (const it of items) this.insert(it);
  }

  /** element 색인 영역 등록(이미 있으면 먼저 remove 할 것). */
  insert(it: SpatialItem): void {
    const keys: number[] = [];
    const c1 = this._col(it.x1), c2 = this._col(it.x2);
    const r1 = this._row(it.y1), r2 = this._row(it.y2);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const k = r * this.cols + c;
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(it);
        keys.push(k);
      }
    }
    this.keysOf.set(it.ele, { item: it, keys });
  }

  /** element 색인에서 제거. 없으면 no-op. */
  remove(ele: PixiGraphElement): void {
    const rec = this.keysOf.get(ele);
    if (!rec) return;
    for (const k of rec.keys) {
      const arr = this.cells.get(k);
      if (!arr) continue;
      const i = arr.indexOf(rec.item);
      if (i >= 0) arr.splice(i, 1);
    }
    this.keysOf.delete(ele);
  }

  /** 등록된 element 수. */
  get size(): number { return this.keysOf.size; }

  private _col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.ox) / this.cell)));
  }

  private _row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.oy) / this.cell)));
  }

  /** 영역(x1,y1)-(x2,y2) 와 AABB 가 겹치는 element — 중복 없이 등록 순서로. */
  query(x1: number, y1: number, x2: number, y2: number): PixiGraphElement[] {
    const c1 = this._col(x1), c2 = this._col(x2);
    const r1 = this._row(y1), r2 = this._row(y2);
    const seen = new Set<SpatialItem>();
    const hits: SpatialItem[] = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const arr = this.cells.get(r * this.cols + c);
        if (!arr) continue;
        for (const it of arr) {
          if (seen.has(it)) continue;
          seen.add(it);
          if (it.x2 < x1 || it.x1 > x2 || it.y2 < y1 || it.y1 > y2) continue;
          hits.push(it);
        }
      }
    }
    hits.sort((a, b) => a.seq - b.seq);
    return hits.map((h) => h.ele);
  }
}
