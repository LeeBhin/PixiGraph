/**
 * PixiGraph 기본 타입 정의.
 *
 * 이 모듈은 외부에서 PixiGraph 에 데이터를 넣을 때의 형식과,
 * 그래프 내부에서 element 가 가지는 메타데이터를 정의한다.
 *
 * 좌표 단위 — 모두 graph-local (DELTAFlow 의 도면 image-pixel 좌표).
 * 변환(예: world ↔ local) 은 PixiGraph 외부 호출자가 책임진다.
 */

/** Element 분류. cytoscape `ele.group()` 과 동일 의미. */
export type ElementGroup = 'node' | 'edge';

/** image-local AABB. */
export interface GraphBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** image-local 점. */
export interface GraphPoint {
  x: number;
  y: number;
}

/**
 * 노드 input — `add({ nodes })` 에 넘기는 형식.
 *
 * @property id      문서 내 고유 식별자. edge.source / edge.target 가 이 값을 참조.
 * @property bbox    노드가 차지하는 image-local 영역. 사각형 fill 의 크기/위치가 됨.
 * @property data    선택적 메타데이터 (서버 raw node 객체 그대로 넘겨도 됨).
 *                   `ele.data('key')` 로 조회.
 */
/** 노드 모양. 미지정 시 polygonPoints 있으면 'polygon', 아니면 'rect'. */
export type PixiGraphNodeShape = 'rect' | 'circle' | 'polygon';

export interface PixiGraphNodeInput {
  id: string;
  bbox: GraphBbox;
  data?: Record<string, unknown>;
  /** 노드 모양. 미지정 시 자동 판정. */
  shape?: PixiGraphNodeShape;
  /** 다각형 꼭짓점 — bbox 기준 [0,1] 정규화된 flat 배열 [x0,y0,x1,y1,...]. 호출부에서 도메인 좌표를 변환해 전달. */
  polygonPoints?: number[];
}

/**
 * 엣지 input — `add({ edges })` 에 넘기는 형식.
 *
 * src/tgt 노드가 같은 add() 호출에 포함되어 있거나, 미리 등록되어 있어야 한다.
 * 한쪽이 없으면 그 엣지는 무시.
 *
 * @property id      엣지 식별자.
 * @property source  src 노드 id.
 * @property target  tgt 노드 id.
 * @property data    선택적 메타데이터.
 */
export interface PixiGraphEdgeInput {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}

/** `graph.add()` argument shape. */
export interface PixiGraphAddInput {
  nodes?: PixiGraphNodeInput[];
  edges?: PixiGraphEdgeInput[];
}

/**
 * 기본 시각 스타일. PixiGraph 생성 시 옵션으로 override 가능.
 * 향후 hover/selected 등 상태별 스타일이 추가될 자리.
 */
export interface PixiGraphBaseStyle {
  node: {
    /** hex int. 예: 0x2563eb. */
    fill: number;
    alpha: number;
  };
  edge: {
    stroke: number;
    width: number;
    alpha: number;
  };
}

/** 기본 스타일 값 — DELTAFlow 의 기존 색상과 동일. */
export const DEFAULT_PIXIGRAPH_STYLE: PixiGraphBaseStyle = {
  node: { fill: 0x2563eb, alpha: 0.25 },
  edge: { stroke: 0x16a34a, width: 11.25, alpha: 1 },
};

/** 핸들 한 개의 시각 스타일. */
export interface PixiGraphHandleStyle {
  /** 기준 크기(px, viewScale=1 기준). 기본 10. */
  size?: number;
  /**
   * 크기가 줌을 따라가는 정도 0~1. 기본 0.1.
   *  - 0: 화면상 크기 고정(줌인해도 그대로 → 노드 대비 작아 보임)
   *  - 1: 도면과 함께 확대(줌인하면 그만큼 커짐)
   *  - 중간: 줌인하면 덜 작아짐(vs^zoomFollow 배).
   */
  zoomFollow?: number;
  /** 모양. 기본 'square'. */
  shape?: 'square' | 'circle';
  /** 채움 색. 기본 흰색. */
  fill?: number | string;
  /** 테두리 색. 기본 검정. */
  stroke?: number | string;
  /** 테두리 두께(px, 화면 고정). 0 이면 테두리 없음. 기본 1. */
  strokeWidth?: number;
}

/** 선택 박스(노드 bbox 둘레 outline) 스타일. */
export interface PixiGraphSelectionBoxStyle {
  /** 표시 여부. 기본 false. */
  enabled?: boolean;
  /** 색. 기본 파랑. */
  stroke?: number | string;
  /** 두께(px, 화면 고정). 기본 1. */
  width?: number;
  /** 투명도. 기본 0.9. */
  alpha?: number;
  /** dash 길이(px, 화면 고정). 0/미지정=solid. */
  dash?: number;
  /** dash 간 gap 길이(px, 화면 고정). 미지정=dash 와 동일. */
  gap?: number;
}

/** 선택 핸들(리사이즈) 옵션 — 전부 커스텀 가능. 요소별 ele.selectable()/resizable()/... 로 개별 제어 가능. */
export interface PixiGraphHandleOptions {
  /** 단일 노드 선택 시 리사이즈 핸들 표시. 기본 false. */
  enabled?: boolean;
  /** 전역 선택 활성. false 면 어떤 요소도 선택 안 됨. 기본 true. */
  selectable?: boolean;
  /** 모서리 4개 핸들. 기본 true. */
  corners?: boolean;
  /** 변 가운데 4개 핸들. 기본 false. */
  edges?: boolean;
  /** 핸들 hover 시 resize 커서 표시. 기본 true. */
  resizeCursor?: boolean;
  /** 중심 기준 리사이즈(양쪽 대칭). 기본 false. (Ctrl 로도 일시 적용) */
  centerResize?: boolean;
  /** 비율 유지 리사이즈. 기본 false. (Shift 로도 일시 적용) */
  keepAspect?: boolean;
  /** 다중선택 시 합집합 1박스로 묶어 표시/리사이즈. 기본 false(노드별 개별 핸들). */
  union?: boolean;
  /** 노드 드래그로 이동. 기본 true. (요소별 ele.movable() 도 필요.) */
  move?: boolean;
  /** 미선택 노드를 드래그해도 자동 선택+이동. 기본 true. false 면 선택된 노드만 드래그 이동. */
  selectOnGrab?: boolean;
  /** 회전 활성. 기본 false. */
  rotate?: boolean;
  /** 회전 방식. 'handle'=상단 전용 핸들(기본), 'zone'=피그마(코너 핸들 바깥 ring 호버→회전). */
  rotateMode?: 'zone' | 'handle';
  /** zone 모드: 코너 바깥 회전 ring 두께(px). 기본 16. */
  rotateZone?: number;
  /** handle 모드: 전용 핸들이 상단 변에서 떨어진 화면거리(px). 기본 24. */
  rotateGap?: number;
  /** 핸들 스타일. */
  handle?: PixiGraphHandleStyle;
  /** 선택 박스(outline) 스타일. */
  box?: PixiGraphSelectionBoxStyle;
}

/** Hover 툴팁 옵션 — 켜면 graph.tooltipEntries() 로 element properties 정렬 결과 제공. */
export interface PixiGraphTooltipOptions {
  /** 표시 여부. 기본 false. */
  enabled?: boolean;
  /** 정렬 우선순위 키. 기본 ['category','symbolName','tagNumber','lineNumber']. */
  propertyOrder?: string[];
  /** 매칭되는 키는 숨김. 기본 /(uuid|id)/i. */
  hiddenKeyPattern?: RegExp;
  /** 숨길 키 목록. 기본 ['polygonPoints']. */
  hiddenKeys?: string[];
}

/** PixiGraph 생성 옵션. */
export interface PixiGraphConfig {
  /** 부분 override — 미지정 키는 DEFAULT_PIXIGRAPH_STYLE 사용. */
  style?: Partial<PixiGraphBaseStyle>;
  /** true 또는 옵션 객체면 단일 노드 선택 시 리사이즈 핸들 표시. */
  selectionHandles?: boolean | PixiGraphHandleOptions;
  /** true 또는 옵션 객체면 호버 툴팁 시스템 활성. 렌더링은 별도 컴포넌트(PixiGraphTooltip). */
  tooltip?: boolean | PixiGraphTooltipOptions;
}
