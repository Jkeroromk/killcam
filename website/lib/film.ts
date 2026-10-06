// The hero's 3D scene (three.js): a strip of film made of real match stills
// flows out of the distance along a curve. Every couple of seconds one frame
// is marked, lifted off the strip and flown to the front as a highlight card,
// the way KillCam cuts highlights out of a whole match. Games without footage
// on the strip get a typographic card instead.

import type * as T from "three";

type Three = typeof import("three");

export type FilmCard = {
  title: string;
  sub: string;
  game: string;
  tone: "kill" | "objective" | "win" | "multi";
  /** true when the card can show the PUBG footage from the strip */
  footage: boolean;
};

export type FilmOptions = {
  cards: FilmCard[];
  atlas: string;
  /** video for the newest footage card; empty when it shouldn't play */
  video: { src: string; type: string }[];
  still: boolean;
  onReady: () => void;
};

const INK = 0x161a14;
const ATLAS_COLS = 6;
const ATLAS_ROWS = 4;
const STRIP_FRAMES = 22; // atlas cells 0–21 run on the strip
const WIN_FRAME = 23; // the 大吉大利 still

const FRAME_W = 2.0;
const FRAME_H = 1.45;
const IMG_W = 1.62;
const IMG_H = IMG_W * (9 / 16);
const CARD_SCALE = 1.12;

const TONE: Record<FilmCard["tone"], string> = {
  kill: "#e5483b",
  objective: "#bdb48a",
  win: "#e2b93b",
  multi: "#e8e5dc",
};

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Film base with sprocket holes punched out (transparent). */
function sprocketCanvas() {
  const c = document.createElement("canvas");
  c.width = 400;
  c.height = 290;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0d100b";
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-out";
  const holes = 6;
  for (let i = 0; i < holes; i++) {
    const x = (i + 0.5) * (c.width / holes) - 14;
    for (const y of [10, c.height - 32]) {
      g.beginPath();
      g.roundRect(x, y, 28, 22, 5);
      g.fill();
    }
  }
  return c;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Label chip under a footage card: tone bar, title, game and detail. */
function chipCanvas(card: FilmCard, display: string, body: string) {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 132;
  const g = c.getContext("2d")!;
  g.font = `700 64px ${display}`;
  const titleW = g.measureText(card.title).width;
  g.font = `500 28px ${body}`;
  const sub = [card.game, card.sub].filter(Boolean).join(" · ");
  const subW = g.measureText(sub).width;
  const w = Math.min(c.width, 40 + Math.max(titleW, subW) + 36);
  roundRect(g, 0, 0, w, c.height, 14);
  g.fillStyle = "rgba(22, 26, 20, 0.88)";
  g.fill();
  g.fillStyle = TONE[card.tone];
  g.fillRect(0, 0, 10, c.height);
  g.fillStyle = "#e8e5dc";
  g.font = `700 64px ${display}`;
  g.textBaseline = "alphabetic";
  g.fillText(card.title, 36, 70);
  g.fillStyle = "#a6a899";
  g.font = `500 28px ${body}`;
  g.fillText(sub, 36, 112);
  return { canvas: c, aspect: c.width / c.height, used: w / c.width };
}

/** Typographic card for games without footage on the strip. */
function typeCanvas(card: FilmCard, display: string, body: string) {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 360;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, c.width, c.height);
  grd.addColorStop(0, "#272d22");
  grd.addColorStop(1, "#1a1f17");
  g.fillStyle = grd;
  g.fillRect(0, 0, c.width, c.height);
  // a faint map grid, like the page background
  g.strokeStyle = "rgba(232, 229, 220, 0.06)";
  g.lineWidth = 1;
  for (let x = 0; x <= c.width; x += 48) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, c.height);
    g.stroke();
  }
  for (let y = 0; y <= c.height; y += 48) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(c.width, y + 0.5);
    g.stroke();
  }
  g.fillStyle = TONE[card.tone];
  g.fillRect(0, 0, c.width, 8);
  g.fillStyle = "#a6a899";
  g.font = `600 30px ${body}`;
  g.fillText(card.game, 40, 64);
  g.fillStyle = "#e8e5dc";
  let size = 150;
  g.font = `700 ${size}px ${display}`;
  while (g.measureText(card.title).width > c.width - 80 && size > 60) {
    size -= 6;
    g.font = `700 ${size}px ${display}`;
  }
  g.fillText(card.title, 36, 240);
  if (card.sub) {
    g.fillStyle = "#a6a899";
    g.font = `500 30px ${body}`;
    g.fillText(card.sub, 40, 312);
  }
  return c;
}

function atlasUV(geo: T.BufferGeometry, cell: number) {
  const col = cell % ATLAS_COLS;
  const row = Math.floor(cell / ATLAS_COLS);
  const u0 = col / ATLAS_COLS;
  const u1 = (col + 1) / ATLAS_COLS;
  const v1 = 1 - row / ATLAS_ROWS;
  const v0 = 1 - (row + 1) / ATLAS_ROWS;
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
}

type Frame = {
  group: T.Group;
  img: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  base: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  mark: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  cell: number;
  slot: number; // position along the strip, 0..1 (+offset)
  cutAt: number; // time it was cut, or -1
  markAt: number; // time it was marked, or -1
};

type Built = { group: T.Group; dispose: () => void; fade: (o: number) => void; toStill: () => void };

type Card = {
  group: T.Group;
  from: { p: T.Vector3; q: T.Quaternion; s: number };
  born: number;
  slot: number;
  slotFrom: number;
  slotAt: number;
  leaving: number; // time it started leaving, or -1
  phase: number;
  dispose: () => void;
  fade: (o: number) => void;
  toStill: () => void;
};

export function startFilm(THREE: Three, host: HTMLElement, opts: FilmOptions): () => void {
  const phone = () => host.clientWidth < 760;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setClearColor(INK, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, phone() ? 1.5 : 2));
  renderer.domElement.className = "hero-media-el hero-film";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(INK, 9, 30);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80);
  camera.position.set(0, 0, 10);
  // the strip lives in `root`, the cut cards in `deck`; on phones the strip is
  // turned so it crosses the bottom of the screen
  const root = new THREE.Group();
  const deck = new THREE.Group();
  scene.add(root, deck);

  const disposables: { dispose: () => void }[] = [];
  const keep = <D extends { dispose: () => void }>(d: D) => {
    disposables.push(d);
    return d;
  };

  // ---------- textures ----------
  const atlas = keep(new THREE.TextureLoader().load(opts.atlas, () => {
    render();
    opts.onReady();
  }));
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  const sprocket = keep(new THREE.CanvasTexture(sprocketCanvas()));
  sprocket.colorSpace = THREE.SRGBColorSpace;

  let video: HTMLVideoElement | null = null;
  let videoTex: T.VideoTexture | null = null;
  if (opts.video.length && !opts.still) {
    video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    for (const s of opts.video) {
      const src = document.createElement("source");
      src.src = s.src;
      src.type = s.type;
      video.appendChild(src);
    }
    videoTex = keep(new THREE.VideoTexture(video));
    videoTex.colorSpace = THREE.SRGBColorSpace;
    // the loop is 2.36:1; show a 16:9 window from its middle
    const rx = (16 / 9) / (1280 / 542);
    videoTex.repeat.set(rx, 1);
    videoTex.offset.set((1 - rx) / 2, 0);
  }

  // ---------- the strip ----------
  const curve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-9, 6.5, -34),
      new THREE.Vector3(-1.5, 3.6, -18),
      new THREE.Vector3(3.2, 1.2, -8),
      new THREE.Vector3(4.6, -0.9, -1.5),
      new THREE.Vector3(3.6, -2.9, 3.5),
      new THREE.Vector3(1.2, -4.6, 7.5),
    ],
    false,
    "centripetal",
  );
  const length = curve.getLength();
  const count = Math.ceil(length / FRAME_W) + 1;
  const pitch = 1 / count;

  const baseGeo = keep(new THREE.PlaneGeometry(FRAME_W, FRAME_H));
  const markGeo = keep(new THREE.PlaneGeometry(IMG_W + 0.12, IMG_H + 0.12));
  const frames: Frame[] = [];
  let nextCell = 0;
  const takeCell = () => {
    const c = nextCell;
    nextCell = (nextCell + 1) % STRIP_FRAMES;
    return c;
  };

  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(baseGeo, keep(new THREE.MeshBasicMaterial({ map: sprocket, transparent: true, alphaTest: 0.4, fog: true })));
    const imgGeo = keep(new THREE.PlaneGeometry(IMG_W, IMG_H));
    const cell = takeCell();
    atlasUV(imgGeo, cell);
    const img = new THREE.Mesh(imgGeo, keep(new THREE.MeshBasicMaterial({ map: atlas, transparent: true, fog: true })));
    img.position.z = 0.004;
    const mark = new THREE.Mesh(markGeo, keep(new THREE.MeshBasicMaterial({ color: 0xe5483b, transparent: true, opacity: 0, fog: true })));
    mark.position.z = 0.002;
    group.add(base, mark, img);
    root.add(group);
    frames.push({ group, img, base, mark, cell, slot: i * pitch, cutAt: -1, markAt: -1 });
  }

  // ---------- cards ----------
  const display = `${cssVar("--f-display", "Barlow Condensed")}, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif`;
  const body = `${cssVar("--f-body", "Barlow")}, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif`;
  const cards: Card[] = [];
  let cardIndex = 0;

  // where the cut cards hang, front-right of the strip (in root space)
  const slotsWide = [
    { p: new THREE.Vector3(2.35, 1.65, 2.0), r: -0.22 },
    { p: new THREE.Vector3(3.7, 0.4, 0.9), r: -0.38 },
    { p: new THREE.Vector3(2.05, -0.9, 2.4), r: -0.1 },
  ];
  // phones: deck scaled to 0.62, so these are bigger numbers than they look
  const slotsPhone = [
    { p: new THREE.Vector3(-0.8, -2.75, 4.2), r: 0.12 },
    { p: new THREE.Vector3(1.05, -3.9, 3.3), r: -0.22 },
    { p: new THREE.Vector3(-0.95, -4.75, 3.6), r: 0.1 },
  ];
  const slots = () => (phone() ? slotsPhone : slotsWide);

  function makeCard(card: FilmCard, frame: Frame | null, live: boolean): Built {
    const group = new THREE.Group();
    const own: { dispose: () => void }[] = [];
    const mats: T.MeshBasicMaterial[] = [];
    const W = IMG_W * CARD_SCALE;
    const H = IMG_H * CARD_SCALE;
    const edgeGeo = new THREE.PlaneGeometry(W + 0.035, H + 0.035);
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(TONE[card.tone]), transparent: true });
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    own.push(edgeGeo, edgeMat);
    mats.push(edgeMat);
    group.add(edge);

    const faceGeo = new THREE.PlaneGeometry(W, H);
    let faceMat: T.MeshBasicMaterial;
    const stillCell = card.tone === "win" ? WIN_FRAME : (frame?.cell ?? 12);
    let toStill = () => {};
    if (card.footage) {
      if (live && videoTex && card.tone !== "win") {
        faceMat = new THREE.MeshBasicMaterial({ map: videoTex, transparent: true });
        // once a newer card arrives this one shows its still instead
        toStill = () => {
          atlasUV(faceGeo, stillCell);
          faceMat.map = atlas;
          faceMat.needsUpdate = true;
          toStill = () => {};
        };
      } else {
        atlasUV(faceGeo, stillCell);
        faceMat = new THREE.MeshBasicMaterial({ map: atlas, transparent: true });
      }
      const chip = chipCanvas(card, display, body);
      const chipTex = new THREE.CanvasTexture(chip.canvas);
      chipTex.colorSpace = THREE.SRGBColorSpace;
      const ch = 0.36;
      const chipGeo = new THREE.PlaneGeometry(ch * chip.aspect, ch);
      const chipMat = new THREE.MeshBasicMaterial({ map: chipTex, transparent: true });
      const chipMesh = new THREE.Mesh(chipGeo, chipMat);
      chipMesh.position.set(-W / 2 + (ch * chip.aspect) / 2 - 0.1, -H / 2 - ch * 0.42, 0.03);
      own.push(chipTex, chipGeo, chipMat);
      mats.push(chipMat);
      group.add(chipMesh);
    } else {
      const tex = new THREE.CanvasTexture(typeCanvas(card, display, body));
      tex.colorSpace = THREE.SRGBColorSpace;
      own.push(tex);
      faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    }
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.z = 0.01;
    own.push(faceGeo, faceMat);
    mats.push(faceMat);
    group.add(face);
    return {
      group,
      dispose: () => own.forEach((d) => d.dispose()),
      fade: (o: number) => mats.forEach((m) => (m.opacity = o)),
      toStill: () => toStill(),
    };
  }

  const tmpP = new THREE.Vector3();
  const tmpT = new THREE.Vector3();
  const tmpZ = new THREE.Vector3();
  const tmpY = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const camLocal = new THREE.Vector3();

  /** Place a frame at strip position u (0 far … 1 near), facing the camera. */
  function placeFrame(f: Frame, u: number) {
    // getPointAt overshoots the last point for u right at 1
    u = Math.min(0.999, Math.max(0, u));
    curve.getPointAt(u, tmpP);
    curve.getTangentAt(u, tmpT).normalize();
    camLocal.copy(camera.position);
    root.worldToLocal(camLocal);
    tmpZ.copy(camLocal).sub(tmpP).normalize();
    tmpZ.addScaledVector(tmpT, -tmpZ.dot(tmpT)).normalize();
    tmpY.crossVectors(tmpZ, tmpT);
    tmpM.makeBasis(tmpT, tmpY, tmpZ);
    f.group.position.copy(tmpP);
    f.group.quaternion.setFromRotationMatrix(tmpM);
    // fade in out of the fog, fade out before it reaches the camera
    const o = Math.min(1, u / 0.08, (1 - u) / 0.12);
    f.base.material.opacity = o;
    f.img.material.opacity = f.cutAt >= 0 ? 0.08 * o : o;
  }

  function slotPose(i: number, t: number, phase: number, out: { p: T.Vector3; q: T.Quaternion }) {
    const s = slots()[Math.min(i, 2)];
    out.p.copy(s.p);
    out.p.y += Math.sin(t * 0.9 + phase) * 0.06;
    const e = new THREE.Euler(Math.sin(t * 0.7 + phase) * 0.04, s.r + Math.sin(t * 0.5 + phase) * 0.05, Math.sin(t * 0.6 + phase) * 0.02);
    out.q.setFromEuler(e);
  }

  // ---------- layout ----------
  function layout() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (phone()) {
      camera.fov = 52;
      root.position.set(1.6, -4.9, -2.5);
      root.rotation.set(0, 0, 0.62);
      root.scale.setScalar(0.8);
      deck.position.set(0, 0, 0);
      deck.scale.setScalar(0.62);
    } else {
      camera.fov = 36;
      // keep the strip to the right of the headline on wide screens
      const shift = Math.min(1.4, Math.max(0, (camera.aspect - 1.3) * 1.1));
      root.position.set(shift, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.setScalar(1);
      deck.position.set(shift, 0, 0);
      deck.scale.setScalar(1);
    }
    camera.updateProjectionMatrix();
    render();
  }

  // ---------- motion ----------
  let offset = 0;
  let last = performance.now();
  let clock = 0;
  let nextCut = 1.4;
  let pointerX = 0;
  let pointerY = 0;
  let scrollP = 0;
  const SPEED = 0.55 / length; // strip units per second
  const MARK_FOR = 0.55;
  const FLY_FOR = 1.25;
  const SHIFT_FOR = 0.9;
  const LEAVE_FOR = 0.8;

  function cut(t: number) {
    // the frame nearest the middle of the visible stretch
    let best: Frame | null = null;
    let bestD = Infinity;
    for (const f of frames) {
      if (f.cutAt >= 0 || f.markAt >= 0) continue;
      const u = (f.slot + offset) % 1;
      const d = Math.abs(u - 0.6);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (best) best.markAt = t;
  }

  function spawnFrom(f: Frame, t: number) {
    const card = opts.cards[cardIndex++ % opts.cards.length];
    // older cards move back one slot; the oldest leaves
    for (const c of cards) {
      if (c.leaving >= 0) continue;
      c.toStill();
      if (c.slot >= 2) c.leaving = t;
      else {
        c.slotFrom = c.slot;
        c.slot += 1;
        c.slotAt = t;
      }
    }
    // only the newest footage card plays the video
    const { group, dispose, fade, toStill } = makeCard(card, f, card.footage);
    f.group.updateMatrixWorld();
    const from = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1 / CARD_SCALE };
    f.group.getWorldPosition(from.p);
    deck.worldToLocal(from.p);
    f.group.getWorldQuaternion(from.q);
    from.q.premultiply(deck.getWorldQuaternion(new THREE.Quaternion()).invert());
    // the strip may be scaled on phones; start the card at the frame's size
    from.s = (root.scale.x / deck.scale.x) / CARD_SCALE;
    group.position.copy(from.p);
    group.quaternion.copy(from.q);
    group.scale.setScalar(from.s);
    deck.add(group);
    cards.push({ group, from, born: t, slot: 0, slotFrom: -1, slotAt: t, leaving: -1, phase: Math.random() * 6, dispose, fade, toStill });
  }

  const pose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const pose2 = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

  function step(dt: number) {
    clock += dt;
    offset = (offset + dt * SPEED) % 1;

    for (const f of frames) {
      let u = f.slot + offset;
      if (u >= 1) u -= 1;
      // a frame wrapping back to the far end gets a fresh still
      if (f.cutAt >= 0 && u < 0.05 && clock - f.cutAt > 2) {
        f.cutAt = -1;
        f.cell = takeCell();
        atlasUV(f.img.geometry, f.cell);
      }
      if (f.markAt >= 0) {
        const k = (clock - f.markAt) / MARK_FOR;
        f.mark.material.opacity = Math.min(1, k * 2) * (k < 1 ? 1 : Math.max(0, 1 - (k - 1) * 4));
        if (k >= 1 && f.cutAt < 0) {
          f.cutAt = clock;
          spawnFrom(f, clock);
        }
        if (k > 1.3) {
          f.markAt = -1;
          f.mark.material.opacity = 0;
        }
      }
      placeFrame(f, u);
    }

    if (clock >= nextCut) {
      cut(clock);
      nextCut = clock + 2.6;
    }

    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      const g = c.group;
      if (c.leaving >= 0) {
        const k = Math.min(1, (clock - c.leaving) / LEAVE_FOR);
        slotPose(2, clock, c.phase, pose);
        g.position.copy(pose.p).add(new THREE.Vector3(0.6 * k, 1.2 * easeOut(k), -1.5 * k));
        g.quaternion.copy(pose.q);
        c.fade(1 - k);
        if (k >= 1) {
          deck.remove(g);
          c.dispose();
          cards.splice(i, 1);
        }
        continue;
      }
      slotPose(c.slot, clock, c.phase, pose);
      if (c.slotFrom < 0) {
        // flying out of the strip
        const k = Math.min(1, (clock - c.born) / FLY_FOR);
        const e = easeInOut(k);
        g.position.lerpVectors(c.from.p, pose.p, e);
        g.position.z += Math.sin(Math.PI * e) * 0.9;
        g.quaternion.slerpQuaternions(c.from.q, pose.q, e);
        g.scale.setScalar(c.from.s + (1 - c.from.s) * e);
      } else {
        const k = Math.min(1, (clock - c.slotAt) / SHIFT_FOR);
        slotPose(c.slotFrom, clock, c.phase, pose2);
        const e = easeInOut(k);
        g.position.lerpVectors(pose2.p, pose.p, e);
        g.quaternion.slerpQuaternions(pose2.q, pose.q, e);
        g.scale.setScalar(1);
      }
    }

    // camera: a little parallax with the pointer, and a push in as the hero scrolls away
    const tx = pointerX * 0.45;
    const ty = -pointerY * 0.3 + scrollP * 0.6;
    camera.position.x += (tx - camera.position.x) * Math.min(1, dt * 3);
    camera.position.y += (ty - camera.position.y) * Math.min(1, dt * 3);
    camera.position.z = 10 - scrollP * 2.2;
    camera.lookAt(0.4, 0, 0);
  }

  function render() {
    renderer.render(scene, camera);
  }

  // a still composition: three cards already hanging, nothing moving
  function still() {
    camera.lookAt(0.4, 0, 0);
    for (const f of frames) placeFrame(f, f.slot);
    for (let i = 0; i < 3; i++) {
      const card = opts.cards[i % opts.cards.length];
      const b = makeCard(card, frames[(i * 3 + 4) % frames.length], false);
      slotPose(2 - i, 0, i, pose);
      b.group.position.copy(pose.p);
      b.group.quaternion.copy(pose.q);
      deck.add(b.group);
      cards.push({ group: b.group, from: { p: pose.p.clone(), q: pose.q.clone(), s: 1 }, born: -9, slot: 2 - i, slotFrom: -1, slotAt: 0, leaving: -1, phase: i, dispose: b.dispose, fade: b.fade, toStill: b.toStill });
    }
    render();
  }

  // ---------- loop and lifecycle ----------
  let running = false;
  let visible = true;
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    render();
  };
  const sync = () => {
    const want = !opts.still && visible && !document.hidden;
    if (want && !running) {
      running = true;
      last = performance.now();
      renderer.setAnimationLoop(loop);
      video?.play().catch(() => {});
    } else if (!want && running) {
      running = false;
      renderer.setAnimationLoop(null);
      video?.pause();
    }
  };

  const ro = new ResizeObserver(() => {
    layout();
    if (opts.still) still2();
  });
  // re-render the still composition after a resize
  let stillBuilt = false;
  const still2 = () => {
    if (!stillBuilt) {
      stillBuilt = true;
      still();
    } else render();
  };
  ro.observe(host);
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  });
  io.observe(host);
  const onVis = () => sync();
  document.addEventListener("visibilitychange", onVis);
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    pointerX = (e.clientX / window.innerWidth) * 2 - 1;
    pointerY = (e.clientY / window.innerHeight) * 2 - 1;
  };
  const onScroll = () => {
    const r = host.getBoundingClientRect();
    scrollP = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  layout();
  // labels need the web fonts; draw cards only after they're in
  document.fonts.ready.then(() => {
    if (opts.still) still2();
    else sync();
  });

  return () => {
    renderer.setAnimationLoop(null);
    ro.disconnect();
    io.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("scroll", onScroll);
    for (const c of cards) c.dispose();
    disposables.forEach((d) => d.dispose());
    renderer.dispose();
    renderer.domElement.remove();
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  };
}
