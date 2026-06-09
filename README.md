# pixigraph

A [Pixi.js](https://pixijs.com) **v8** graph rendering engine with a [Cytoscape.js](https://js.cytoscape.org)-like API (`graph.nodes()`, `graph.add()`, `graph.style()`, `graph.on()`), built for **WebGL performance on large graphs** — tens of thousands of nodes and edges.

Unlike Cytoscape, pixigraph is a pure **scene-graph library**: it renders into a Pixi `Container` you mount yourself and knows nothing about the DOM. You forward pointer events into it; it stays renderer-agnostic, embeddable, and fast.

- **Declarative selector styling** — `node`, `edge`, `.class`, `:selected`, `#id` with AND-combination and CSS-like specificity cascade
- **Rich node shapes** — rectangles, circles, arbitrary polygons, and image/SVG-textured nodes (with automatic shape masking and a per-graph texture cache)
- **Smart edges** — surface clipping to node geometry, parallel-edge curvature, target arrowheads, round caps, and animated dashed flow
- **Event delegation** — Cytoscape-style `graph.on(type, selector, handler)` driven by `feed()`, with automatic `mouseover`/`mouseout` from a single `mousemove`
- **Selection & transform handles** — resize (corner/edge handles), rotate (dedicated handle *or* Figma-style corner ring), move, multi-select union boxes, aspect-lock, and center-resize — all per-element overridable
- **Built-in viewport** — pan/zoom camera with wheel & drag handlers, animated `fit` / `center` / `panToElement`, and screen-stable handle/hit sizing
- **Highlight groups** — overlay multiple named style groups on the same elements, prefix-batch removal, auto-dim of non-highlighted elements, and focus-color locking
- **Undo / redo** — automatic history tracking for add/remove/move/resize/rotate/data edits, with batching for compound operations
- **Clipboard** — copy / cut / paste / duplicate of selections, plus property-only copy/paste
- **Graph editing primitives** — connect nodes, inline-insert a node into an edge, split an edge with a new node, merge an edge–node–edge chain, with live preview overlays
- **Hover tooltips** — opt-in, property-ordered entry extraction for your own tooltip component
- **Zero runtime dependencies** — only `pixi.js` as a peer dependency. Ships ESM + CJS + type declarations.

## Installation

```bash
npm install @leebhin/pixigraph pixi.js
```

`pixi.js` (`^8.0.0`) is a **peer dependency** — install it alongside.

## Quick Start

pixigraph renders into a Pixi `Container` (`graph.view`). You mount that container in your own Pixi `Application`, then forward pointer events into the graph using `feed()`.

```ts
import { Application, Point } from 'pixi.js';
import { PixiGraph } from '@leebhin/pixigraph';

// 1. A Pixi application is the host renderer.
const app = new Application();
await app.init({ background: '#ffffff', resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

// 2. Create the graph. It is a pure scene graph — no DOM container here.
const graph = new PixiGraph({
  selectionHandles: true,                 // single-node resize handles on select
  viewport: { wheel: true, drag: true },  // built-in pan/zoom camera
});
app.stage.addChild(graph.view);

// The viewport needs the host canvas to attach wheel/drag listeners.
graph.viewport?.attach(app.canvas);

// 3. Add nodes and edges. Coordinates are "graph-local" (your own world space).
graph.add({
  nodes: [
    { id: 'a', bbox: { x: 0,   y: 0, w: 80, h: 40 } },
    { id: 'b', bbox: { x: 260, y: 0, w: 80, h: 40 } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b' },
  ],
});

// 4. Style declaratively with selectors.
graph.style([
  { selector: 'node',          style: { fill: 0x2563eb, alpha: 0.85 } },
  { selector: 'node:selected', style: { fill: 0xf59e0b } },
  { selector: 'edge',          style: { stroke: 0x94a3b8, width: 2, arrowShape: 'triangle' } },
]);

// 5. Forward DOM pointer events into the graph (event delegation).
const world = () => graph.viewport?.world ?? graph.view; // graph-local space
function toLocal(e: PointerEvent) {
  const r = app.canvas.getBoundingClientRect();
  return world().toLocal(new Point(e.clientX - r.left, e.clientY - r.top));
}

app.canvas.addEventListener('pointertap', (e) => {
  const { x, y } = toLocal(e);
  graph.feed('tap', x, y, e);
});
app.canvas.addEventListener('pointermove', (e) => {
  const { x, y } = toLocal(e);
  graph.feed('mousemove', x, y, e); // auto-derives mouseover / mouseout
});

// 6. Subscribe with Cytoscape-style selectors.
graph.on('tap', 'node', ({ target }) => console.log('node tapped:', target?.id()));
graph.on('mouseover', 'node', ({ target }) => target?.addClass('hovered'));
graph.on('mouseout',  'node', ({ target }) => target?.removeClass('hovered'));
```

## Core Concepts

A few ideas explain the whole API:

- **`graph.view` is a Pixi `Container`.** You add it to your stage (or to your own world container). The graph never touches the DOM, so it embeds anywhere Pixi runs.
- **Coordinates are graph-local.** Every position, `bbox`, and hit-test uses *your* world space (for example, image-pixel coordinates of a diagram). Converting screen pixels ⇄ graph-local is the caller's job — typically `container.toLocal(...)`. When the built-in viewport is active, that space is `graph.viewport.world`.
- **Events are delegated, not listened.** The graph doesn't register DOM listeners. You call `graph.feed('tap' | 'cxttap' | 'mousemove', x, y, nativeEvent)`; the graph hit-tests and dispatches to handlers whose selector matches. A single `mousemove` feed automatically produces `mouseover` / `mouseout`.
- **State changes are data; rendering follows.** `ele.addClass()`, `ele.select()`, `ele.data(k, v)` mutate the element and trigger a targeted re-render through the active style rules. You declare *what* things look like with `graph.style()`; the graph decides *when* to repaint.

## Adding Elements

`graph.add(input)` takes `{ nodes?, edges? }`. Nodes are always processed before edges so edges can resolve their endpoints. Duplicate ids are ignored; an edge whose `source` or `target` node is absent is skipped.

```ts
graph.add({
  nodes: [
    // Rectangle (default shape).
    { id: 'n1', bbox: { x: 0, y: 0, w: 100, h: 60 }, data: { label: 'Pump' } },

    // Circle.
    { id: 'n2', bbox: { x: 200, y: 0, w: 60, h: 60 }, shape: 'circle' },

    // Polygon — vertices are normalized [0,1] within the bbox, flat [x0,y0,x1,y1,...].
    { id: 'n3', bbox: { x: 320, y: 0, w: 80, h: 80 },
      polygonPoints: [0.5, 0, 1, 1, 0, 1] },

    // Image / SVG node — stretched to fit the bbox, masked to the shape.
    { id: 'n4', bbox: { x: 440, y: 0, w: 64, h: 64 },
      image: '/icons/valve.svg' },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', data: { kind: 'flow' } },
  ],
});
```

**Node input fields**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique id. Referenced by `edge.source` / `edge.target`. |
| `bbox` | `{ x, y, w, h }` | Graph-local axis-aligned box the node occupies. |
| `data` | `Record<string, unknown>` | Optional metadata, read back via `ele.data('key')`. |
| `shape` | `'rect' \| 'circle' \| 'polygon'` | Optional. Inferred from `polygonPoints` when omitted (else `rect`). |
| `polygonPoints` | `number[]` | Normalized `[0,1]` flat vertices relative to the bbox. |
| `image` | `string` | Image / SVG / data-URL / blob-URL used as the node texture. Same URL is fetched & decoded once per graph and cached; a fallback fill shows until it loads. |

**Edge input fields**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique id. |
| `source` | `string` | Source node id. |
| `target` | `string` | Target node id. |
| `data` | `Record<string, unknown>` | Optional metadata. |

Edges automatically clip to node surfaces (polygon outline intersection for polygon nodes, bbox boundary otherwise) and bow apart when multiple edges share the same node pair.

## Styling

Styles are declarative selector rules, replacing the entire ruleset on each `graph.style()` call (like `cy.style()`).

```ts
graph.style([
  { selector: 'node',                 style: { fill: 0x1e293b, alpha: 0.9 } },
  { selector: 'node.critical',        style: { fill: 0xdc2626 } },
  { selector: 'node:selected',        style: { fill: 0xf59e0b } },
  { selector: 'edge',                 style: { stroke: 0x64748b, width: 2 } },
  { selector: 'edge:selected',        style: { stroke: 0xf59e0b, width: 4, arrowShape: 'triangle' } },
  { selector: '#special-node',        style: { fill: 0x9333ea } },
]);
```

### Selectors

A selector is one or more tokens **AND-combined with no whitespace**:

| Token | Matches |
|-------|---------|
| `node` / `edge` | Element group |
| `.className` | Elements carrying the class |
| `:selected` | Selected elements |
| `#id` | The element with that id |

Examples: `node`, `edge`, `node.foo`, `node:selected`, `node.foo:selected`, `#my-id`.

**Specificity** = `id × 100 + (classes + pseudos) × 10 + (group ? 1 : 0)`. The effective style of an element is computed by cascading, lowest specificity first, then declaration order (later wins on ties), starting from group defaults.

> Not supported (by design): descendant selectors, attribute selectors, function-valued styles (`data(x)`), and `:hover` (use events to toggle a `hovered` class instead).

### Style properties

| Property | Applies to | Description |
|----------|-----------|-------------|
| `fill` | node | Fill color — hex int (`0x2563eb`) or `'#rrggbb'`. |
| `alpha` | node / edge | Node fill alpha or edge stroke alpha. |
| `stroke` | edge | Stroke color. |
| `width` | edge | Stroke width (graph-local units). |
| `arrowShape` | edge | `'triangle'` or `'none'` (default `'none'`). |
| `arrowSize` | edge | Arrowhead size (default `width × 3`). |
| `lineCap` | edge | `'butt'` (default) or `'round'`. |
| `lineDash` | edge | Dash length (graph-local units). `0` = solid. |
| `lineGap` | edge | Gap length. Defaults to `lineDash`. |
| `lineDashOffset` | edge | Dash phase offset. Animate it for flow effects (see [Dashed flow](#dashed-flow-animation)). |

### Base style override

Pass `style` to the constructor to change the fallback colors used when no rule matches:

```ts
const graph = new PixiGraph({
  style: {
    node: { fill: 0x2563eb, alpha: 0.8 },
    edge: { stroke: 0x999999, width: 2, alpha: 1 },
  },
});
```

## Events

The graph hit-tests on `feed()` and dispatches to matching handlers. Register with an optional selector:

```ts
graph.on('tap', ({ target, x, y, native }) => { /* any hit + background (target may be null) */ });
graph.on('tap', 'node', ({ target }) => { /* node hits only */ });
graph.on('cxttap', '.deletable', ({ target, native }) => { native?.preventDefault(); });
graph.on('mouseover', 'node:selected', ({ target }) => { /* … */ });

graph.off('tap', handler); // remove one
graph.off('tap');          // remove all of a type
graph.off();               // remove everything
```

**Event payload:** `{ type, target, x, y, native }` — `target` is the hit element (or `null` for background taps), `x`/`y` are graph-local, `native` is the original DOM event.

| Event | Fired by | `target` |
|-------|----------|----------|
| `tap` | `feed('tap', …)` (left click) | element or `null` (background) |
| `cxttap` | `feed('cxttap', …)` (right click / contextmenu) | element or `null` |
| `mouseover` | auto, from `feed('mousemove', …)` | always non-null |
| `mouseout` | auto, when hover leaves an element | always non-null |
| `select` / `unselect` | selection state changes | the element |
| `add` / `remove` | element added / removed | the element |
| `bbox` / `rotation` / `polygon` | node geometry changes | the element |
| `data` | `ele.data(key, value)` | the element |

You only ever feed `tap`, `cxttap`, and `mousemove`; `mouseover`/`mouseout` are derived automatically. Use `graph.clearHover(native?)` to force a `mouseout` when the pointer leaves the host canvas.

## Selection & Transform Handles

Enable handles via the constructor (`selectionHandles: true | options`). Handles are drawn at a **screen-stable size** regardless of zoom and can be customized globally and per element.

```ts
const graph = new PixiGraph({
  selectionHandles: {
    enabled: true,        // show resize handles on single-node select
    corners: true,        // 4 corner handles
    edges: true,          // 4 edge-midpoint handles
    move: true,           // drag nodes to move
    union: false,         // per-node handles on multi-select (true = one union box)
    rotate: true,         // enable rotation
    rotateMode: 'zone',   // Figma-style ring outside corners ('handle' = a dedicated top handle)
    keepAspect: false,    // hold Shift to lock aspect ratio temporarily
    centerResize: false,  // hold Ctrl to resize about center temporarily
    handle: { size: 10, shape: 'square', fill: 0xffffff, stroke: 0x000000, strokeWidth: 1 },
    box:    { enabled: true, stroke: 0x2563eb, width: 1, dash: 4, gap: 4 },
  },
});

// Selection API
graph.select('n1');                       // replace selection
graph.select(['n2', 'n3'], { additive: true });
graph.unselect('n2');
graph.unselectAll();
graph.selected();                         // currently selected elements

// Per-element overrides
graph.element('n1')?.resizable(false).rotatable(false).movable(true);
```

When the viewport is active, handle and hit sizing track zoom automatically. Without it, call `graph.setViewScale(scale)` and `graph.setHitTolerance(px)` when your camera changes so handles stay screen-stable.

### Handle options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Show resize handles on single-node select. |
| `selectable` | `boolean` | `true` | Global selection enable. |
| `corners` | `boolean` | `true` | 4 corner handles. |
| `edges` | `boolean` | `false` | 4 edge-midpoint handles. |
| `resizeCursor` | `boolean` | `true` | Show resize cursor on handle hover. |
| `centerResize` | `boolean` | `false` | Resize about center (also via Ctrl). |
| `keepAspect` | `boolean` | `false` | Lock aspect ratio (also via Shift). |
| `union` | `boolean` | `false` | One union box for multi-select (else per-node). |
| `move` | `boolean` | `true` | Drag nodes to move (needs `ele.movable()`). |
| `selectOnGrab` | `boolean` | `true` | Dragging an unselected node auto-selects + moves it. |
| `rotate` | `boolean` | `false` | Enable rotation. |
| `rotateMode` | `'zone' \| 'handle'` | `'handle'` | `'zone'` = Figma corner ring; `'handle'` = dedicated top handle. |
| `rotateZone` | `number` | `16` | `zone` mode: ring thickness (px). |
| `rotateGap` | `number` | `24` | `handle` mode: handle distance above the top edge (px). |
| `handle` | `object` | — | Handle style: `size`, `zoomFollow`, `shape`, `fill`, `stroke`, `strokeWidth`. |
| `box` | `object` | — | Selection outline: `enabled`, `stroke`, `width`, `alpha`, `dash`, `gap`. |

## Viewport (Pan / Zoom Camera)

Activate with `viewport: true | config`. When active, `graph.view` becomes the camera's outer container and graph content lives inside an inner world container (`graph.viewport.world`). The viewport keeps handle sizing and hit tolerance screen-stable as you zoom.

```ts
const graph = new PixiGraph({
  viewport: {
    wheel: true,                 // wheel-zoom (requires viewport.attach(canvas))
    drag: true,                  // drag-pan
    dragButton: 'middle',        // 'left' | 'middle' | 'right'
    minZoom: 0.05,
    maxZoom: 12,
    hitTolerancePx: 6,           // screen-px hit padding, kept constant across zoom
    onChange: () => syncMinimap(),
  },
});
graph.viewport?.attach(app.canvas);

// Camera control (also exposed directly on graph for convenience)
graph.fit();                                    // fit all elements
graph.fit([graph.element('n1')!], { padding: 0.2, duration: 300 });
graph.center();                                 // center all (keep zoom)
graph.panToElement('n1', { ratio: 0.18 });      // pan + select, auto-zoom to fill ~18%
graph.panToElement({ path: ['n1', 'e1', 'n2'] }, { duration: 400 });
graph.panToBbox({ x: 0, y: 0, w: 1000, h: 800 });
graph.zoom; graph.pan;                          // current zoom / pan (null if viewport off)
```

**Pan options** (`PanOptions`): `duration`, `easing`, `padding`, `zoom`, `ratio`, `maxZoom`, `select`, `onUpdate`, `onComplete`.

## Highlight Groups

Highlights overlay inline styles on a named set of elements. They cascade *above* selector rules, in registration order, and several groups can target the same element at once — ideal for trace results, search matches, connectivity views, and collaborative selection.

```ts
graph.highlight({ id: 'trace-1', elements: tracePath, style: { fill: '#ef4444', alpha: 0.6 } });
graph.highlight({ id: 'search',  elements: matches,   style: { stroke: '#0ea5e9', width: 14 } });

graph.unhighlight('search');
graph.unhighlightByPrefix('trace-');   // remove every group starting with "trace-"
graph.clearHighlights();
graph.highlightIds();                  // active group ids, in order
```

When any highlight group is active, non-highlighted elements are automatically dimmed (`.dim`). Pass `noDim: true` to a group to suppress that (a "show this, leave the rest alone" overlay).

**Focus color** locks attention on one color: only elements in a highlight group of that color stay bright; everything else gets a softer `.focus-dim`.

```ts
graph.setFocusColor('#ef4444');  // only red trace paths stay prominent
graph.setFocusColor(null);       // release focus
```

Both `.dim` and `.focus-dim` are defined by the library's built-in system style rules — they work without you adding any CSS or style rule, and you can override them by declaring the same selector in `graph.style()`.

## Undo / Redo

`graph.history` automatically records `add` / `remove` / move / resize / rotate / `data` edits.

```ts
graph.history.undo();
graph.history.redo();
graph.history.canUndo();
graph.history.canRedo();

const off = graph.history.onChange(() => updateToolbar()); // subscribe; call off() to unsubscribe
```

For drag interactions, suspend automatic recording during the drag and record once on release:

```ts
graph.history.suspend();
// … live drag via setNodesBboxes(...) per frame …
graph.history.resume();
graph.history.recordBboxChanges(changes); // one undo step for the whole drag
```

Wrap compound operations in a batch so a single undo reverts them together:

```ts
graph.history.beginBatch();
graph.connect('a', 'b');
graph.remove('old-edge');
graph.history.endBatch();
```

History keeps up to 100 steps (oldest dropped). The library's own compound methods (`insertNodeIntoEdge`, `mergeChain`, `splitEdgeAt`, `paste`, …) batch internally.

## Clipboard

```ts
graph.copySelection();           // copy selected elements
graph.cutSelection();            // copy + remove
graph.paste({ x: 100, y: 100 }); // paste at a graph-local point → new ids
graph.duplicate();               // copy + paste in place

graph.copyProperties();          // copy data/properties only (no geometry)
graph.pasteProperties();         // apply copied properties to the selection

graph.hasClipboard();
graph.hasPropertyClipboard();
```

A drag-to-copy flow is also available: `beginCopyDrag()` → `updateCopyDrag(dx, dy)` → `commitCopyDrag(dx, dy)` / `cancelCopyDrag()`, with `isCopyDragActive()`.

## Graph Editing Primitives

High-level structural edits, each undoable and batched:

```ts
// Connect two nodes — auto-generates the edge id.
const id = graph.connect('a', 'b', { kind: 'flow' });

// Inline-insert an existing node into an edge (e.g. Alt-drag a node onto a wire):
graph.insertNodeIntoEdge('node-x', 'edge-1');   // → { e1, e2 } new edges

// Split an edge with a brand-new node at a projected point:
graph.splitEdgeAt('edge-1', { x: 120, y: 80, w: 40, h: 40 }); // → { nodeId, e1, e2 }

// Detect and merge an edge–node–edge chain back into a single edge:
const chain = graph.detectChain(graph.element('mid')!);
if (chain) graph.mergeChain(chain);             // → new edge id

// Geometry helpers for snapping / routing:
graph.findEdgeNear({ x, y }, 8);                // nearest edge within threshold
graph.projectOnEdge(edge, { x, y });            // clamped projection onto an edge
```

### Preview overlays

Before committing an edit, render a live, non-interactive preview. Previews are signature-guarded, so they're cheap to call every frame:

```ts
graph.previewInsert('node-x', targetEdge); // dim target + show the two branch edges
graph.previewMerge(chain);                 // mark the two edges removed + show the merged edge
graph.hasActivePreview();
graph.clearPreviews();
```

## Hover Tooltips

Opt in with `tooltip: true | options`. The library doesn't render the tooltip — it gives you ordered, filtered key/value entries for your own component.

```ts
const graph = new PixiGraph({
  tooltip: {
    enabled: true,
    propertyOrder: ['category', 'symbolName', 'tagNumber'],
    hiddenKeyPattern: /(uuid|id)/i,
    hiddenKeys: ['polygonPoints'],
  },
});

graph.on('mouseover', 'node', ({ target }) => {
  const entries = graph.tooltipEntries(target!); // [[key, value], …] in priority order
  showTooltip(entries);
});
```

## Dashed Flow Animation

Give edges a dash, then animate the global dash offset for a directional "flow" effect. Only dashed edges re-render, so it's cheap.

```ts
graph.style([
  { selector: 'edge.flow', style: { stroke: 0x22c55e, width: 3, lineDash: 12, lineGap: 8 } },
]);

let offset = 0;
app.ticker.add(() => {
  offset -= 1;                 // negative flows source → target
  graph.setDashOffset(offset);
});
```

## Querying & Hit Testing

```ts
graph.element('n1');                 // by id, or null
graph.$('#n1');                      // selector lookup (#id form)
graph.elements();                    // all, insertion order
graph.nodes();
graph.edges();
graph.size();
graph.byClass('critical');           // elements with a class
graph.elementsIn({ x, y, w, h });    // rubber-band box select (excludes hidden/eye-off)

graph.elementAt(x, y);               // topmost element at a graph-local point
graph.nodeAt(x, y);
graph.edgeAt(x, y);
```

Hit testing respects real geometry (polygon outline, ellipse, rotated rect), prefers nodes over edges, and prefers the smallest overlapping node.

## Configuration Reference

```ts
new PixiGraph({
  style?:            Partial<PixiGraphBaseStyle>,          // base node/edge colors
  selectionHandles?: boolean | PixiGraphHandleOptions,     // resize/rotate/move handles
  tooltip?:          boolean | PixiGraphTooltipOptions,    // hover tooltip entries
  viewport?:         boolean | PixiGraphViewportConfig,    // pan/zoom camera
});
```

**Viewport config**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wheel` | `boolean` | `false` | Wheel-zoom handler (needs `attach(canvas)`). |
| `wheelSensitivity` | `number` | `0.0015` | Zoom factor per `deltaY` unit. |
| `drag` | `boolean` | `false` | Drag-pan handler (needs `attach(canvas)`). |
| `dragButton` | `'left' \| 'middle' \| 'right'` | `'middle'` | Pan mouse button. |
| `dragModifier` | `'shift' \| 'ctrl' \| 'alt' \| null` | `null` | Modifier required to start a pan. |
| `minZoom` | `number` | `0.01` | Minimum zoom. |
| `maxZoom` | `number` | `20` | Maximum zoom. |
| `hitTolerancePx` | `number` | `6` | Screen-px hit padding, kept constant across zoom (`0` = off). |
| `onChange` | `() => void` | — | Called on any transform change (minimap sync, etc.). |

## API Reference

`new PixiGraph(config?)` exposes:

### Elements & queries
`add` · `remove` · `clear` · `element` · `$` · `elements` · `nodes` · `edges` · `size` · `byClass` · `elementsIn` · `elementAt` · `nodeAt` · `edgeAt` · `setHitTolerance`

### Styling
`style` · `setDashOffset`

### Events
`on` · `off` · `feed` · `clearHover`

### Selection & handles
`select` · `unselect` · `unselectAll` · `selected` · `setSelectionHandles` · `redrawHandles` · `setViewScale` · `selectionBbox` · `resizableSelected` · `rotatableSelected` · `movableSelected` · `handlePositions` · `handleAt` · `rotateZoneAt`

### Node geometry
`setNodeBbox` · `setNodesBboxes` · `setNodePolygon` · `setNodesRotations` · static `computeResizedBbox` · static `scaleBboxAbout` · static `handleCursor`

### Viewport
`fit` · `center` · `panToElement` · `panToElements` · `panToBbox` · `zoom` · `pan` · `viewport` (the `PixiGraphViewport` instance, or `null`)

### Highlights
`highlight` · `unhighlight` · `unhighlightByPrefix` · `clearHighlights` · `hasHighlight` · `highlightIds` · `setFocusColor` · `getFocusColor`

### History
`history` (a `PixiGraphHistory`: `undo` · `redo` · `canUndo` · `canRedo` · `clear` · `onChange` · `beginBatch` · `endBatch` · `suspend` · `resume` · `record*`)

### Clipboard
`copySelection` · `cutSelection` · `paste` · `duplicate` · `copyProperties` · `pasteProperties` · `hasClipboard` · `hasPropertyClipboard` · `beginCopyDrag` · `updateCopyDrag` · `commitCopyDrag` · `cancelCopyDrag` · `isCopyDragActive`

### Editing & preview
`connect` · `insertNodeIntoEdge` · `splitEdgeAt` · `mergeChain` · `detectChain` · `findEdgeNear` · `projectOnEdge` · `previewInsert` · `previewMerge` · `hasActivePreview` · `currentPreviewInsertTarget` · `clearPreviews`

### Misc
`hidden` · `tooltipEntries` · `destroy` · `isDestroyed` · `view`

### `PixiGraphElement`

Returned from `graph.element()`, `graph.nodes()`, etc. — never constructed directly.

- **Identity:** `id` · `group` · `isNode` · `isEdge` · `data(key?, value?)` · `bbox` · `position` · `rotation` · `shape` · `polygonPoints` · `image`
- **Capabilities:** `selectable` · `resizable` · `rotatable` · `movable` · `handleMode`
- **Classes & state:** `addClass` · `removeClass` · `toggleClass` · `hasClass` · `classes` · `select` · `unselect` · `selected`
- **Highlights:** `highlights` · `hasHighlight`
- **Graph traversal (edges):** `source` · `target` · `sourcePoint` · `targetPoint` · `connectedEdges`

Most setters are chainable: `ele.addClass('on').data('label', 'x').select();`

### Exports

```ts
import {
  PixiGraph, PixiGraphElement,
  PixiGraphViewport, PixiGraphHistory, PixiGraphPreview,
  PixiGraphEventBus, HighlightManager,
  StyleEngine, parseSelector, matchesSelector,
  ptSegDist, projectOnSeg,
  DEFAULT_PIXIGRAPH_STYLE,
} from '@leebhin/pixigraph';

// Types
import type {
  PixiGraphConfig, PixiGraphAddInput, PixiGraphNodeInput, PixiGraphEdgeInput,
  PixiGraphBaseStyle, PixiGraphStyleProps, PixiGraphStyleRule, ParsedSelector,
  PixiGraphEventType, PixiGraphFeedType, PixiGraphEventPayload, PixiGraphHandler,
  PixiGraphHighlightInput, PixiGraphViewportConfig, PanOptions, ViewportTween,
  ElementGroup, GraphBbox, GraphPoint,
} from '@leebhin/pixigraph';
```

## Cleanup

```ts
graph.destroy();        // detach handlers, cancel tweens, free image textures
graph.isDestroyed();
```

## How It Works

1. The graph renders into a Pixi `Container` (`graph.view`) split into stacked sublayers — edges below nodes below handles — so z-order is correct without per-element sorting.
2. With the viewport active, `graph.view` is the camera's outer container and content lives in an inner world container whose transform is the pan/zoom matrix.
3. All input is **graph-local**. You convert screen → graph-local (`container.toLocal`) and `feed()` it; the graph never registers DOM listeners itself, which keeps it embeddable and SSR-/test-friendly.
4. `feed('mousemove', …)` tracks the hovered element and emits `mouseover` / `mouseout` automatically when it changes.
5. Effective style = group defaults → matching selector rules (specificity, then declaration order) → highlight-group overrides → system classes (`.dim`, `.focus-dim`, `.hidden`). Only the affected elements re-render on a state change.
6. Edges clip to node surfaces and bow apart when parallel; arrowheads are placed precisely even where geometry overlaps.
7. Image nodes load through Pixi `Assets`, cached per URL so N nodes sharing an image cost one fetch; a fallback fill shows until the texture resolves.
8. Handles and the selection box are drawn at a screen-stable size by inversely scaling with zoom (`setViewScale` / viewport), so they don't grow or shrink as you zoom.

## Building From Source

```bash
npm run build      # dist/ — ESM + CJS + .d.ts (via tsup)
npm run typecheck  # tsc --noEmit
```

## License

MIT © [LeeBhin](https://github.com/LeeBhin)
