# pixigraph

Pixi.js v8 기반 그래프 렌더링 라이브러리. cytoscape 와 유사한 API (`graph.nodes()`, `graph.edges()`, `graph.add()`, `graph.style()`, `graph.on(...)`) 를 제공하지만, WebGL 렌더링 + 대규모 그래프 (수만 노드) 성능에 초점.

## 특징

- **selector 기반 스타일** — `node`, `edge`, `.class`, `:selected`, `#id` AND 결합. specificity cascade.
- **이벤트 시스템** — `add`/`remove`/`data`/`select`/`unselect`/`tap`/`dragstart`/...
- **하이라이트 그룹** — `graph.highlight({ id, elements, style })` 으로 그룹별 스타일 오버레이, prefix 일괄 해제.
- **히스토리** — undo/redo 자동 추적.
- **클립보드** — 선택 영역 copy/cut/paste.
- **프리뷰 오버레이** — 엣지/폴리곤 드로잉 미리보기.
- **dashed 흐름 애니메이션** — `setDashOffset()` 으로 dash 흐름 효과.

## 설치

```bash
npm install pixigraph pixi.js
```

`pixi.js` 는 peer dependency.

## 사용법

```ts
import { PixiGraph } from 'pixigraph';

const graph = new PixiGraph({ container: document.getElementById('canvas')! });

graph.add([
  { group: 'node', data: { id: 'a' }, position: { x: 0,   y: 0 } },
  { group: 'node', data: { id: 'b' }, position: { x: 200, y: 0 } },
  { group: 'edge', data: { id: 'e1', source: 'a', target: 'b' } },
]);

graph.style([
  { selector: 'node',           style: { fill: 0x2563EB, alpha: 0.8 } },
  { selector: 'node:selected',  style: { fill: 0xF59E0B } },
  { selector: 'edge',           style: { stroke: 0x999999, width: 2, arrowShape: 'triangle' } },
]);

graph.on('tap', ({ target }) => {
  console.log('tapped', target?.id());
});
```

## Public API

`src/index.ts` 참고.

- `PixiGraph` — 메인 인스턴스.
- `PixiGraphElement` — 노드/엣지 wrapper.
- `StyleEngine` / `parseSelector` / `matchesSelector` — 스타일 엔진.
- `PixiGraphEventBus` — 이벤트 버스.
- `HighlightManager` — 하이라이트 그룹 관리.
- `PixiGraphPreview` — 드로잉 미리보기.
- `PixiGraphHistory` — undo/redo.
- `ptSegDist` / `projectOnSeg` — geometry 유틸.

## 빌드

```bash
npm run build      # dist/ ESM+CJS+dts
npm run typecheck
```

소스 직접 import 도 지원 (`main: src/index.ts`) — Vite/webpack/esbuild 같은 번들러 사용 시 빌드 없이도 동작.

## License

MIT
