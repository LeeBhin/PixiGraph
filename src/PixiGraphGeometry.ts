/**
 * PixiGraphGeometry — 그래프 좌표 유틸.
 *
 * 라이브러리 내부 + 외부(viewer 등) 공용. 의존 없음 — 순수 함수만.
 */

import type { GraphPoint } from './types';

/** 점 p 와 선분 a→b 사이 최단거리. */
export const ptSegDist = (p: GraphPoint, a: GraphPoint, b: GraphPoint): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** 점 p 를 선분 a→b 에 투영. 노드 내부 침범 방지 위해 t 를 [0.05, 0.95] 로 클램프. */
export const projectOnSeg = (p: GraphPoint, a: GraphPoint, b: GraphPoint): GraphPoint => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0.5 : Math.max(0.05, Math.min(0.95, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { x: a.x + t * dx, y: a.y + t * dy };
};
