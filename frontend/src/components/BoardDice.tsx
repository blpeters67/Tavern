/** The 3D dice that drop onto the game board when somebody rolls. The result
 * always comes from the server (the roll was already made — see lib/rolls), so
 * this layer only has to make the dice agree with it: they tumble in, settle
 * with the rolled number facing up and the roller's name under them. Everyone
 * at the table sees the same numbers because everyone plays the same roll
 * message.
 *
 * Every die is generated here — geometry and textures (pips for the cube,
 * numbers for the rest). Nothing is fetched, so the layer costs nothing until
 * dice are actually used, and there are no third-party assets to credit.
 *
 * A little ✕ rides the card's top-right corner so a roll can be knocked off
 * the screen without waiting for the fade.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import { tip } from './layers';

/** Same preference check the chat dice use before animating. */
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** One die to drop: its shape and the value it must land on. */
export interface BoardDie {
  sides: number;
  value: number;
  drop?: boolean;
}

/** A fresh roll for the overlay: a new id replays the drop. */
export interface BoardRoll {
  id: number;
  dice: BoardDie[];
  /** Who rolled, shown under the dice. */
  who?: string;
  /** The result card under the dice: who rolled what, and the headline number. */
  card?: BoardCard;
}

export interface BoardCard {
  name: string;
  title: string;
  expression: string;
  total: string;
  avatar?: string | null;
  /** The roller's colour (a character's), for their name on the card. */
  color?: string | null;
  adv?: 'adv' | 'dis' | null;
  outcome?: 'success' | 'failure' | null;
}

type Three = typeof import('three');
type Geo = import('three').BufferGeometry;
type Mat = import('three').MeshStandardMaterial;
/** Any three material that fades: used for badges and the soft shadows. */
type AnyMat = import('three').Material & { opacity: number };
type Obj3D = import('three').Object3D;
type SpriteO = import('three').Sprite;
type Vec3 = import('three').Vector3;

/** The shapes the board can drop. Anything else still posts to chat. */
const SHAPES = [4, 6, 8, 10, 12, 20] as const;

/** Anything past this many dice still rolls; the extras just skip the drop. */
const MAX_DICE = 12;
/** The die's size on screen, in CSS pixels (the world size follows the stage). */
const DIE_PX = 82;
/** Roughly the visible width of the board's floor at the camera distance. */
const VIS_W = 3.27;
/** The tumble runs until ALIGN_START, then eases onto the landing pose over
 *  ALIGN_MS: the rotation finishes exactly as the die touches down (LAND_MS),
 *  so nothing swivels after it has come to rest. */
const ALIGN_START = 860;
const ALIGN_MS = 380;
const LAND_MS = ALIGN_START + ALIGN_MS;
/** Everything is static by here (label and badge faded in): stop drawing. */
const IDLE_AT = LAND_MS + 220;
/** Settled dice stay this long, then fade out. */
const STAY_MS = 12000;
const FADE_MS = 750;

const BASE = '#f2f3f5';
const INK = '#20242b';

// ---------------------------------------------------------------------------
// Shared resources (module scope: they survive board remounts)
// ---------------------------------------------------------------------------

let threePromise: Promise<Three> | null = null;
function loadThree(): Promise<Three> {
  threePromise ??= import('three');
  return threePromise;
}

let boxModulePromise: Promise<typeof import('three/examples/jsm/geometries/RoundedBoxGeometry.js')> | null = null;

/** The canvas the pip art lives on: six square cells (3x3 grid), value 1..6. */
let pipTexture: import('three').Texture | null = null;
function getPipTexture(T: Three): import('three').Texture {
  if (pipTexture) return pipTexture;
  const cell = 256;
  const c = document.createElement('canvas');
  c.width = cell * 3;
  c.height = cell * 3;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = BASE;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = INK;
  const off = cell * 0.2;
  const r = cell * 0.06;
  const PATTERNS: Record<number, [number, number][]> = {
    1: [[0, 0]],
    2: [[-off, -off], [off, off]],
    3: [[-off, -off], [0, 0], [off, off]],
    4: [[-off, -off], [off, -off], [-off, off], [off, off]],
    5: [[-off, -off], [off, -off], [0, 0], [-off, off], [off, off]],
    6: [[-off, -off], [off, -off], [-off, 0], [off, 0], [-off, off], [off, off]],
  };
  for (let v = 1; v <= 6; v++) {
    const cx = ((v - 1) % 3) * cell + cell / 2;
    const cy = Math.floor((v - 1) / 3) * cell + cell / 2;
    for (const [px, py] of PATTERNS[v]) {
      ctx.beginPath();
      ctx.arc(cx + px, cy + py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  pipTexture = new T.CanvasTexture(c);
  pipTexture.colorSpace = T.SRGBColorSpace;
  return pipTexture;
}

/** The canvas the numbers live on: 25 square cells, value 1..25. One canvas
 *  per die shape: the d10's kite faces are the tightest of all and take
 *  smaller numbers than the shapes the d4/d8 were tuned with. */
const numberTextures = new Map<number, import('three').Texture>();
function getNumberTexture(T: Three, sides: number): import('three').Texture {
  const hit = numberTextures.get(sides);
  if (hit) return hit;
  const cell = 256;
  const c = document.createElement('canvas');
  c.width = cell * 5;
  c.height = cell * 5;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = BASE;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = 1; v <= 25; v++) {
    // Two-digit numbers must fit the narrowest faces that use them (the d20's
    // triangles, the d10's kites), so they are drawn smaller than the single
    // digits; one size for everything clipped their corners.
    const f = sides === 10 ? (v < 10 ? 0.32 : 0.19) : v < 10 ? 0.42 : 0.23;
    ctx.font = `700 ${cell * f}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const cx = ((v - 1) % 5) * cell + cell / 2;
    const cy = Math.floor((v - 1) / 5) * cell + cell / 2;
    ctx.fillText(String(v), cx, cy + cell * 0.02);
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  numberTextures.set(sides, tex);
  return tex;
}

let shadowTexture: import('three').Texture | null = null;
function getShadowTexture(T: Three): import('three').Texture {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, 'rgba(0, 0, 0, 0.75)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  shadowTexture = new T.CanvasTexture(c);
  return shadowTexture;
}

/** The result card under the dice: the roller's picture, "<name> rolled —
 *  <title>", and the expression with the total in gold. Drawn on a canvas
 *  sprite; the avatar drops in when it finishes loading. */
function cardTexture(T: Three, card: BoardCard): import('three').Texture {
  const W = 900;
  const H = 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  const ui = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const totalColor = card.outcome === 'success' ? '#43b581' : card.outcome === 'failure' ? '#ed4245' : '#e0b252';
  const img = card.avatar ? new Image() : null;
  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    roundRect(5, 5, W - 10, H - 10, 30);
    ctx.fillStyle = 'rgba(12, 14, 19, 0.9)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();
    // the roller's picture (their initial while it loads, or without one)
    const ax = 88;
    const ay = H / 2;
    const ar = 47;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.clip();
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, ax - ar, ay - ar, ar * 2, ar * 2);
    } else {
      ctx.fillStyle = 'rgba(96, 108, 214, 0.4)';
      ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2);
      ctx.fillStyle = BASE;
      ctx.font = `700 48px ${ui}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((card.name[0] ?? '?').toUpperCase(), ax, ay + 3);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = card.color || 'rgba(122, 162, 247, 0.6)';
    ctx.stroke();
    // "<name> rolled — <title>", trimmed to fit (with an ellipsis when it must)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const tx = ax + ar + 26;
    const room = W - tx - 40;
    const nameFont = `700 42px ${ui}`;
    const restFont = `500 36px ${ui}`;
    ctx.font = nameFont;
    const nameW = ctx.measureText(card.name).width;
    const fullTitle = card.title;
    let title = card.title;
    ctx.font = restFont;
    const lineW = () => nameW + ctx.measureText(` rolled — ${title}`).width;
    while (lineW() > room && title.length > 1) title = title.slice(0, -1);
    if (title !== fullTitle) title = `${title.trimEnd()}…`;
    ctx.font = nameFont;
    ctx.fillStyle = card.color || '#8ab4f8';
    ctx.fillText(card.name, tx, 86);
    ctx.font = restFont;
    ctx.fillStyle = 'rgba(214, 219, 232, 0.92)';
    ctx.fillText(` rolled — ${title}`, tx + nameW, 86);
    // "2d20kh1 = 17"
    if (card.total) {
      ctx.font = restFont;
      ctx.fillStyle = 'rgba(174, 178, 191, 0.95)';
      ctx.fillText(card.expression, tx, 150);
      let ex = tx + ctx.measureText(card.expression).width;
      ctx.fillText(' =', ex, 150);
      ex += ctx.measureText(' =').width;
      ctx.font = `700 58px ${ui}`;
      ctx.fillStyle = totalColor;
      ctx.fillText(card.total, ex + 6, 160);
    }
  };
  if (img) {
    img.onload = () => {
      draw();
      tex.needsUpdate = true;
    };
    img.src = card.avatar!;
  }
  draw();
  return tex;
}

let shadowGeo: Geo | null = null;

// ---------------------------------------------------------------------------
// Geometry. Every die is baked once per shape: unit-sized, with UVs pointing
// each face at its own cell of the pip/number canvas, and a face table the
// settle math uses to bring the rolled value to the top.
// ---------------------------------------------------------------------------

interface FaceInfo {
  normal: Vec3;
  /** In-plane vector that should read "up" when this face is on top. */
  readUp: Vec3;
}

interface DieGeo {
  geo: Geo;
  /** faces[value - 1] */
  faces: FaceInfo[];
}

const geos = new Map<number, DieGeo>();

/** How the cube's six faces map to values (opposites sum to 7). */
const CUBE_FACES: { axis: [number, number, number]; e1: [number, number, number]; e2: [number, number, number]; value: number }[] = [
  { axis: [1, 0, 0], e1: [0, 0, -1], e2: [0, 1, 0], value: 1 },
  { axis: [-1, 0, 0], e1: [0, 0, 1], e2: [0, 1, 0], value: 6 },
  { axis: [0, 1, 0], e1: [1, 0, 0], e2: [0, 0, -1], value: 2 },
  { axis: [0, -1, 0], e1: [1, 0, 0], e2: [0, 0, 1], value: 5 },
  { axis: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], value: 3 },
  { axis: [0, 0, -1], e1: [-1, 0, 0], e2: [0, 1, 0], value: 4 },
];

/** A rounded cube with the pips baked into its UVs. */
async function buildCube(T: Three): Promise<DieGeo> {
  boxModulePromise ??= import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  const { RoundedBoxGeometry } = await boxModulePromise;
  const geo = new RoundedBoxGeometry(1, 1, 1, 4, 0.17) as unknown as Geo;
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const cellW = 1 / 3;
  const cellH = 1 / 3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    let f = CUBE_FACES[0];
    if (ax >= ay && ax >= az) f = x > 0 ? CUBE_FACES[0] : CUBE_FACES[1];
    else if (ay >= az) f = y > 0 ? CUBE_FACES[2] : CUBE_FACES[3];
    else f = z > 0 ? CUBE_FACES[4] : CUBE_FACES[5];
    const [e1x, e1y, e1z] = f.e1;
    const [e2x, e2y, e2z] = f.e2;
    const lu = x * e1x + y * e1y + z * e1z;
    const lv = x * e2x + y * e2y + z * e2z;
    const col = (f.value - 1) % 3;
    const row = Math.floor((f.value - 1) / 3);
    const cx = (col + 0.5) * cellW;
    const cy = 1 - (row + 0.5) * cellH;
    const half = 0.4 * Math.min(cellW, cellH);
    uv[i * 2] = cx + (lu / 0.5) * half;
    uv[i * 2 + 1] = cy + (lv / 0.5) * half;
  }
  geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
  const faces: FaceInfo[] = [];
  for (const f of CUBE_FACES) faces[f.value - 1] = { normal: new T.Vector3(...f.axis), readUp: new T.Vector3(...f.e2) };
  return { geo, faces };
}

/** The pentagonal trapezohedron (the real d10 shape, planar kites), soup.
 *  Kites are emitted two triangles at a time in value order: 1-5 around the
 *  top apex, then 6-10 on the bottom, each face five away from its opposite.
 *  Both windings were picked so the cross product points away from the centre
 *  (the old build had the top half inside out). */
function buildD10(T: Three): Geo {
  // Ring height and apex height are tied: yT = 9.47 * y1 keeps the kite faces
  // planar (checked by hand on the cross product), so each face shades flat.
  const y1 = 0.052;
  const yT = 0.492;
  const R = 0.42;
  const U: [number, number, number][] = [];
  const L: [number, number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    U.push([Math.cos(a) * R, y1, Math.sin(a) * R]);
    const b = a + Math.PI / 5;
    L.push([Math.cos(b) * R, -y1, Math.sin(b) * R]);
  }
  const top: [number, number, number] = [0, yT, 0];
  const bot: [number, number, number] = [0, -yT, 0];
  const tris: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  for (let i = 0; i < 5; i++) {
    quad(U[(i + 1) % 5], L[i], U[i], top);
  }
  for (let v = 0; v < 5; v++) {
    // Value 6 + v goes on the bottom kite opposite top v (two steps around).
    const j = (v + 2) % 5;
    quad(bot, L[j], U[(j + 1) % 5], L[(j + 1) % 5]);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return g;
}

/** Corner data as both plain and interleaved attributes expose it. */
type Attr = import('three').BufferAttribute | import('three').InterleavedBufferAttribute;

/** Unit normal of triangle t of a triangle-soup geometry. */
function triNormal(pos: Attr, t: number): [number, number, number] {
  const i = t * 3;
  const ux = pos.getX(i + 1) - pos.getX(i);
  const uy = pos.getY(i + 1) - pos.getY(i);
  const uz = pos.getZ(i + 1) - pos.getZ(i);
  const vx = pos.getX(i + 2) - pos.getX(i);
  const vy = pos.getY(i + 2) - pos.getY(i);
  const vz = pos.getZ(i + 2) - pos.getZ(i);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const ln = Math.hypot(nx, ny, nz) || 1;
  return [nx / ln, ny / ln, nz / ln];
}

/** A plane key for grouping: rounds first (which turns -0.00 into 0.00) and
 *  snaps near-axis noise to zero, so one physical face can never split into
 *  two entries over a signed zero. */
function planeKey(n: [number, number, number]): string {
  const q = (v: number) => {
    const r = Math.round(v * 100) / 100;
    return (Math.abs(r) < 0.005 ? 0 : r).toFixed(2);
  };
  return `${q(n[0])},${q(n[1])},${q(n[2])}`;
}

/** Unique corner positions of a face: soup geometry repeats a corner once per
 *  triangle it belongs to, so de-duplicate by position — averaging the raw
 *  triangle corners would pull the face centre toward whichever corner the
 *  triangulation fanned out from. */
function faceVertices(pos: Attr, tris: number[]) {
  const corners: number[] = [];
  const uniq: [number, number, number][] = [];
  const seen = new Set<string>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = t * 3 + k;
      corners.push(vi);
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      const z = pos.getZ(vi);
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push([x, y, z]);
      }
    }
  }
  return { corners, uniq };
}

/** Point every face group at its own cell of the number canvas (with the face
 *  mapped inside the middle 68% of the cell, so nothing samples a neighbour)
 *  and return the landing table: group g is the face that shows value g + 1. */
function bakeFaceGroups(T: Three, geo: Geo, groups: number[][]): FaceInfo[] {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const faces: FaceInfo[] = [];
  groups.forEach((tris, idx) => {
    const { corners, uniq } = faceVertices(pos, tris);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const [x, y, z] of uniq) {
      cx += x;
      cy += y;
      cz += z;
    }
    cx /= uniq.length;
    cy /= uniq.length;
    cz /= uniq.length;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const t of tris) {
      const n = triNormal(pos, t);
      nx += n[0];
      ny += n[1];
      nz += n[2];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // readUp: toward the face's highest vertex, within the face plane.
    let up: [number, number, number] = [1, 0, 0];
    let best = -Infinity;
    for (const [x, y, z] of uniq) {
      const dy = y - cy;
      if (dy > best) {
        best = dy;
        up = [x - cx, dy, z - cz];
      }
    }
    const ul = Math.hypot(up[0], up[1], up[2]) || 1;
    const e2: [number, number, number] = [up[0] / ul, up[1] / ul, up[2] / ul];
    // right = e2 x normal: faces read non-mirrored when seen from outside.
    const e1: [number, number, number] = [e2[1] * nz - e2[2] * ny, e2[2] * nx - e2[0] * nz, e2[0] * ny - e2[1] * nx];
    let maxLocal = 1e-6;
    for (const [x, y, z] of uniq) {
      const lu = (x - cx) * e1[0] + (y - cy) * e1[1] + (z - cz) * e1[2];
      const lv = (x - cx) * e2[0] + (y - cy) * e2[1] + (z - cz) * e2[2];
      maxLocal = Math.max(maxLocal, Math.hypot(lu, lv));
    }
    const value = idx + 1;
    const col = (value - 1) % 5;
    const row = Math.floor((value - 1) / 5);
    const ccu = (col + 0.5) / 5;
    const ccv = 1 - (row + 0.5) / 5;
    const s = 0.34 / 5 / maxLocal;
    for (const vi of corners) {
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      const z = pos.getZ(vi);
      const lu = (x - cx) * e1[0] + (y - cy) * e1[1] + (z - cz) * e1[2];
      const lv = (x - cx) * e2[0] + (y - cy) * e2[1] + (z - cz) * e2[2];
      uv[vi * 2] = ccu + lu * s;
      uv[vi * 2 + 1] = ccv + lv * s;
    }
    faces[value - 1] = { normal: new T.Vector3(nx, ny, nz), readUp: new T.Vector3(e2[0], e2[1], e2[2]) };
  });
  geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
  return faces;
}

/** Bake a triangle-soup polyhedron: group its triangles into physical faces,
 *  then map each face to its cell. `sides` is the face count the shape really
 *  has — a grouping that finds anything else is a bug and throws here rather
 *  than quietly landing rolled values on the wrong faces. */
function bakePoly(T: Three, geo: Geo, suffix: string, sides: number): DieGeo {
  const pos = geo.getAttribute('position');
  const triCount = pos.count / 3;
  const groups: number[][] = [];
  const keys = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const key = planeKey(triNormal(pos, t)) + suffix;
    let g = keys.get(key);
    if (g === undefined) {
      g = groups.length;
      keys.set(key, g);
      groups.push([]);
    }
    groups[g].push(t);
  }
  if (groups.length !== sides) throw new Error(`${suffix}: expected ${sides} faces, found ${groups.length}`);
  return { geo, faces: bakeFaceGroups(T, geo, groups) };
}

/** Bake the d10: its kites are built two triangles at a time in value order,
 *  so the face table is explicit and needs no grouping. */
function bakeD10Die(T: Three): DieGeo {
  const geo = buildD10(T);
  const groups: number[][] = [];
  for (let k = 0; k < 10; k++) groups.push([k * 2, k * 2 + 1]);
  return { geo, faces: bakeFaceGroups(T, geo, groups) };
}

/** Build (once) the unit geometry for a shape. */
async function getDieGeo(T: Three, sides: number): Promise<DieGeo | null> {
  const hit = geos.get(sides);
  if (hit) return hit;
  let dg: DieGeo | null = null;
  if (sides === 6) dg = await buildCube(T);
  else if (sides === 4) dg = bakePoly(T, new T.TetrahedronGeometry(0.5), 't4', 4);
  else if (sides === 8) dg = bakePoly(T, new T.OctahedronGeometry(0.55), 't8', 8);
  else if (sides === 10) dg = bakeD10Die(T);
  else if (sides === 12) dg = bakePoly(T, new T.DodecahedronGeometry(0.48), 't12', 12);
  else if (sides === 20) dg = bakePoly(T, new T.IcosahedronGeometry(0.5), 't20', 20);
  if (dg) geos.set(sides, dg);
  return dg;
}

// ---------------------------------------------------------------------------
// The drop
// ---------------------------------------------------------------------------

interface Die {
  group: Obj3D;
  shadow: Obj3D & { material: AnyMat };
  badge: SpriteO | null;
  mat: Mat;
  h0: number;
  from: { x: number; z: number };
  to: { x: number; z: number };
  spinAxis: Vec3;
  spinRate: number;
  /** Opacity multiplier: below 1 for a die the roll threw away. */
  base: number;
  settleQ: import('three').Quaternion;
  startQ: import('three').Quaternion;
  phase: 0 | 1 | 2;
  x: number;
  y: number;
  z: number;
  drop: boolean;
}

interface World {
  T: Three;
  host: HTMLElement;
  renderer: import('three').WebGLRenderer;
  scene: import('three').Scene;
  camera: import('three').PerspectiveCamera;
  dice: Die[];
  label: SpriteO | null;
  raf: number;
  fadeTimer: number;
  start: number;
  dieSize: number;
  observer: ResizeObserver;
  closeEl: HTMLElement | null;
}

const easeOutCubic = (u: number) => 1 - Math.pow(1 - u, 3);

/** Height of a die above the floor at t (ms): a drop and two small bounces. */
function heightAt(t: number, h0: number, size: number): number {
  const rest = size * 0.5;
  if (t < 620) {
    const u = t / 620;
    return h0 - (h0 - rest) * u * u;
  }
  if (t < 960) {
    const u = (t - 620) / 340;
    return rest + size * 0.55 * Math.sin(Math.PI * u) * (1 - u * 0.25);
  }
  if (t < LAND_MS) {
    const u = (t - 960) / 280;
    return rest + size * 0.16 * Math.sin(Math.PI * u) * (1 - u * 0.4);
  }
  return rest;
}

/** Spin the die so face `value` lands up (or down for the d4), reading upright. */
function settleQuat(T: Three, dg: DieGeo, value: number, down: boolean): import('three').Quaternion {
  const face = dg.faces[value - 1];
  if (!face) return new T.Quaternion();
  const faceQ = new T.Quaternion().setFromUnitVectors(face.normal.clone().normalize(), new T.Vector3(0, down ? -1 : 1, 0));
  const rU = face.readUp.clone().applyQuaternion(faceQ);
  // Spin about the vertical so the top face's "up" points away from the
  // camera: that is the direction that reads upward on screen.
  const ang = Math.atan2(rU.x, -rU.z);
  const yaw = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), ang);
  return yaw.multiply(faceQ);
}

function spawnDie(T: Three, world: World, dg: DieGeo, die: BoardDie, index: number, count: number, spanX: number, pick: boolean): Die {
  const size = world.dieSize;
  // Lay the dice out inside the width the camera can actually show: a wide
  // stage fits six in a row, a narrow one wraps to more rows.
  const perRow = Math.max(1, Math.min(6, Math.floor(spanX / (size * 1.18))));
  const cols = Math.min(count, perRow);
  const rows = Math.ceil(count / cols);
  const spacing = Math.min(size * 1.5, Math.max(size * 0.95, (spanX * 0.78) / cols));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const to = {
    x: (col - (cols - 1) / 2) * spacing + (Math.random() - 0.5) * size * 0.24,
    z: (row - (rows - 1) / 2) * size * 1.5 + (Math.random() - 0.5) * size * 0.42,
  };
  const from = { x: to.x + (Math.random() - 0.5) * size * 2.4, z: to.z - size * 2.4 - Math.random() * size * 1.1 };
  const h0 = size * (4.2 + Math.random() * 1.4);

  const mat = new T.MeshStandardMaterial({
    map: die.sides === 6 ? getPipTexture(T) : getNumberTexture(T, die.sides),
    roughness: 0.46,
    metalness: 0.02,
    flatShading: die.sides !== 6,
    transparent: true,
  });
  if (die.drop) mat.color = new T.Color(0xb9bec7); // a dropped die reads dimmer
  // Advantage / Disadvantage: the kept die glows green, the one the roll threw
  // away goes see-through, so the pick is obvious from across the table.
  const dim = die.drop && pick;
  if (dim) mat.opacity = 0.34;
  if (pick && !die.drop) {
    mat.emissive = new T.Color(0x2f9e63);
    mat.emissiveIntensity = 0.55;
  }
  const body = new T.Mesh(dg.geo, mat);
  body.scale.setScalar(size);
  const group = new T.Group();
  group.add(body);
  group.position.set(from.x, h0, from.z);
  world.scene.add(group);

  if (!shadowGeo) shadowGeo = new T.PlaneGeometry(1, 1);
  const shadow = new T.Mesh(shadowGeo, new T.MeshBasicMaterial({ map: getShadowTexture(T), transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(from.x, 0.011, from.z);
  shadow.scale.setScalar(size * 1.7);
  world.scene.add(shadow);

  // A tetrahedron rests on the rolled face, so it cannot show the number from
  // above — it carries a small badge; every other die reads off its own face.
  let badge: SpriteO | null = null;
  if (die.sides === 4) {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 160;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(10, 12, 16, 0.88)';
    ctx.beginPath();
    ctx.arc(80, 80, 66, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BASE;
    ctx.font = '700 66px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(die.value), 80, 84);
    const tx = new T.CanvasTexture(c);
    tx.colorSpace = T.SRGBColorSpace;
    badge = new T.Sprite(new T.SpriteMaterial({ map: tx, transparent: true, opacity: 0, depthWrite: false }));
    badge.scale.set(size * 0.6, size * 0.6, 1);
    badge.position.set(to.x, size * 1.25, to.z);
    world.scene.add(badge);
  }

  const settleQ = settleQuat(T, dg, die.value, die.sides === 4);
  const spinAxis = new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

  return {
    group,
    shadow: shadow as unknown as Obj3D & { material: AnyMat },
    badge,
    mat,
    h0,
    from,
    to,
    spinAxis,
    spinRate: 9 + Math.random() * 7,
    base: dim ? 0.34 : 1,
    settleQ,
    startQ: new T.Quaternion(),
    phase: 0,
    x: from.x,
    y: h0,
    z: from.z,
    drop: !!die.drop,
  };
}

function removeDie(world: World, d: Die) {
  world.scene.remove(d.group, d.shadow);
  if (d.badge) {
    world.scene.remove(d.badge);
    const bm = d.badge.material as unknown as { map?: { dispose(): void }; dispose(): void };
    bm.map?.dispose();
    bm.dispose();
  }
  d.mat.dispose();
  d.shadow.material.dispose();
}

function clearWorld(world: World) {
  if (world.fadeTimer) {
    window.clearTimeout(world.fadeTimer);
    world.fadeTimer = 0;
  }
  for (const d of world.dice) removeDie(world, d);
  world.dice = [];
  if (world.label) {
    world.scene.remove(world.label);
    const lm = world.label.material as unknown as { map?: { dispose(): void }; dispose(): void };
    lm.map?.dispose();
    lm.dispose();
    world.label = null;
  }
}

function tick(world: World) {
  const t = performance.now() - world.start;
  const size = world.dieSize;
  for (const d of world.dice) {
    // Position is a pure function of time, clamped at the landing moment: a
    // stalled frame still leaves the die at rest instead of frozen mid-air.
    const tm = Math.min(t, LAND_MS);
    const u = easeOutCubic(Math.min(1, tm / 620));
    d.x = d.from.x + (d.to.x - d.from.x) * u;
    d.z = d.from.z + (d.to.z - d.from.z) * u;
    d.y = heightAt(tm, d.h0, size);
    if (t < ALIGN_START) {
      d.group.quaternion.setFromAxisAngle(d.spinAxis, d.spinRate * (t / 1000));
    } else {
      if (d.phase === 0) {
        d.phase = 1;
        // Anchor the landing slerp to the FIXED alignment start, not to
        // whichever frame first noticed it: a delayed frame must not shift
        // the alignment window past the idle stop.
        d.startQ.setFromAxisAngle(d.spinAxis, d.spinRate * (ALIGN_START / 1000));
      }
      // The tumble turns into the landing pose while the die is still in the
      // air: the slerp eases out and lands on the value at touchdown, so the
      // die never swivels after coming to rest.
      const ua = Math.min(1, (t - ALIGN_START) / ALIGN_MS);
      d.group.quaternion.slerpQuaternions(d.startQ, d.settleQ, easeOutCubic(ua));
      if (ua >= 1) d.phase = 2;
    }
    if (d.badge && d.phase === 2) {
      const bu = Math.min(1, Math.max(0, (t - LAND_MS) / 160));
      d.badge.material.opacity = bu * d.base;
      const s = size * 0.6 * (0.7 + 0.3 * easeOutCubic(bu));
      d.badge.scale.set(s, s, 1);
    }
    d.group.position.set(d.x, d.y, d.z);
    d.shadow.position.set(d.x, 0.011, d.z);
    const lift = Math.max(0, d.y - size * 0.5);
    d.shadow.scale.setScalar(size * 1.7 * (1 + lift * 0.35));
    d.shadow.material.opacity = 0.32 * Math.max(0.25, 1 - lift / 3);
  }
  if (world.label) {
    const lu = Math.min(1, Math.max(0, (t - LAND_MS) / 200));
    world.label.material.opacity = lu;
  }

  // Settled dice linger a while, then fade so the map stays readable.
  let gone = false;
  if (t > STAY_MS) {
    const f = Math.min(1, (t - STAY_MS) / FADE_MS);
    for (const d of world.dice) {
      const o = d.base * (1 - f);
      d.mat.opacity = o;
      if (d.badge) d.badge.material.opacity = Math.min(d.badge.material.opacity, o);
      else d.shadow.material.opacity = Math.min(d.shadow.material.opacity, 0.32 * o);
      if (f >= 1) gone = true;
    }
    if (world.label) world.label.material.opacity = Math.min(world.label.material.opacity, 1 - f);
  }
  if (gone) clearWorld(world);

  world.renderer.render(world.scene, world.camera);
  placeDiceClose(world);
  if (!world.dice.length) {
    world.raf = 0;
    return;
  }
  // Settled dice would otherwise be redrawn the same way ~600 times while they
  // linger; draw the still frame once and wake up again when the fade is due.
  // Only once every die has finished settling: a stalled frame must never stop
  // the loop with dice still mid-alignment.
  if (t >= IDLE_AT && world.dice.every((d) => d.phase >= 2)) {
    world.raf = 0;
    if (!world.fadeTimer) {
      world.fadeTimer = window.setTimeout(() => {
        world.fadeTimer = 0;
        world.raf = requestAnimationFrame(() => tick(world));
      }, Math.max(30, STAY_MS - t));
    }
    return;
  }
  world.raf = requestAnimationFrame(() => tick(world));
}

let _cv: import('three').Vector3[] | null = null;

/** Keep the dismiss ✕ on the result card's top-right corner while it's up. */
function placeDiceClose(world: World) {
  const el = world.closeEl;
  if (!el) return;
  const spr = world.label;
  if (!spr || spr.material.opacity < 0.85) {
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    return;
  }
  const T = world.T;
  if (!_cv) _cv = [new T.Vector3(), new T.Vector3(), new T.Vector3()];
  const [right, up, v] = _cv;
  right.setFromMatrixColumn(world.camera.matrixWorld, 0);
  up.setFromMatrixColumn(world.camera.matrixWorld, 1);
  // The card art: a 900×200 plate whose top-right corner sits at (872, 20).
  v.copy(spr.position)
    .addScaledVector(right, spr.scale.x * (872 / 900 - 0.5))
    .addScaledVector(up, spr.scale.y * (0.5 - 20 / 200))
    .project(world.camera);
  const w = world.renderer.domElement.clientWidth;
  const h = world.renderer.domElement.clientHeight;
  // The button hangs off the document (so the sheet drawer and other layers
  // can't bury it), and that makes its coordinates viewport ones: the dice
  // layer's origin plus the projected point.
  const lr = world.host.getBoundingClientRect();
  el.style.left = `${(lr.left + (v.x * 0.5 + 0.5) * w).toFixed(1)}px`;
  el.style.top = `${(lr.top + (0.5 - v.y * 0.5) * h).toFixed(1)}px`;
  el.style.opacity = '1';
  el.style.pointerEvents = 'auto';
}

async function ensureWorld(host: HTMLElement): Promise<World> {
  const T = await loadThree();
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearAlpha(0);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.inset = '0';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 1, 0.1, 40);
  camera.position.set(0, 3.05, 5.3);
  camera.lookAt(0, 0.16, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x6a6f7a, 1.25));
  const sun = new T.DirectionalLight(0xffffff, 2.1);
  sun.position.set(2.4, 5, 3.2);
  scene.add(sun);
  const fill = new T.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-3, 2.4, -2.6);
  scene.add(fill);

  const world: World = {
    T,
    host,
    renderer,
    scene,
    camera,
    dice: [],
    label: null,
    raf: 0,
    fadeTimer: 0,
    start: 0,
    dieSize: 0.36,
    observer: null as unknown as ResizeObserver,
    closeEl: null,
  };
  const resize = () => {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Keep the dice the same size ON SCREEN whatever the stage is: the world
    // span the camera sees at the dice plane scales with the aspect ratio.
    world.dieSize = Math.min(0.55, Math.max(0.14, (DIE_PX * VIS_W * (w / h)) / w));
    // While nothing is animating, a resize still needs one fresh frame.
    if (!world.raf && world.dice.length) renderer.render(scene, camera);
    // The dismiss ✕ is placed from the frame: moving the layout moves it.
    if (world.dice.length) placeDiceClose(world);
  };
  world.observer = new ResizeObserver(resize);
  world.observer.observe(host);
  resize();
  // Keep the tab alive through GPU resets: allow the restore and drop the dice
  // (three re-uploads textures on demand).
  renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
  renderer.domElement.addEventListener('webglcontextrestored', () => clearWorld(world));
  return world;
}

/** Tear a world down completely — frames, observers, timers, GL context. */
function disposeWorld(world: World) {
  if (world.raf) cancelAnimationFrame(world.raf);
  world.raf = 0;
  world.observer.disconnect();
  clearWorld(world);
  world.renderer.dispose();
  world.renderer.domElement.remove();
}

export function BoardDiceOverlay({ roll }: { roll: BoardRoll | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const worldRef = useRef<World | null>(null);
  const wantedRef = useRef<BoardRoll | null>(null);
  const playingRef = useRef(false);
  const dismissRef = useRef(false);
  const dismissTimerRef = useRef(0);
  const [dismissing, setDismissing] = useState(false);
  // Bumped on unmount so an initialization that is still in flight knows the
  // board is gone and disposes itself instead of animating a dead canvas.
  const genRef = useRef(0);

  const play = useRef(async () => {
    const host = hostRef.current;
    const want = wantedRef.current;
    if (!host || !want || playingRef.current) return;
    playingRef.current = true;
    const gen = genRef.current;
    try {
      let world = worldRef.current;
      if (!world || world.host !== host) worldRef.current = world = await ensureWorld(host);
      world.closeEl = closeRef.current;
      if (gen !== genRef.current) {
        disposeWorld(world);
        if (worldRef.current === world) worldRef.current = null;
        return;
      }

      // Only the shapes this roll actually uses need building first.
      const wanted = want.dice.slice(0, MAX_DICE).filter((d) => (SHAPES as readonly number[]).includes(d.sides));
      const built = new Map<number, DieGeo>();
      for (const d of wanted) {
        if (built.has(d.sides)) continue;
        const dg = await getDieGeo(world.T, d.sides);
        if (dg) built.set(d.sides, dg);
      }
      if (gen !== genRef.current) return; // the board closed while building
      if (wantedRef.current !== want) return; // a newer roll arrived while building
      if (world.raf) cancelAnimationFrame(world.raf);
      world.raf = 0;
      clearWorld(world);
      const spanX = Math.min(4.6, Math.max(2.0, 3.4 * world.camera.aspect));
      const pick = wanted.some((d) => d.drop);
      let maxZ = -Infinity;
      for (let i = 0; i < wanted.length; i++) {
        const dg = built.get(wanted[i].sides);
        if (!dg) continue;
        const die = spawnDie(world.T, world, dg, wanted[i], i, wanted.length, spanX, pick);
        maxZ = Math.max(maxZ, die.to.z);
        world.dice.push(die);
      }
      if (!world.dice.length) return;
      const card: BoardCard | null = want.card ?? (want.who ? { name: want.who, title: '', expression: '', total: '' } : null);
      if (card) {
        const T = world.T;
        const label = new T.Sprite(
          new T.SpriteMaterial({ map: cardTexture(T, card), transparent: true, opacity: 0, depthWrite: false }),
        );
        label.scale.set(world.dieSize * 4.6, world.dieSize * 1.02, 1);
        label.position.set(0, world.dieSize * 0.35, maxZ + world.dieSize * 2.6);
        world.scene.add(label);
        world.label = label;
      }
      world.start = performance.now();
      world.renderer.render(world.scene, world.camera);
      world.raf = requestAnimationFrame(() => tick(world!));
    } finally {
      playingRef.current = false;
      if (wantedRef.current !== want && wantedRef.current) void play.current();
    }
  });

  useEffect(() => {
    if (!roll) return;
    // A new roll cancels any dismissal still fading out: the old timer must
    // never erase dice that belong to the roll that just arrived.
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = 0;
    }
    dismissRef.current = false;
    setDismissing(false);
    // The chat card already carries the result; the drop is decoration, so it
    // waits for the same preferences the chat dice wait for.
    if (!(useStore.getState().me?.settings.dice_animations ?? true) || reduceMotion()) return;
    wantedRef.current = roll;
    void play.current();
  }, [roll]);

  /** Knock the roll off screen now instead of waiting out the fade. */
  const dismissNow = () => {
    const world = worldRef.current;
    if (!world || dismissRef.current) return;
    const rollAtClick = wantedRef.current;
    dismissRef.current = true;
    setDismissing(true);
    // The raf stops with the world, so hide the ✕ ourselves; the next roll's
    // tick brings it back.
    const el = closeRef.current;
    if (el) {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = 0;
      dismissRef.current = false;
      setDismissing(false);
      // A newer roll took the world over while this one faded: leave it be.
      const live = worldRef.current;
      if (!live || live !== world || wantedRef.current !== rollAtClick) return;
      if (live.raf) cancelAnimationFrame(live.raf);
      live.raf = 0;
      if (live.fadeTimer) {
        clearTimeout(live.fadeTimer);
        live.fadeTimer = 0;
      }
      clearWorld(live);
      // clearWorld just empties the scene — without this frame the canvas
      // would keep showing the last thing drawn.
      live.renderer.render(live.scene, live.camera);
    }, 220);
  };

  useEffect(
    () => () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      genRef.current += 1; // stop an in-flight initialization from landing
      const world = worldRef.current;
      worldRef.current = null;
      if (world) disposeWorld(world);
    },
    [],
  );

  return (
    <div className={`board-dice-layer${dismissing ? ' dismissing' : ''}`} ref={hostRef}>
      {roll &&
        createPortal(
          <button
            type="button"
            className="board-dice-x"
            ref={closeRef}
            aria-label="Dismiss the roll"
            onClick={dismissNow}
            {...tip('Dismiss the roll', 'bottom')}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"
              />
            </svg>
          </button>,
          document.body,
        )}
    </div>
  );
}