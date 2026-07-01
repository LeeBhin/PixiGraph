/**
 * PixiGraphStyle — declarative selector-based style rules.
 *
 * cytoscape `cy.style([{ selector, style }])` 의 부분집합.
 *  - selector 토큰: `node`, `edge`, `.cls`, `:selected`, `#id`. AND 결합만 (공백 없음).
 *  - 예: `node`, `edge`, `node.foo`, `node:selected`, `node.foo:selected`, `#my-id`
 *  - specificity = id*100 + (class+pseudo)*10 + (group ? 1 : 0).
 *  - 같은 specificity 면 선언 순서 늦은 게 우선 (CSS-like).
 *
 * 스타일 적용:
 *  - effective style = defaults → matching rules (specificity asc, decl order asc) cascade.
 *  - 매칭 안 되는 element 는 defaults 만.
 *
 * 미지원 (cytoscape 에 있지만 이 단계에선 X):
 *  - 자손 선택자 (`node node`)
 *  - 속성 selector (`[data-x]`, `[?flag]`)
 *  - 함수 valued style (`data(x)`)
 *  - `:hover` pseudo (D 단계의 이벤트로 hovered 클래스 add 하는 방식 권장)
 */

import type { PixiGraphElement } from './PixiGraphElement';

/**
 * 한 element 에 적용되는 시각 속성.
 *  - 노드: fill / alpha 사용
 *  - 엣지: stroke / width / alpha 사용
 *  - 향후 visible / opacity / cursor 등 추가 가능
 */
export interface PixiGraphStyleProps {
  /** 노드 fill 색. hex int 또는 '#rrggbb'. */
  fill?: number | string;
  /** 노드 fill alpha 또는 엣지 stroke alpha. */
  alpha?: number;
  /** 엣지 stroke 색. */
  stroke?: number | string;
  /** 엣지 stroke 두께 (image-local 단위). */
  width?: number;
  /** 엣지 타겟 화살표 모양. 'triangle' | 'none' (기본 'none'). */
  arrowShape?: 'triangle' | 'none';
  /** 화살표 크기 (image-local 단위). 기본 edge width * 3. */
  arrowSize?: number;
  /** 엣지 line cap — 'butt'(기본) | 'round'. 'round' 면 양 끝 둥글게(끝점 안쪽으로 width/2 끌어들여 시각 길이 유지). */
  lineCap?: 'butt' | 'round';
  /** 엣지 시작(source)쪽 cap. 미지정 시 lineCap 사용. start/end 를 각각 지정하면 한쪽만 둥글게 가능. */
  startCap?: 'butt' | 'round';
  /** 엣지 끝(target)쪽 cap. 미지정 시 lineCap 사용. (화살표가 있으면 화살표 밑변이라 무시됨) */
  endCap?: 'butt' | 'round';
  /** 엣지 dash 길이(image-local 단위). 0 = 실선(기본). */
  lineDash?: number;
  /** 엣지 gap 길이. 미지정 시 lineDash 와 동일. */
  lineGap?: number;
  /** dash 시작 offset (px). 음수면 sc→tc 방향으로 흐르는 듯한 애니메이션. graph 전역 offset 으로도 설정 가능. */
  lineDashOffset?: number;
}

/** 외부 사용자가 graph.style() 에 넘기는 규칙. */
export interface PixiGraphStyleRule {
  selector: string;
  style: PixiGraphStyleProps;
}

/** 파싱된 selector — events 모듈에서도 같은 매칭 규칙으로 재사용. */
export interface ParsedSelector {
  group: 'node' | 'edge' | null;
  id: string | null;
  classes: string[];
  pseudo: string[];
  specificity: number;
  raw: string;
}

interface ParsedStyleRule {
  parsed: ParsedSelector;
  style: PixiGraphStyleProps;
  /** 동일 specificity 시 stable tie-break — 후순위 규칙이 우선. */
  declOrder: number;
}

/** selector 토큰: `#id`, `.cls`, `:pseudo`, 또는 plain group (`node`/`edge`). */
const SELECTOR_TOKEN_RE = /#[\w-]+|\.[\w-]+|:[\w-]+|[a-z][a-z0-9]*/g;

export const parseSelector = (s: string): ParsedSelector => {
  const out: ParsedSelector = {
    group: null, id: null, classes: [], pseudo: [], specificity: 0, raw: s.trim(),
  };
  const tokens = s.match(SELECTOR_TOKEN_RE) ?? [];
  for (const t of tokens) {
    if (t.startsWith('#')) out.id = t.slice(1);
    else if (t.startsWith('.')) out.classes.push(t.slice(1));
    else if (t.startsWith(':')) out.pseudo.push(t.slice(1));
    else if (t === 'node' || t === 'edge') out.group = t;
    // 기타 token (지원 안 함) — 무시.
  }
  out.specificity =
    (out.id ? 100 : 0)
    + (out.classes.length + out.pseudo.length) * 10
    + (out.group ? 1 : 0);
  return out;
};

export const matchesSelector = (ele: PixiGraphElement, sel: ParsedSelector): boolean => {
  if (sel.group && ele.group() !== sel.group) return false;
  if (sel.id && ele.id() !== sel.id) return false;
  for (const c of sel.classes) if (!ele.hasClass(c)) return false;
  for (const p of sel.pseudo) {
    if (p === 'selected') { if (!ele.selected()) return false; continue; }
    // 미지원 pseudo — 매칭 실패 처리 (안전한 기본).
    return false;
  }
  return true;
};

/**
 * 선언된 규칙들을 보관하고 element 의 effective style 을 계산하는 엔진.
 * graph.style(rules) 호출 시 setRules() 로 갱신, 모든 element 재렌더는 호출자(PixiGraph) 책임.
 */
export class StyleEngine {
  private rules: ParsedStyleRule[] = [];

  /** 전체 규칙 교체 (cytoscape `cy.style()` 동작 — replace, not merge). */
  setRules(rules: PixiGraphStyleRule[]): void {
    this.rules = rules.map((r, i) => ({
      parsed: parseSelector(r.selector),
      style: r.style,
      declOrder: i,
    }));
  }

  /**
   * element 에 매칭되는 모든 규칙을 specificity 오름차순 + 선언순서 오름차순으로 정렬해
   * defaults 위에 cascade.
   */
  computeStyle(ele: PixiGraphElement, defaults: PixiGraphStyleProps): PixiGraphStyleProps {
    const matched = this.rules.filter((r) => matchesSelector(ele, r.parsed));
    matched.sort((a, b) =>
      (a.parsed.specificity - b.parsed.specificity)
      || (a.declOrder - b.declOrder),
    );
    const out: PixiGraphStyleProps = { ...defaults };
    for (const r of matched) Object.assign(out, r.style);
    return out;
  }
}
