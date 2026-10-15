/**
 * GPU dash — 점선 엣지 몸통을 셰이더로 끊어 그린다.
 *
 * 흐름 애니메이션은 매 프레임 전역 dash offset 만 바뀐다. 예전엔 그때마다 점선 엣지를 dash 하나당 subpath 로
 * 다시 만들고 stroke 테셀레이션까지 돌렸다(600 엣지 ≈ 16ms). 여기서는 엣지 몸통을 경로 누적거리(s)를
 * 정점 속성으로 가진 띠(strip)로 한 번만 만들고, 조각 셰이더가 `mod(s + 위상 + uOffset, dash+gap)` 으로
 * dash 를 고른다 — offset 이 바뀌면 uniform 하나만 바뀐다.
 *
 * - 묶음(chunk render group) 하나에 메시 하나 — 사용자 셰이더 메시는 배칭되지 않으므로 엣지마다 메시를 두면
 *   draw call 이 엣지 수만큼 는다. 메시는 묶음의 맨 뒤 자식 — 같은 묶음의 실선·화살표 위에 점선 몸통이 온다
 *   (예전엔 엣지 추가 순서대로 섞여 그려졌다. 하이라이트 점선이 겹친 실선에 묻히지 않는 쪽을 택했다).
 * - 엣지 Graphics(ele.view)는 그대로 남아 화살표·비대칭 캡을 그린다. 소비자가 ele.view 에 거는 alpha·tint·
 *   visible/renderable·변환(회전·축소 애니메이션)은 렌더 직전(onRender) 정점 색/위치에 옮긴다.
 * - 분할 엣지(setEdgeSplits)는 점선 구간마다 몸통 하나 — 한 키(엣지)에 몸통 여럿. 경로거리는 구간 시작부터, 위상에
 *   구간 시작거리를 더해 엣지 전체로 이어진 패턴이 된다. 실선 구간은 offset 과 무관하니 Graphics 에 남는다.
 * - WebGL2 전용. 다른 렌더러를 만나면 onUnsupported 로 알려 예전 Graphics 경로로 돌아간다.
 */
import { Mesh, Geometry, Shader, GlProgram, UniformGroup, Container, Color, type Renderer } from 'pixi.js';

/** 점선 몸통 한 개 — renderElement 가 채운다. */
export interface DashBody {
  /** 경로 점 (graph-local, x,y 반복). */
  pts: number[];
  halfW: number;
  dash: number;
  gap: number;
  /** 엣지 고유 위상 — style lineDashOffset(있으면) + setDashPhases 위상. */
  phase: number;
  /** 전역 offset(uOffset) 을 더하는가 — style lineDashOffset 이 있으면 전역 offset 을 무시한다(예전과 같다). */
  useGlobal: boolean;
  /** 양 끝 round 캡 — Graphics 처럼 dash 하나하나가 둥근 끝을 갖는다. */
  round: boolean;
  /** stroke 색(tintable 이면 흰색 — 색은 view.tint) · alpha. */
  color: string | number;
  alpha: number;
  /** 상태 원천 — alpha/tint/visible/renderable/변환을 여기서 읽는다. */
  view: Container;
  /** 그리는 순서(엣지 추가 순) — 메시 안에서 이 순서로 쌓는다(겹친 반투명 점선의 위아래가 예전과 같게). */
  order: number;
}

interface Rec extends DashBody {
  v0: number; vn: number;
  // 마지막으로 정점에 옮긴 view 상태 — 바뀐 엣지만 다시 쓴다.
  kAlpha: number; kTint: number; kVis: boolean; kTf: number;
}

const VERT = `#version 300 es
in vec2 aPosition;
in vec4 aPath;
in vec4 aDash;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
out vec4 vPath;
flat out vec4 vDash;
out vec4 vColor;
void main() {
  mat3 m = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((m * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vPath = aPath;
  vDash = aDash;
  // 색은 사전 곱 전(u8) — pixi 배처처럼 셰이더에서 alpha 를 곱한다(양자화가 Graphics 와 같게).
  vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor * uWorldColorAlpha;
}
`;

// vPath = (s 경로거리, v 폭방향 거리, L 경로 길이, halfW), vDash = (dash, period, 위상, flags: 1=전역 offset, 2=round)
//   그리는 조건은 Graphics 경로(_dashPolyline)와 같다: 위상 p = mod(s + offset, period) 가 dash 미만이면 칠한다.
//   dash 끝은 화면 1px 폭으로 부드럽게(fwidth) — 옆면은 기하 경계라 MSAA 가 맡는다.
const FRAG = `#version 300 es
precision highp float;
in vec4 vPath;
flat in vec4 vDash;
in vec4 vColor;
uniform float uOffset;
out vec4 finalColor;
void main() {
  float s = vPath.x;
  float L = vPath.z;
  float hw = vPath.w;
  float dash = vDash.x;
  float period = vDash.y;
  float flags = vDash.w;
  bool useGlobal = mod(flags, 2.0) > 0.5;
  bool rnd = flags > 1.5;
  float off = vDash.z + (useGlobal ? uOffset : 0.0);
  float fw = max(fwidth(s), 1e-4);
  float sc = clamp(s, 0.0, L);
  float p = mod(sc + off, period);
  float cov;
  if (!rnd) {
    float sd = p < dash ? -min(p, dash - p) : min(p - dash, period - p);
    cov = clamp(0.5 - sd / fw, 0.0, 1.0);
  } else {
    // 칠해진 집합(경로 안 dash 들)까지의 경로방향 거리 — 경로 밖(캡 연장부)은 끝점까지 거리를 더한다.
    float da = 0.0;
    if (p >= dash) {
      float back = p - dash;
      float fwd = period - p;
      float db = (sc - back > 0.0) ? back : 1e9;
      float df = (sc + fwd < L) ? fwd : 1e9;
      da = min(db, df);
    }
    da += abs(s - sc);
    if (da <= 0.0) cov = 1.0;
    else cov = clamp(0.5 - (length(vec2(da, vPath.y)) - hw) / fw, 0.0, 1.0);
  }
  if (cov <= 0.0) discard;
  finalColor = vColor * cov;
}
`;

let _program: GlProgram | null = null;
const program = (): GlProgram => (_program ??= new GlProgram({ vertex: VERT, fragment: FRAG, name: 'pixigraph-dash' }));

/** 메시 — onViewUpdate 를 밖에서 부를 수 있게(렌더 그룹 장부에 '바뀜' 을 남긴다). */
class DashMesh extends Mesh {
  touch(): void { this.onViewUpdate(); }
}

const tmpColor = new Color();
// 다시 만들기 임시 버퍼(경로 누적거리) — 엣지마다 새로 만들지 않는다(하이라이트로 수백 개가 한 번에 다시 만들어질 때 GC).
let distBuf = new Float64Array(64);

// view 변화 알림 — pixi 는 alpha·tint·visible·renderable·위치/크기/회전 setter 가 모두 _onUpdate 를 부른다.
//   몸통의 view 에 끼어들어 바뀐 엣지만 표시한다. 예전엔 렌더마다 몸통 전부(수백 개)를 훑어 비교했다
//   (드래그·팬/줌처럼 매 프레임 렌더할 때 0.1~0.2ms). 앱이 view 를 직접 애니메이션해도(삭제 페이드·축소·회전) 잡힌다.
type Hookable = Container & { _onUpdate: (point?: unknown) => void };
const hookOf = new WeakMap<Container, { notify: (() => void) | null }>();
const hookView = (view: Container, notify: () => void): void => {
  const v = view as Hookable;
  const h = hookOf.get(view);
  if (h) { h.notify = notify; return; }
  const orig = v._onUpdate;
  const rec = { notify: notify as (() => void) | null };
  hookOf.set(view, rec);
  v._onUpdate = function (this: Hookable, point?: unknown) {
    rec.notify?.();
    return orig.call(this, point);
  };
};
// 떼지 않고 알림만 끈다 — 속성을 delete 하면 V8 이 그 view 를 사전 모드로 바꿔 이후 접근이 모두 느려진다
//   (하이라이트처럼 점선 엣지가 다시 그려질 때마다 떼었다 붙이면 0.6.0 보다 느려졌다).
const unhookView = (view: Container): void => {
  const h = hookOf.get(view);
  if (h) h.notify = null;
};

/**
 * 묶음 하나의 점선 몸통 메시. 몸통 추가/제거·기하 변경은 dirty 로만 표시하고 렌더 직전 한 번에 다시 만든다.
 * offset 변경은 uniform(공유) — 이 객체는 아무것도 다시 만들지 않는다.
 */
export class DashBatch {
  readonly mesh: DashMesh;
  /** 메시를 감싼 자기 렌더 그룹 — 묶음(Graphics) 의 다시 배칭과 메시 갱신이 서로를 끌어들이지 않게. */
  private readonly _holder: Container;
  private readonly _geom: Geometry;
  private readonly _shader: Shader;
  /** 키(엣지) → 몸통들(분할 엣지면 점선 구간마다 하나, 모두 같은 view). */
  private readonly _recs = new Map<unknown, Rec[]>();
  private _dirty = false;
  /** view 가 바뀐 몸통 — 다음 렌더 직전에 이것만 정점에 옮긴다. */
  private readonly _changed = new Set<Rec>();
  /** 전역 offset 을 쓰는 몸통 수 — 0 이면 offset 변경 때 건드릴 필요가 없다. */
  globalCount = 0;
  private _pos = new Float32Array(0);
  private _base = new Float32Array(0);
  private _col = new Uint8Array(0);

  constructor(chunk: Container, uniforms: UniformGroup, onUnsupported: (r: Renderer) => void) {
    this._geom = new Geometry({
      attributes: {
        aPosition: { buffer: new Float32Array(0), format: 'float32x2' },
        aPath: { buffer: new Float32Array(0), format: 'float32x4' },
        aDash: { buffer: new Float32Array(0), format: 'float32x4' },
        aColor: { buffer: new Uint8Array(0), format: 'unorm8x4' },
      },
      indexBuffer: new Uint32Array(0),
    });
    const shader = this._shader = new Shader({ glProgram: program(), resources: { dashUniforms: uniforms } });
    this.mesh = new DashMesh({ geometry: this._geom as never, shader: shader as never });
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
    this.mesh.onRender = (r: Renderer) => {
      const gl = (r as unknown as { gl?: WebGL2RenderingContext; context?: { webGLVersion?: number } });
      if (!gl.gl || gl.context?.webGLVersion !== 2) { onUnsupported(r); return; }
      this._prerender();
    };
    // 메시를 묶음에 바로 넣으면 묶음의 Graphics 하나가 바뀔 때 다시 배칭이 메시 앞뒤로 갈려 비싸졌다
    //   (하이라이트 켜기 0.6.0 대비 +2ms). 자기 렌더 그룹으로 감싸 묶음 맨 뒤(같은 그리는 순서)에 둔다.
    this._holder = new Container();
    this._holder.isRenderGroup = true;
    this._holder.eventMode = 'none';
    this._holder.addChild(this.mesh);
    chunk.addChild(this._holder);
  }

  get size(): number { return this._recs.size; }
  has(key: unknown): boolean { return this._recs.has(key); }

  /** 키의 몸통들을 교체 — 빈 배열이면 지운다. 몸통들은 같은 view 를 공유해야 한다. */
  set(key: unknown, bodies: DashBody[]): void {
    if (!bodies.length) { this.delete(key); return; }
    this._drop(key);
    const recs: Rec[] = bodies.map((body) => ({ ...body, v0: 0, vn: 0, kAlpha: NaN, kTint: NaN, kVis: false, kTf: NaN }));
    this._recs.set(key, recs);
    hookView(bodies[0].view, () => {
      if (this._recs.get(key) !== recs) return;
      if (!this._changed.size) this.mesh.touch();
      recs.forEach((r) => this._changed.add(r));
    });
    recs.forEach((r) => { if (r.useGlobal) this.globalCount++; });
    this._markDirty();
  }

  delete(key: unknown): void {
    const old = this._drop(key);
    if (!old) return;
    this._recs.delete(key);
    unhookView(old[0].view);
    this._markDirty();
  }

  /** 키의 기존 몸통을 장부(전역 수·바뀜 목록)에서 뺀다. */
  private _drop(key: unknown): Rec[] | undefined {
    const old = this._recs.get(key);
    old?.forEach((r) => { if (r.useGlobal) this.globalCount--; this._changed.delete(r); });
    return old;
  }

  /** offset 만 바뀜 — 장부에 표시만(다음 렌더가 이 묶음을 그리게). */
  touch(): void { if (this.mesh.visible) this.mesh.touch(); }

  destroy(): void {
    this._recs.forEach((rs) => unhookView(rs[0].view));
    this._recs.clear();
    this._changed.clear();
    try { this.mesh.destroy(); } catch { /* noop */ }
    try { this._holder.destroy(); } catch { /* noop */ }
    try { this._geom.destroy(true); } catch { /* noop */ }
    try { this._shader.destroy(); } catch { /* noop */ } // 공유 program·uniform 은 남긴다
  }

  private _markDirty(): void {
    this._dirty = true;
    this.mesh.touch();
  }

  /** 렌더 직전 — 다시 만들 게 있으면 만들고, view 상태(alpha·tint·visible·변환)가 바뀐 몸통의 정점만 고친다.
   *  다시 만들었으면 전부(새 정점), 아니면 _onUpdate 로 표시된 것만 — 아무것도 안 바뀐 프레임은 비용 0. */
  private _prerender(): void {
    const all = this._dirty;
    if (all) this._rebuild();
    if (!all && !this._changed.size) return;
    const list: Iterable<Rec> = all ? [...this._recs.values()].flat() : this._changed;
    let colDirty = false, posDirty = false;
    for (const r of list) {
      const v = r.view;
      if (v.destroyed) continue;
      const vis = v.visible && v.renderable;
      const a = v.alpha, t = v.tint;
      if (vis !== r.kVis || a !== r.kAlpha || t !== r.kTint) {
        r.kVis = vis; r.kAlpha = a; r.kTint = t;
        this._writeColor(r);
        colDirty = true;
      }
      // 변환 — 소비자 애니메이션(축소·회전)이 view 를 움직이면 몸통도 같이. 단위 변환이면 원래 좌표.
      v.updateLocalTransform();
      const m = v.localTransform;
      const ident = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0;
      const tf = ident ? 0 : (v as unknown as { _didContainerChangeTick: number })._didContainerChangeTick + 1;
      if (tf !== r.kTf) {
        r.kTf = tf;
        const pos = this._pos, base = this._base;
        for (let i = r.v0 * 2, e = (r.v0 + r.vn) * 2; i < e; i += 2) {
          const x = base[i], y = base[i + 1];
          pos[i] = ident ? x : m.a * x + m.c * y + m.tx;
          pos[i + 1] = ident ? y : m.b * x + m.d * y + m.ty;
        }
        posDirty = true;
      }
    }
    this._changed.clear();
    if (colDirty) this._geom.getBuffer('aColor').update();
    if (posDirty) this._geom.getBuffer('aPosition').update();
  }

  private _writeColor(r: Rec): void {
    tmpColor.setValue(r.color);
    const tint = r.kTint;
    const a = r.kVis ? Math.max(0, Math.min(1, r.alpha * tmpColor.alpha * r.kAlpha)) : 0;
    const col = this._col;
    // 사전 곱 전 색 + alpha (셰이더가 곱한다).
    const cr = Math.round(tmpColor.red * ((tint >> 16) & 255)), cg = Math.round(tmpColor.green * ((tint >> 8) & 255));
    const cb = Math.round(tmpColor.blue * (tint & 255)), ca = (a * 255) | 0; // alpha 는 내림 — pixi 배처와 같다
    for (let i = r.v0 * 4, e = (r.v0 + r.vn) * 4; i < e; i += 4) {
      col[i] = cr; col[i + 1] = cg; col[i + 2] = cb; col[i + 3] = ca;
    }
  }

  /** 모든 몸통을 띠로 — 점마다 좌우 두 정점(miter), 구간마다 삼각형 둘. */
  private _rebuild(): void {
    this._dirty = false;
    // 겹친 점(길이 0 구간)은 빼고 센다.
    const clean = new Map<Rec, number[]>();
    let nv = 0, ni = 0;
    // 정렬은 안정 — 같은 엣지의 구간은 경로 순서 그대로.
    [...this._recs.values()].flat().sort((a, b) => a.order - b.order).forEach((r) => {
      const p = r.pts, q: number[] = [p[0], p[1]];
      for (let i = 2; i + 1 < p.length; i += 2) {
        if (Math.hypot(p[i] - q[q.length - 2], p[i + 1] - q[q.length - 1]) > 1e-6) q.push(p[i], p[i + 1]);
      }
      if (q.length < 4 || r.dash <= 0) { r.vn = 0; return; }
      clean.set(r, q);
      const n = q.length / 2;
      nv += n * 2; ni += (n - 1) * 6;
    });
    const pos = new Float32Array(nv * 2), path = new Float32Array(nv * 4), dsh = new Float32Array(nv * 4);
    const idx = new Uint32Array(ni);
    const col = new Uint8Array(nv * 4);
    let vi = 0, ii = 0;
    clean.forEach((q, r) => {
      const n = q.length / 2, hw = r.halfW;
      // 경로 누적거리
      if (distBuf.length < n) distBuf = new Float64Array(Math.max(n, distBuf.length * 2));
      const d = distBuf;
      d[0] = 0;
      for (let i = 1; i < n; i++) d[i] = d[i - 1] + Math.hypot(q[i * 2] - q[i * 2 - 2], q[i * 2 + 1] - q[i * 2 - 1]);
      const L = d[n - 1];
      // round 캡 — 양 끝을 halfW 만큼 연장(경로거리도 -hw, L+hw). 캡 모양은 셰이더가 깎는다.
      const ext = r.round ? hw : 0;
      r.v0 = vi; r.vn = n * 2;
      const flags = (r.useGlobal ? 1 : 0) + (r.round ? 2 : 0);
      for (let i = 0; i < n; i++) {
        const x = q[i * 2], y = q[i * 2 + 1];
        // 앞뒤 구간 방향
        let ax = 0, ay = 0, bx = 0, by = 0;
        if (i > 0) { const l = d[i] - d[i - 1]; ax = (x - q[i * 2 - 2]) / l; ay = (y - q[i * 2 - 1]) / l; }
        if (i < n - 1) { const l = d[i + 1] - d[i]; bx = (q[i * 2 + 2] - x) / l; by = (q[i * 2 + 3] - y) / l; }
        if (i === 0) { ax = bx; ay = by; }
        if (i === n - 1) { bx = ax; by = ay; }
        // 법선(왼쪽) — miter: 두 법선의 이등분, 길이 hw / cos(반각). 너무 날카로우면(한계 4배) 자른다.
        let nx = -(ay + by), ny = ax + bx;
        const nl = Math.hypot(nx, ny);
        let k = hw;
        if (nl < 1e-6) { nx = -ay; ny = ax; }
        else {
          nx /= nl; ny /= nl;
          const cos = nx * -ay + ny * ax;
          k = hw / Math.max(cos, 0.25);
        }
        let px = x, py = y, s = d[i];
        if (ext && i === 0) { px -= ax * ext; py -= ay * ext; s -= ext; }
        if (ext && i === n - 1) { px += bx * ext; py += by * ext; s += ext; }
        for (let side = 1; side >= -1; side -= 2) {
          pos[vi * 2] = px + nx * k * side; pos[vi * 2 + 1] = py + ny * k * side;
          path[vi * 4] = s; path[vi * 4 + 1] = hw * side; path[vi * 4 + 2] = L; path[vi * 4 + 3] = hw;
          dsh[vi * 4] = r.dash; dsh[vi * 4 + 1] = r.dash + r.gap; dsh[vi * 4 + 2] = r.phase; dsh[vi * 4 + 3] = flags;
          vi++;
        }
        if (i > 0) {
          const a = vi - 4;
          idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
          idx[ii++] = a + 1; idx[ii++] = a + 3; idx[ii++] = a + 2;
        }
      }
      r.kVis = false; r.kAlpha = NaN; r.kTint = NaN; r.kTf = NaN; // 새 정점 — 색·위치를 다시 쓰게
    });
    this._pos = pos;
    this._base = pos.slice();
    this._col = col;
    this._geom.getBuffer('aPosition').data = pos;
    this._geom.getBuffer('aPath').data = path;
    this._geom.getBuffer('aDash').data = dsh;
    this._geom.getBuffer('aColor').data = col;
    this._geom.indexBuffer.data = idx;
    this.mesh.visible = ni > 0;
  }
}

/** 공유 uniform — 모든 묶음 메시가 같은 것을 본다(offset 은 한 번만 쓴다). */
export const createDashUniforms = (): UniformGroup => new UniformGroup({ uOffset: { value: 0, type: 'f32' } });
