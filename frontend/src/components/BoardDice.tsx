/** The 3D dice that drop onto the game board when somebody rolls. The result
 * always comes from the server (the roll was already made — see lib/rolls), so
 * this layer only has to make the dice agree with it: they tumble in, settle on
 * that value, and linger for a moment. Everyone at the table sees the same
 * numbers because everyone plays the same roll message.
 *
 * three.js and the D6 mesh load lazily on the first roll — the board costs
 * nothing until dice are actually used. The D6 mesh and its textures are
 * JDSherbert's (free pack, see public/dice/CREDIT.txt); the other dice are
 * drawn procedurally with the value shown on a badge. */
import { useEffect, useRef } from 'react';

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
}

type Three = typeof import('three');
type Geo = import('three').BufferGeometry;
type Mat = import('three').MeshStandardMaterial;
/** Any three material that fades: used for badges and the soft shadows. */
type AnyMat = import('three').Material & { opacity: number };
type MeshO = import('three').Mesh;
type Obj3D = import('three').Object3D;
type SpriteO = import('three').Sprite;

/** Anything past this many dice still rolls; the extras just skip the drop. */
const MAX_DICE = 12;
const DIE_SIZE = 0.62;
/** Tumble until this long after the roll, then settle onto the value. */
const SETTLE_MS = 1250;
const SETTLE_LERP_MS = 380;
/** Settled dice stay this long, then fade out. */
const STAY_MS = 12000;
const FADE_MS = 750;

/**
 * Which local axis of the D6 mesh shows each value. Calibrated against the
 * shipped mesh by rendering each axis face-on and counting the pips on it:
 * +X=1, +Y=2, -Z=3, +Z=4, -Y=5, -X=6 (opposites sum to 7, as a real die).
 * Settling aims this axis at +Y (up), so the top face the player reads is the
 * rolled value.
 */
const D6_UP: Record<number, [number, number, number]> = {
  1: [1, 0, 0],
  2: [0, 1, 0],
  3: [0, 0, -1],
  4: [0, 0, 1],
  5: [0, -1, 0],
  6: [-1, 0, 0],
};

// ---------------------------------------------------------------------------
// Shared resources (module scope: they survive board remounts)
// ---------------------------------------------------------------------------

let threePromise: Promise<Three> | null = null;
function loadThree(): Promise<Three> {
  threePromise ??= import('three');
  return threePromise;
}

let d6SourcePromise: Promise<Obj3D> | null = null;
/** The D6 mesh as a holder whose centre is the origin, one DIE_SIZE across. */
function loadD6Source(T: Three): Promise<Obj3D> {
  d6SourcePromise ??= (async () => {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const group = await new OBJLoader().loadAsync('/dice/D6.obj');
    const tex = new T.TextureLoader();
    const [albedo, normal] = await Promise.all([tex.loadAsync('/dice/D6-albedo.png'), tex.loadAsync('/dice/D6-normal.png')]);
    albedo.colorSpace = T.SRGBColorSpace;
    const mat = new T.MeshStandardMaterial({ map: albedo, normalMap: normal, roughness: 0.55, metalness: 0.02 });
    group.traverse((o) => {
      const m = o as MeshO;
      if (m.isMesh) m.material = mat;
    });
    const box = new T.Box3().setFromObject(group);
    const size = box.getSize(new T.Vector3());
    const centre = box.getCenter(new T.Vector3());
    const k = DIE_SIZE / Math.max(size.x, size.y, size.z);
    const holder = new T.Group();
    group.scale.setScalar(k);
    group.position.copy(centre.multiplyScalar(-k));
    holder.add(group);
    return holder;
  })();
  return d6SourcePromise;
}

/** A pentagonal bipyramid: the readable stand-in for a ten-sided die. */
function polyGeo(T: Three, sides: number): Geo {
  const r = 0.46;
  if (sides === 4) return new T.TetrahedronGeometry(r * 1.2);
  if (sides === 8) return new T.OctahedronGeometry(r);
  if (sides === 12) return new T.DodecahedronGeometry(r);
  if (sides === 20) return new T.IcosahedronGeometry(r);
  const parts: number[] = [];
  const ring: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    ring.push([Math.cos(a) * 0.52, 0, Math.sin(a) * 0.52]);
  }
  const top = [0, 0.6, 0];
  const bottom = [0, -0.6, 0];
  for (let i = 0; i < 5; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 5];
    parts.push(...top, ...a, ...b, ...bottom, ...b, ...a);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(parts, 3));
  g.computeVertexNormals();
  return g;
}

function badgeTexture(T: Three, text: string): import('three').Texture {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  const x = 18;
  const y = 32;
  const w = 124;
  const h = 96;
  const r = 26;
  ctx.fillStyle = 'rgba(10, 12, 16, 0.88)';
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f2f4f8';
  ctx.font = '700 60px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
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

let shadowGeo: Geo | null = null;

// ---------------------------------------------------------------------------
// The drop
// ---------------------------------------------------------------------------

interface Die {
  group: Obj3D;
  body: MeshO;
  shadow: MeshO;
  badge?: SpriteO;
  mat: Mat;
  ownGeo: boolean;
  h0: number;
  from: { x: number; z: number };
  to: { x: number; z: number };
  spinAxis: import('three').Vector3;
  spinRate: number;
  settleQ: import('three').Quaternion;
  startQ: import('three').Quaternion;
  spinAt: number;
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
  raf: number;
  start: number;
  meshSource: Obj3D | null;
  meshPromise: Promise<void> | null;
  observer: ResizeObserver;
}

const easeOutCubic = (u: number) => 1 - Math.pow(1 - u, 3);

/** Height of a die above the floor at t (ms): a drop and two small bounces. */
function heightAt(t: number, h0: number): number {
  const rest = DIE_SIZE * 0.5;
  if (t < 620) {
    const u = t / 620;
    return h0 - (h0 - rest) * u * u;
  }
  if (t < 960) {
    const u = (t - 620) / 340;
    return rest + DIE_SIZE * 0.55 * Math.sin(Math.PI * u) * (1 - u * 0.25);
  }
  if (t < 1240) {
    const u = (t - 960) / 280;
    return rest + DIE_SIZE * 0.16 * Math.sin(Math.PI * u) * (1 - u * 0.4);
  }
  return rest;
}

function firstMesh(o: Obj3D): MeshO {
  const m = o as MeshO;
  if (m.isMesh) return m;
  for (const child of o.children) {
    const found = firstMesh(child);
    if (found) return found;
  }
  return o as unknown as MeshO;
}

function spawnDie(T: Three, world: World, die: BoardDie, index: number, count: number, spanX: number): Die {
  // Lay the dice out inside the width the camera can actually show: a wide
  // stage fits six in a row, a narrow one wraps to more rows.
  const perRow = Math.max(1, Math.min(6, Math.floor(spanX / 0.72)));
  const cols = Math.min(count, perRow);
  const rows = Math.ceil(count / cols);
  const spacing = Math.min(0.95, Math.max(0.55, (spanX * 0.78) / cols));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const to = { x: (col - (cols - 1) / 2) * spacing + (Math.random() - 0.5) * 0.14, z: (row - (rows - 1) / 2) * 0.98 + (Math.random() - 0.5) * 0.26 };
  const from = { x: to.x + (Math.random() - 0.5) * 1.5, z: to.z - 1.5 - Math.random() * 0.7 };
  const h0 = 2.6 + Math.random() * 0.9;

  let body: MeshO;
  let mat: Mat;
  let ownGeo = false;
  if (die.sides === 6 && world.meshSource) {
    const inner = (world.meshSource as Obj3D).children[0];
    body = inner.clone(true) as unknown as MeshO;
    // Shared geometry, private material: fades and dimming never touch the
    // other dice (or the source).
    body.traverse((o) => {
      const m = o as MeshO;
      if (m.isMesh) m.material = (m.material as Mat).clone();
    });
    mat = firstMesh(body).material as Mat;
  } else {
    mat = new T.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.48, metalness: 0.02, flatShading: true, transparent: true });
    const geo = die.sides === 6 ? new T.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE) : polyGeo(T, die.sides);
    body = new T.Mesh(geo, mat);
    ownGeo = true;
  }
  mat.transparent = true;
  if (die.drop) mat.color = new T.Color(0xb9bec7); // a dropped die reads dimmer

  const group = new T.Group();
  group.add(body);
  group.position.set(from.x, h0, from.z);
  world.scene.add(group);

  if (!shadowGeo) shadowGeo = new T.PlaneGeometry(1, 1);
  const shadow = new T.Mesh(shadowGeo, new T.MeshBasicMaterial({ map: getShadowTexture(T), transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(from.x, 0.011, from.z);
  shadow.scale.setScalar(DIE_SIZE * 1.7);
  world.scene.add(shadow);

  // Cube dice show the value on the face itself; the rest carry a badge.
  let badge: SpriteO | undefined;
  if (die.sides !== 6) {
    badge = new T.Sprite(new T.SpriteMaterial({ map: badgeTexture(T, String(die.value)), transparent: true, opacity: 0, depthWrite: false }));
    badge.scale.set(0.46, 0.46, 1);
    badge.position.set(to.x, DIE_SIZE * 0.5 + 0.5, to.z);
    world.scene.add(badge);
  }

  const axis = D6_UP[((die.value - 1) % 6) + 1] ?? [0, 1, 0];
  const faceQ = new T.Quaternion().setFromUnitVectors(new T.Vector3(axis[0], axis[1], axis[2]).normalize(), new T.Vector3(0, 1, 0));
  const yaw = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
  const settleQ = die.sides === 6 ? yaw.clone().multiply(faceQ) : yaw;
  const spinAxis = new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

  return {
    group,
    body,
    shadow,
    badge,
    mat,
    ownGeo,
    h0,
    from,
    to,
    spinAxis,
    spinRate: 9 + Math.random() * 7,
    settleQ,
    startQ: new T.Quaternion(),
    spinAt: -1,
    phase: 0,
    x: from.x,
    y: h0,
    z: from.z,
    drop: !!die.drop,
  };
}

function removeDie(world: World, d: Die) {
  world.scene.remove(d.group, d.shadow);
  if (d.badge) world.scene.remove(d.badge);
  if (d.ownGeo) d.body.geometry.dispose();
  d.mat.dispose();
  (d.shadow.material as AnyMat).dispose();
  if (d.badge) {
    const bm = d.badge.material as unknown as { map?: { dispose(): void }; dispose(): void };
    bm.map?.dispose();
    bm.dispose();
  }
}

function clearWorld(world: World) {
  for (const d of world.dice) removeDie(world, d);
  world.dice = [];
}

function tick(world: World) {
  const t = performance.now() - world.start;
  for (const d of world.dice) {
    if (t < 1240) {
      const u = easeOutCubic(Math.min(1, t / 620));
      d.x = d.from.x + (d.to.x - d.from.x) * u;
      d.z = d.from.z + (d.to.z - d.from.z) * u;
      d.y = heightAt(t, d.h0);
    }
    if (t < SETTLE_MS) {
      d.group.quaternion.setFromAxisAngle(d.spinAxis, d.spinRate * (t / 1000));
    } else {
      if (d.phase === 0) {
        d.phase = 1;
        d.spinAt = t;
        d.startQ.copy(d.group.quaternion);
      }
      const u = Math.min(1, (t - d.spinAt) / SETTLE_LERP_MS);
      d.group.quaternion.slerpQuaternions(d.startQ, d.settleQ, easeOutCubic(u));
      if (u >= 1) d.phase = 2;
    }
    if (d.badge && d.phase === 2) {
      const bu = Math.min(1, Math.max(0, (t - d.spinAt - SETTLE_LERP_MS) / 160));
      d.badge.material.opacity = bu;
      const s = 0.46 * (0.7 + 0.3 * easeOutCubic(bu));
      d.badge.scale.set(s, s, 1);
    }
    d.group.position.set(d.x, d.y, d.z);
    d.shadow.position.set(d.x, 0.011, d.z);
    const lift = Math.max(0, d.y - DIE_SIZE * 0.5);
    d.shadow.scale.setScalar(DIE_SIZE * 1.7 * (1 + lift * 0.35));
    (d.shadow.material as AnyMat).opacity = 0.32 * Math.max(0.25, 1 - lift / 3);
  }

  // Settled dice linger a while, then fade so the map stays readable.
  let gone = false;
  if (t > STAY_MS) {
    const f = Math.min(1, (t - STAY_MS) / FADE_MS);
    for (const d of world.dice) {
      const o = d.drop ? (1 - f) * 0.85 : 1 - f;
      d.mat.opacity = o;
      if (d.badge) d.badge.material.opacity = Math.min(d.badge.material.opacity, o);
      else (d.shadow.material as AnyMat).opacity *= 0.93;
      if (f >= 1) gone = true;
    }
  }
  if (gone) clearWorld(world);

  world.renderer.render(world.scene, world.camera);
  world.raf = world.dice.length ? requestAnimationFrame(() => tick(world)) : 0;
}

async function ensureWorld(host: HTMLElement): Promise<World> {
  const T = await loadThree();
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearAlpha(0);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.inset = '0';
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
    raf: 0,
    start: 0,
    meshSource: null,
    meshPromise: null,
    observer: null as unknown as ResizeObserver,
  };
  const resize = () => {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  world.observer = new ResizeObserver(resize);
  world.observer.observe(host);
  resize();
  // Keep the tab alive through GPU resets: allow the restore, drop the dice
  // (three re-uploads textures on demand), and warm the D6 mesh so the first
  // d6 roll does not sit on the network.
  renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
  renderer.domElement.addEventListener('webglcontextrestored', () => clearWorld(world));
  void loadD6Source(T).catch(() => {
    /* no mesh: the cubes fall back to plain boxes */
  });
  return world;
}

export function BoardDiceOverlay({ roll }: { roll: BoardRoll | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const wantedRef = useRef<BoardRoll | null>(null);
  const playingRef = useRef(false);

  const play = useRef(async () => {
    const host = hostRef.current;
    const want = wantedRef.current;
    if (!host || !want || playingRef.current) return;
    playingRef.current = true;
    try {
      let world = worldRef.current;
      if (!world || world.host !== host) worldRef.current = world = await ensureWorld(host);
      if (!world.meshPromise) {
        world.meshPromise = loadD6Source(world.T)
          .then((src) => {
            world!.meshSource = src;
          })
          .catch(() => {
            /* no mesh: the cubes fall back to plain boxes */
          });
      }
      if (want.dice.some((d) => d.sides === 6)) await world.meshPromise;
      if (wantedRef.current !== want) return; // a newer roll arrived while loading
      if (world.raf) cancelAnimationFrame(world.raf);
      world.raf = 0;
      clearWorld(world);
      const dice = want.dice.slice(0, MAX_DICE);
      const spanX = Math.min(4.6, Math.max(2.0, 3.4 * world.camera.aspect));
      dice.forEach((d, i) => world!.dice.push(spawnDie(world!.T, world!, d, i, dice.length, spanX)));
      if (!world.dice.length) return;
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
    wantedRef.current = roll;
    void play.current();
  }, [roll]);

  useEffect(
    () => () => {
      const world = worldRef.current;
      if (world) {
        if (world.raf) cancelAnimationFrame(world.raf);
        world.observer?.disconnect();
        clearWorld(world);
        world.renderer.dispose();
        world.renderer.domElement.remove();
      }
      worldRef.current = null;
    },
    [],
  );

  return <div className="board-dice-layer" ref={hostRef} aria-hidden="true" />;
}
