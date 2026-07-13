import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { OpponentDef } from './config';

// ---------------------------------------------------------------------------
// PS1 rendering pipeline.
// Authenticity checklist (real hardware behaviors, not filters slapped on):
//  - Native low resolution (PSX was 320x240) rendered to an RT, nearest-upscaled
//  - Vertex snapping: the GTE worked in fixed point -> vertices pop to a grid
//  - No per-pixel lighting: vertex-lit, flat/gouraud shading only
//  - 15-bit color + ordered dithering (the PSX dithered to hide banding)
//  - Tiny point-filtered textures (no mips, no bilinear smear)
//  - Aggressive fog to hide the short draw distance
// ---------------------------------------------------------------------------

const PSX_H = 240; // vertical native res; width follows aspect

const snapChunk = /* glsl */ `
  vec4 snapToGrid(vec4 clip) {
    vec2 grid = uPsxRes / 2.0;
    clip.xy = floor(clip.xy / clip.w * grid + 0.5) / grid * clip.w;
    return clip;
  }
`;

/** Patch a material to snap vertices like the PSX GTE. */
function psxify(mat: THREE.Material, res: THREE.Vector2) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPsxRes = { value: res };
    shader.vertexShader = 'uniform vec2 uPsxRes;\n' + snapChunk +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n gl_Position = snapToGrid(gl_Position);'
      );
  };
}

// Fullscreen composite: 15-bit color crush + 4x4 Bayer dither, like the PSX GPU.
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  varying vec2 vUv;
  const mat4 bayer = mat4(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    c = pow(c, vec3(0.4545));                 // linear RT -> sRGB out
    ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
    float d = (bayer[p.x][p.y] / 16.0 - 0.5) / 32.0;
    c = floor((c + d) * 31.0 + 0.5) / 31.0;   // 5 bits per channel
    gl_FragColor = vec4(c, 1.0);
  }
`;

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKIES: Record<string, { top: number; bottom: number; fog: number; ambient: number; sun: number }> = {
  day:    { top: 0x4a9ae0, bottom: 0xcfe8f0, fog: 0xbcd8e4, ambient: 0xffffff, sun: 2.2 },
  night:  { top: 0x0a0a1e, bottom: 0x1e1436, fog: 0x14102a, ambient: 0x8888aa, sun: 0.7 },
  sunset: { top: 0x2a1a4a, bottom: 0xd86a3a, fog: 0x8a5a4a, ambient: 0xffd8b0, sun: 1.6 },
  vapor:  { top: 0x1a0a3e, bottom: 0xe83a9a, fog: 0x5a2a6e, ambient: 0xcc99dd, sun: 1.0 },
  fog:    { top: 0x9aa4ac, bottom: 0xb8c0c6, fog: 0xaab4bc, ambient: 0xd8dde2, sun: 1.2 },
  dawn:   { top: 0x4a5a9e, bottom: 0xe8a86a, fog: 0xc0a898, ambient: 0xf0d8c8, sun: 1.8 },
  storm:  { top: 0x2a3038, bottom: 0x4a545e, fog: 0x3a444e, ambient: 0x9aa8b4, sun: 0.9 },
  toxic:  { top: 0x2a3a16, bottom: 0x8aa832, fog: 0x5a7024, ambient: 0xc0d088, sun: 1.3 },
  noir:   { top: 0x0c0c10, bottom: 0x2e2e36, fog: 0x1a1a20, ambient: 0xb8b8c4, sun: 1.1 },
  mint:   { top: 0x4ac0a0, bottom: 0xd8f0e0, fog: 0xb0e0cc, ambient: 0xf0fff8, sun: 2.0 },
};

export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private compScene = new THREE.Scene();
  private compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private psxRes = new THREE.Vector2(320, 240);

  private static readonly SPACING = 60;       // distance between red lights
  // vertical world-height the eye-contact view frames at the opponent's
  // distance — the FOV is derived from this so the driver stays the same
  // prominent size on any screen shape (portrait phones included)
  private static readonly FRAME_H = 4.7;
  private opponentGroup = new THREE.Group();  // car + goop, shaken as a unit
  private opponentAnchor = new THREE.Group(); // world placement
  private nextAnchor = new THREE.Group();     // next rival, staged at the next light
  private goopGroup = new THREE.Group();
  private intersections: { group: THREE.Group; lamps: THREE.MeshBasicMaterial[] }[] = [];
  private curI = 0;
  private scrollers: { obj: THREE.Object3D; span: number }[] = [];
  private driveS = 0;
  private sprite: THREE.Object3D | null = null; // 2D driver billboard
  private spriteSlot = '';
  private spriteAnger = -1;
  private spriteHasCustom = false;
  private driverScale = 0.65; // sprite scale for the current opponent (per cabin)
  private spritePos = new THREE.Vector3();
  private lampMats: THREE.MeshBasicMaterial[] = [];
  private dashDecal: THREE.Mesh | null = null;
  private ornament: THREE.Mesh | null = null;
  private hemi: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private skyMesh: THREE.Mesh;

  private shakeAmp = 0.01;
  private pulse = 0;
  private splats: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private driving = false;
  private driveT = 0;
  private onDriveDone: (() => void) | null = null;
  private time = 0;
  private cockpit!: THREE.Group;
  private gaze: 'opponent' | 'road' = 'opponent';
  // must be a Camera: Camera.lookAt aims -z (view direction), Object3D aims +z
  private gazeHelper = new THREE.PerspectiveCamera();

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets us grab devlog screenshots off the canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);

    this.camera = new THREE.PerspectiveCamera(62, 4 / 3, 0.1, 60);
    // Driver's seat POV on a one-way 4-lane road. Player parked in a center
    // lane (x=+2), opponent in the adjacent lane (x=-2) — parallel, side by
    // side, both stopped at the light. The camera (your head) turns: toward
    // the opponent while the light is red, back to the road when it's green.
    this.camera.position.set(1.55, 1.25, 0); // left (driver's) seat of the lane-2 car
    this.camera.lookAt(-2.45, 1.3, -0.55);   // straight across at the neighbor

    this.scene.fog = new THREE.Fog(SKIES.day.fog, 10, 55);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x556677, 2.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, SKIES.day.sun);
    this.sun.position.set(4, 8, 2);
    this.scene.add(this.sun);

    this.rt = new THREE.WebGLRenderTarget(320, PSX_H, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    const compMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: this.rt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
    });
    this.compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat));

    this.skyMesh = this.buildSky();
    this.scene.add(this.skyMesh);
    this.buildWorld();
    this.buildCockpit();

    // Adjacent lane, truly ABREAST: both front bumpers even at the stop
    // line, drivers side by side. The CAR faces forward; only the driver's
    // head faces you. (setOpponent adjusts z per body length so every
    // style's nose lines up with yours.)
    this.opponentAnchor.position.set(-2, 0, -0.4);
    this.opponentAnchor.rotation.y = Math.PI; // headlights toward the intersection
    this.opponentAnchor.add(this.opponentGroup);
    this.scene.add(this.opponentAnchor);
    // staging anchor for the NEXT rival, parked at the next light down the road
    this.nextAnchor.rotation.y = Math.PI;
    this.nextAnchor.position.set(-2, 0, -GameScene.SPACING);
    this.scene.add(this.nextAnchor);
    this.setSky('day');

    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  private mat(color: number, opts: Partial<THREE.MeshLambertMaterialParameters> = {}): THREE.MeshLambertMaterial {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts } as THREE.MeshLambertMaterialParameters);
    psxify(m, this.psxRes);
    return m;
  }

  // ---- world ---------------------------------------------------------------
  private buildSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(50, 12, 8);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(SKIES.night.top) },
        bottom: { value: new THREE.Color(SKIES.night.bottom) },
      },
      vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ gl_FragColor = vec4(mix(bottom, top, clamp(h*1.6+0.3,0.0,1.0)), 1.0); }',
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    return new THREE.Mesh(geo, m);
  }

  private buildWorld() {
    // Asphalt with crosswalk + lane paint, one 64px texture
    const roadTex = canvasTex(64, (g, s) => {
      g.fillStyle = '#2e2e34'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 160; i++) {
        g.fillStyle = Math.random() > 0.5 ? '#33333a' : '#2a2a30';
        g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    });
    roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.repeat.set(6, 24);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(16, 120), this.mat(0xffffff, { map: roadTex }));
    road.rotation.x = -Math.PI / 2;
    road.position.z = -30;
    this.scene.add(road);

    // One-way 4-lane markings: dashes divide lanes at x -4/0/+4, solid edges.
    // Dashes are scrollers so the road streams past during the drive phase.
    const paint = this.mat(0xd8d8c8);
    for (const lx of [-4, 0, 4]) {
      for (let z = 2; z > -110; z -= 4) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1.6), paint);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(lx, 0.01, z);
        this.scene.add(dash);
        this.scrollers.push({ obj: dash, span: 112 });
      }
    }
    for (const ex of [-7.7, 7.7]) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 120), paint);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(ex, 0.01, -30);
      this.scene.add(edge);
    }
    // two intersections, one red-light block apart: the one you're at and the
    // next one down the road (they leapfrog as you drive)
    this.intersections = [this.buildIntersection(0), this.buildIntersection(-GameScene.SPACING)];
    this.curI = 0;

    // Sidewalks
    const walkMat = this.mat(0x55555e);
    for (const side of [-1, 1]) {
      const walk = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 120), walkMat);
      walk.position.set(side * 8, 0.12, -30);
      this.scene.add(walk);
    }

    // Buildings: boxes with a lit-windows texture
    const winTex = canvasTex(32, (g, s) => {
      g.fillStyle = '#16161e'; g.fillRect(0, 0, s, s);
      for (let y = 2; y < s; y += 6) for (let x = 2; x < s; x += 6) {
        g.fillStyle = Math.random() > 0.6 ? '#e8c86a' : '#0c0c14';
        g.fillRect(x, y, 3, 4);
      }
    });
    winTex.wrapS = winTex.wrapT = THREE.RepeatWrapping;
    const rng = mulberry(7);
    for (let i = 0; i < 26; i++) {
      const w = 4 + rng() * 5, h = 6 + rng() * 16, d = 4 + rng() * 4;
      const tex = winTex.clone();
      tex.repeat.set(Math.round(w / 2), Math.round(h / 2));
      tex.needsUpdate = true;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(0xffffff, { map: tex }));
      const side = i % 2 === 0 ? -1 : 1;
      b.position.set(side * (13.5 + rng() * 4), h / 2, 4 - i * 4.5 - rng() * 2);
      this.scene.add(b);
      this.scrollers.push({ obj: b, span: 121.5 });
    }

    // Street lamps
    for (let z = -4; z > -90; z -= 14) {
      for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.6, 5), this.mat(0x3a3a44));
        pole.position.set(side * 6.4, 2.3, z);
        this.scene.add(pole);
        const bulbM = new THREE.MeshBasicMaterial({ color: 0xffd890 });
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.25), bulbM);
        bulb.position.set(side * 6.0, 4.6, z);
        this.scene.add(bulb);
        this.lampMats.push(bulbM);
        this.scrollers.push({ obj: pole, span: 112 }, { obj: bulb, span: 112 });
      }
    }
  }

  /** One full intersection (stop line, crosswalk, signal) as a movable group. */
  private buildIntersection(zOffset: number): { group: THREE.Group; lamps: THREE.MeshBasicMaterial[] } {
    const g = new THREE.Group();
    const paint = this.mat(0xd8d8c8);
    const stop = new THREE.Mesh(new THREE.PlaneGeometry(15.4, 0.5), paint);
    stop.rotation.x = -Math.PI / 2;
    stop.position.set(0, 0.01, -3.4);
    g.add(stop);
    for (let x = -6.6; x <= 6.6; x += 1.2) {
      const zebra = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 2.4), paint);
      zebra.rotation.x = -Math.PI / 2;
      zebra.position.set(x, 0.01, -5.6);
      g.add(zebra);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.4, 6), this.mat(0x2e2e36));
    pole.position.set(4.6, 2.7, -7.4);
    g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.16, 0.16), this.mat(0x2e2e36));
    arm.position.set(0.9, 5.3, -7.4);
    g.add(arm);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.35, 0.35), this.mat(0x1a1a20));
    box.position.set(0.2, 4.75, -7.4); // hangs over the two center lanes
    g.add(box);
    const lamps: THREE.MeshBasicMaterial[] = [];
    [0xff2222, 0xffaa00, 0x22ff44].forEach((c, i) => {
      const m = new THREE.MeshBasicMaterial({ color: c });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), m);
      lamp.position.set(0.2, 5.18 - i * 0.42, -7.2);
      g.add(lamp);
      lamps.push(m);
    });
    g.position.z = zOffset;
    this.scene.add(g);
    const it = { group: g, lamps };
    this.setLightFor(it, 'red');
    return it;
  }

  private setLightFor(it: { lamps: THREE.MeshBasicMaterial[] }, state: 'red' | 'green') {
    const on = state === 'red' ? 0 : 2;
    it.lamps.forEach((m, i) => m.color.setHex(
      i === on ? (i === 0 ? 0xff2222 : 0x22ff44) : (i === 0 ? 0x441010 : i === 1 ? 0x443310 : 0x104414)
    ));
  }

  setLight(state: 'red' | 'green') {
    this.setLightFor(this.intersections[this.curI], state);
  }

  // ---- player cockpit --------------------------------------------------------
  private buildCockpit() {
    const g = new THREE.Group();
    // hood
    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 1.6), this.mat(0x8e2222));
    hood.position.set(0, 0.72, -1.6);
    hood.rotation.x = 0.06;
    g.add(hood);
    // dash
    const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 0.5), this.mat(0x1c1c22));
    dash.position.set(0, 0.82, -0.75);
    g.add(dash);
    // A-pillars at the windshield line — clear of the left side-window view
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.3, 0.09), this.mat(0x14141a));
      pillar.position.set(side * 1.18, 1.45, -1.35);
      pillar.rotation.x = -0.35;
      g.add(pillar);
    }
    // wheel in front of the driver's (left) seat
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.045, 6, 12), this.mat(0x26262e));
    wheel.position.set(-0.45, 0.95, -0.62);
    wheel.rotation.x = -1.15;
    g.add(wheel);
    g.name = 'cockpit';
    // fixed to the CAR, not the head — the dash stays put when you look left
    g.position.set(2, 0, 0);
    this.cockpit = g;
    this.scene.add(g);
  }

  setDecal(text?: string) {
    if (this.dashDecal) { this.cockpit.remove(this.dashDecal); this.dashDecal = null; }
    if (!text) return;
    const tex = canvasTex(128, (g, s) => {
      g.clearRect(0, 0, s, s);
      g.font = 'bold 20px monospace';
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#000000';
      g.lineWidth = 3;
      g.strokeText(text, s / 2, s / 2);
      g.fillText(text, s / 2, s / 2);
    });
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
    );
    m.position.set(0, 1.6, -1.35); // windshield, car-space
    this.cockpit.add(m);
    this.dashDecal = m;
  }

  setOrnament(colorHex?: string) {
    if (this.ornament) { this.cockpit.remove(this.ornament); this.ornament = null; }
    if (!colorHex) return;
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.06, 0),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) })
    );
    m.position.set(-0.5, 1.0, -0.72); // on the dash, car-space
    this.cockpit.add(m);
    this.ornament = m;
  }

  setSky(key?: string) {
    const sky = SKIES[key ?? 'day'] ?? SKIES.day;
    const u = (this.skyMesh.material as THREE.ShaderMaterial).uniforms;
    u.top.value.setHex(sky.top);
    u.bottom.value.setHex(sky.bottom);
    (this.scene.fog as THREE.Fog).color.setHex(sky.fog);
    this.hemi.color.setHex(sky.ambient);
    this.sun.intensity = sky.sun;
  }

  // ---- opponent cars -----------------------------------------------------------
  private static carLength(style: OpponentDef['carStyle']): number {
    return style === 'limo' ? 6.4 : style === 'metro' ? 7.5
      : style === 'van' || style === 'pickup' ? 4.6
      : style === 'cube' ? 3.4 : 4.0;
  }

  /** the driver's SEAT anchor per body style (head height + cabin position) —
   *  sprites mount here and the eye-contact gaze tracks it, so drivers sit in
   *  the actual driver's seat on every silhouette */
  // Each cabin's window in LOCAL car space: sill = bottom of glass, roof = top
  // of glass, z = the driver seat front/back. The driver's SIZE and HEIGHT are
  // derived from this (below) so he always sits in the seat with headroom to
  // the ceiling — never clipping or floating — on every vehicle.
  private static cabinFor(style: OpponentDef['carStyle']): { sill: number; roof: number; z: number } {
    switch (style) {
      case 'cube':     return { sill: 1.55, roof: 2.28, z: 0.15 }; // greenhouse above the body
      case 'metro':    return { sill: 1.05, roof: 1.78, z: 2.7 };
      case 'van':      return { sill: 1.05, roof: 1.76, z: 1.1 };
      case 'pickup':   return { sill: 1.0,  roof: 1.48, z: 0.7 };
      case 'muscle':   return { sill: 0.98, roof: 1.38, z: -0.5 };
      case 'wedge':    return { sill: 0.76, roof: 1.10, z: -0.2 };
      case 'limo':     return { sill: 1.0,  roof: 1.40, z: 1.2 };
      case 'hatch':
      case 'compact':  return { sill: 1.0,  roof: 1.43, z: -0.25 };
      default:         return { sill: 1.0,  roof: 1.44, z: 0.1 }; // sedan/taxi/lowrider/divine
    }
  }

  /** vertical translate applied to the car mesh (lowrider rides low); the
   *  driver sprite (a sibling of the car) gets the same offset so it matches */
  private static bodyDrop(style: OpponentDef['carStyle']): number {
    return style === 'lowrider' ? -0.16 : 0;
  }

  /** driver sprite scale + world Y so his head fills the window with a clear
   *  gap to the ceiling, seated above the cushion — universal across cars */
  private static driverPlace(style: OpponentDef['carStyle']): { y: number; scale: number; z: number } {
    const cab = GameScene.cabinFor(style);
    const winH = cab.roof - cab.sill;
    const scale = winH * 1.5;                   // big prominent head in the window
    // seat him so head-top sits a clear gap below the roof (headroom visible)
    const y = cab.roof - winH * 0.2 - scale * 0.48 + GameScene.bodyDrop(style);
    return { y, scale, z: cab.z };
  }

  /** park a car nose-aligned with the player's bumper at intersection offset */
  private static parkZ(style: OpponentDef['carStyle'], offset = 0): number {
    return -2.4 + GameScene.carLength(style) / 2 + offset;
  }

  setOpponent(def: OpponentDef) {
    // nose-to-nose with the player at the stop line regardless of body length
    // (front bumper at z=-2.4; car faces -z, so center = front + length/2)
    this.opponentAnchor.position.set(-2, 0, GameScene.parkZ(def.carStyle));
    this.nextAnchor.clear(); // staged copy (if any) is replaced by the real one
    this.opponentGroup.clear();
    this.goopGroup = new THREE.Group();
    const car = this.buildCar(def);
    this.opponentGroup.add(car, this.goopGroup);
    this.opponentGroup.position.set(0, 0, 0);
    // Empty billboard mount at the driver's window — 2D character art goes here
    // later (Higgsfield pipeline), keyed by def.spriteSlot.
    // Driver's seat (car local +x = far lane side, like the meme: he's in his
    // seat, head turned, staring at you through the glass). The 2D character
    // billboard mounts here and always faces the player camera.
    const dp = GameScene.driverPlace(def.carStyle);
    this.driverScale = dp.scale;
    const mount = new THREE.Object3D();
    mount.name = `sprite:${def.spriteSlot}`;
    mount.position.set(0.45, dp.y, dp.z);
    this.opponentGroup.add(mount);
    // Procedural placeholder driver (classic PS1 billboard) until the real
    // meme character art replaces it — seeded per slot so every driver looks
    // different, eyes locked dead on the player.
    this.spriteSlot = def.spriteSlot;
    this.spritePos.copy(mount.position);
    this.spriteAnger = -1;
    this.spriteHasCustom = false; // re-detect custom art for this opponent
    this.setDriverAnger(0);
    this.gaze = 'opponent'; // new rival at the light: head turns to face them
    this.reframe();         // re-derive FOV for this car's distance
  }

  /** Redraw the driver at an anger tier (0 calm .. 4 furious & beet red). */
  setDriverAnger(tier: number) {
    const a = Math.max(0, Math.min(4, Math.floor(tier)));
    if (a === this.spriteAnger || !this.spriteSlot) return;
    this.spriteAnger = a;
    const slot = this.spriteSlot;

    // apply custom art to a sprite: per-tier <slot>_a<tier>.png if present,
    // else single <slot>.png with a per-tier red tint. Sets spriteHasCustom
    // so future tier changes reuse this sprite instead of flashing procedural.
    const applyCustom = (sprite: THREE.Sprite) => {
      loadCustomSprite(`${slot}_a${a}`, (tex) => {
        if (this.spriteSlot !== slot || this.spriteAnger !== a || sprite !== this.sprite) return;
        const m = sprite.material as THREE.SpriteMaterial;
        m.map = tex; m.color.setHex(0xffffff); m.needsUpdate = true;
        this.spriteHasCustom = true;
      }, () => loadCustomSprite(slot, (tex) => {
        if (this.spriteSlot !== slot || sprite !== this.sprite) return;
        const m = sprite.material as THREE.SpriteMaterial;
        m.map = tex;
        m.color.setHex([0xffffff, 0xffd8cc, 0xffb4a0, 0xff8a70, 0xff5a44][a]);
        m.needsUpdate = true;
        this.spriteHasCustom = true;
      }));
    };

    // custom face already showing → just update it in place (no flash)
    if (this.sprite && this.spriteHasCustom) { applyCustom(this.sprite as THREE.Sprite); return; }

    // otherwise (re)build the procedural face, then upgrade to custom art
    if (this.sprite) this.opponentGroup.remove(this.sprite);
    const driver = makeDriverSprite(slot, a);
    driver.scale.set(this.driverScale, this.driverScale, 1); // fit this cabin
    driver.position.copy(this.spritePos);
    this.opponentGroup.add(driver);
    this.sprite = driver;
    applyCustom(driver);
  }

  // Real PS1-style low-poly bodies: each car is an extruded side-profile
  // silhouette (sloped hood, raked windshield, trunk/rake per style) with a
  // separate glass greenhouse so the driver stays visible. Flat-shaded,
  // vertex-snapped, dithered by the pipeline — authentic 1997 geometry.
  private buildCar(def: OpponentDef): THREE.Group {
    const g = new THREE.Group();
    const body = this.mat(def.carColor);
    const trim = this.mat(def.carAccent);
    const glass = this.mat(0xc8e4f0, { transparent: true, opacity: 0.16 });
    const seatM = this.mat(0x23262c);
    const tire = this.mat(0x18181c);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      g.add(mesh);
      return mesh;
    };
    const P = (pts: [number, number][], w: number, m: THREE.Material) => {
      const mesh = profileMesh(pts, w, m);
      g.add(mesh);
      return mesh;
    };

    const s = def.carStyle;
    const long = GameScene.carLength(s);
    const cab = GameScene.cabinFor(s);
    const dashM = this.mat(0x14161c);

    // shared dressing --------------------------------------------------------
    const wheels = (r = 0.36, span = long * 0.32, wy = r) => {
      for (const [x, z] of [[-1, span], [1, span], [-1, -span], [1, -span]] as const) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.26, 10), tire);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * 1.0, wy, z);
        g.add(w);
        const h = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.28, 8), this.mat(0x8a8a94));
        h.rotation.z = Math.PI / 2;
        h.position.set(x * 1.0, wy, z);
        g.add(h);
      }
    };
    const lights = (noseY: number, tailY: number) => {
      const hl = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
      const tl = new THREE.MeshBasicMaterial({ color: 0xd83a2a });
      add(new THREE.BoxGeometry(0.34, 0.14, 0.08), hl, -0.6, noseY, long / 2 - 0.02);
      add(new THREE.BoxGeometry(0.34, 0.14, 0.08), hl, 0.6, noseY, long / 2 - 0.02);
      add(new THREE.BoxGeometry(0.34, 0.12, 0.08), tl, -0.6, tailY, -long / 2 + 0.02);
      add(new THREE.BoxGeometry(0.34, 0.12, 0.08), tl, 0.6, tailY, -long / 2 + 0.02);
    };
    // a real cabin interior: two seats, a dashboard, and a steering wheel in
    // front of the driver — all sized to the window so they read through glass
    const interior = () => {
      // seat backrest top sits JUST BELOW the driver's neck (his sprite center)
      const dp = GameScene.driverPlace(s);
      const backTop = dp.y - GameScene.bodyDrop(s) - 0.05; // local space
      const backH = 0.34;
      const backCY = backTop - backH / 2;
      for (const px of [0.45, -0.45]) {
        add(new THREE.BoxGeometry(0.6, 0.1, 0.5), seatM, px, backCY - backH / 2 + 0.02, cab.z - 0.05); // cushion
        add(new THREE.BoxGeometry(0.6, backH, 0.12), seatM, px, backCY, cab.z - 0.34);                 // backrest
      }
      // steering wheel top sits just BELOW the driver's nose; dash below it
      const wy = (dp.y - GameScene.bodyDrop(s)) - 0.06; // just under the nose (local)
      add(new THREE.BoxGeometry(1.66, 0.16, 0.26), dashM, 0, wy - 0.16, cab.z + 0.52); // dashboard
      const sw = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.03, 6, 12), dashM);    // wheel
      sw.position.set(0.45, wy, cab.z + 0.44); // flush up against the dash (no stem gap)
      sw.rotation.x = -1.15;
      g.add(sw);
    };

    if (s === 'cube') {
      // blocky — the joke — open-top box: 4 walls + floor (no solid top deck)
      add(new THREE.BoxGeometry(1.9, 0.16, 3.4), body, 0, 0.28, 0);      // floor
      add(new THREE.BoxGeometry(0.16, 1.3, 3.4), body, -0.87, 0.85, 0);  // left wall
      add(new THREE.BoxGeometry(0.16, 1.3, 3.4), body, 0.87, 0.85, 0);   // right wall
      add(new THREE.BoxGeometry(1.9, 1.3, 0.16), body, 0, 0.85, 1.62);   // front wall
      add(new THREE.BoxGeometry(1.9, 1.3, 0.16), body, 0, 0.85, -1.62);  // rear wall
      interior();                                                       // seat/dash/wheel inside
      add(new THREE.BoxGeometry(1.75, 0.78, 1.7), glass, 0, 1.94, 0.15); // greenhouse above
      add(new THREE.BoxGeometry(1.82, 0.1, 1.78), body, 0, 2.33, 0.15);  // roof (kept)
      for (const [x, z] of [[-1, 1.2], [1, 1.2], [-1, -1.2], [1, -1.2]] as const)
        add(new THREE.BoxGeometry(0.5, 0.7, 0.7), tire, x * 1.0, 0.35, z);
      lights(0.9, 0.9);
      return g;
    }

    if (s === 'metro') {
      // city bus, open-top body: side walls + floor (no solid top deck)
      const bp: [number, number][] = [[-3.75, 0.35], [-3.75, 1.0], [3.35, 1.0], [3.75, 0.75], [3.75, 0.35]];
      const bl = profileMesh(bp, 0.18, body); bl.position.x = -1.1; g.add(bl);
      const br = profileMesh(bp, 0.18, body); br.position.x = 1.1; g.add(br);
      add(new THREE.BoxGeometry(2.36, 0.18, 7.4), body, 0, 0.42, 0); // floor
      interior();
      P([[-3.55, 1.0], [-3.55, 1.8], [3.15, 1.8], [3.6, 1.05]], 2.3, glass);
      P([[-3.6, 1.8], [-3.6, 1.94], [3.2, 1.94], [3.2, 1.8]], 2.42, body); // roof (kept)
      add(new THREE.BoxGeometry(2.5, 0.3, long * 0.98), trim, 0, 0.32, 0);
      wheels(0.42, long * 0.34, 0.42);
      lights(0.7, 0.7);
      return g;
    }

    // profile-extruded unibody styles ---------------------------------------
    type Pts = [number, number][];
    let low: Pts, gls: Pts, roofSpan: [number, number];
    switch (s) {
      case 'muscle':
        low = [[-2, 0.35], [-2, 0.95], [-1.2, 1.02], [-0.1, 0.95], [1.9, 0.88], [2, 0.6], [2, 0.35]];
        gls = [[-1.55, 1.0], [-1.1, 1.4], [-0.2, 1.4], [0.3, 0.94]];
        roofSpan = [-1.14, -0.16];
        break;
      case 'wedge':
        low = [[-2, 0.3], [-2, 0.75], [-1.3, 0.82], [0.2, 0.72], [2.05, 0.42], [2.05, 0.3]];
        gls = [[-1.25, 0.78], [-0.7, 1.12], [0.15, 1.12], [0.62, 0.72]];
        roofSpan = [-0.74, 0.19];

        break;
      case 'hatch':
      case 'compact':
        low = [[-2, 0.34], [-2, 0.95], [1.15, 0.98], [1.85, 0.9], [2, 0.75], [2, 0.34]];
        gls = [[-1.6, 0.97], [-1.2, 1.45], [0.4, 1.45], [0.92, 0.98]];
        roofSpan = [-1.24, 0.44];
        break;
      case 'van':
        low = [[-2.3, 0.34], [-2.3, 1.0], [1.5, 1.0], [2.1, 0.9], [2.3, 0.6], [2.3, 0.34]];
        gls = [[-2.05, 1.0], [-2.0, 1.8], [1.35, 1.8], [1.85, 1.0]];
        roofSpan = [-2.04, 1.39];

        break;
      case 'pickup':
        low = [[-2.3, 0.34], [-2.3, 0.62], [0.05, 0.62], [0.05, 0.95], [1.35, 0.98], [2.05, 0.9], [2.3, 0.68], [2.3, 0.34]];
        gls = [[0.12, 0.98], [0.28, 1.5], [1.1, 1.5], [1.52, 0.98]];
        roofSpan = [0.24, 1.14];
        break;
      case 'limo':
        low = [[-3.2, 0.32], [-3.2, 0.88], [-2.6, 0.98], [2.2, 0.98], [2.9, 0.9], [3.2, 0.75], [3.2, 0.32]];
        gls = [[-2.4, 0.98], [-2.0, 1.42], [1.5, 1.42], [2.0, 0.98]];
        roofSpan = [-2.04, 1.54];
        break;
      default: // sedan, taxi, lowrider, divine
        low = [[-2, 0.32], [-2, 0.88], [-1.35, 0.98], [1.1, 0.98], [1.8, 0.92], [2, 0.78], [2, 0.32]];
        gls = [[-1.15, 0.98], [-0.62, 1.46], [0.42, 1.46], [0.95, 0.98]];
        roofSpan = [-0.66, 0.46];
    }

    // open-top body: side walls + floor (NO solid top deck) so the interior
    // bay/cockpit is exposed. Roof + windows are kept as the canopy above.
    const sideL = profileMesh(low, 0.16, body); sideL.position.x = -0.87; g.add(sideL);
    const sideR = profileMesh(low, 0.16, body); sideR.position.x = 0.87; g.add(sideR);
    add(new THREE.BoxGeometry(1.74, 0.16, long * 0.96), body, 0, 0.4, 0); // floor pan
    interior();
    P(gls, 1.78, glass);
    P([[roofSpan[0], gls[1][1]], [roofSpan[0], gls[1][1] + 0.1], [roofSpan[1], gls[1][1] + 0.1], [roofSpan[1], gls[1][1]]], 1.84, body); // roof (kept)
    add(new THREE.BoxGeometry(2.02, 0.14, long * 0.96), trim, 0, 0.3, 0);
    wheels(s === 'wedge' ? 0.32 : 0.36);
    lights(s === 'wedge' ? 0.42 : 0.78, s === 'wedge' ? 0.5 : 0.78);

    if (s === 'taxi') {
      const sign = add(new THREE.BoxGeometry(0.8, 0.22, 0.4), new THREE.MeshBasicMaterial({ color: 0xe8c84a }), 0, gls[1][1] + 0.24, 0);
      sign.userData.keep = true; // survives fleet-mesh swap
    }
    if (s === 'pickup') { // open bed rails
      add(new THREE.BoxGeometry(1.9, 0.24, 0.1), trim, 0, 0.78, -2.24);
      add(new THREE.BoxGeometry(0.1, 0.24, 2.3), trim, -0.94, 0.78, -1.1);
      add(new THREE.BoxGeometry(0.1, 0.24, 2.3), trim, 0.94, 0.78, -1.1);
    }
    if (s === 'wedge') add(new THREE.BoxGeometry(1.7, 0.1, 0.4), trim, 0, 1.02, -1.75);
    if (s === 'muscle') add(new THREE.BoxGeometry(1.7, 0.12, 0.45), trim, 0, 1.14, -1.85);
    if (s === 'lowrider') g.position.y = -0.16; // pure drop, no scale (driver matches)
    if (s === 'divine') {
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 6, 14), new THREE.MeshBasicMaterial({ color: 0xfff8c0 }));
      halo.rotation.x = Math.PI / 2;
      halo.position.set(0, 2.1, -0.1);
      halo.userData.keep = true; // survives fleet-mesh swap
      g.add(halo);
    }
    // upgrade to a Higgsfield mesh when/if the asset exists (silent fallback)
    this.attachFleetMesh(g, def);
    return g;
  }

  // ---- garage -------------------------------------------------------------------
  // A separate 3D room (parked far below the street in the same scene, so it
  // shares the PSX pipeline). Third-person orbit around the player's car —
  // swipe to rotate — and tap to hop into the driver's seat to inspect the
  // dash cosmetics up close.
  private garageMode = false;
  private garageBuilt = false;
  private garageCam = new THREE.PerspectiveCamera(62, 4 / 3, 0.1, 60);
  private garageCar: THREE.Group | null = null;
  private garageYaw = 0.8;
  private garagePitch = 0.3;
  private garageFP = false;
  private fpYaw = 0;          // first-person head yaw (0 = windshield)
  private fpPitch = -0.08;    // slight natural downward gaze at the dash
  private fpZoom = 1;         // first-person zoom (FOV scale)
  private garageDist = 5.6;   // third-person orbit radius
  private garageLaptop: THREE.Object3D | null = null; // tap it to open the shop
  onGarageShop?: () => void;  // fired when the garage laptop is tapped
  private garageDecal: THREE.Mesh | null = null;
  private garageOrn: THREE.Mesh | null = null;
  private garageGoopTop: THREE.MeshLambertMaterial | null = null;
  private static readonly GO = new THREE.Vector3(0, -200, 0);

  get inGarage() { return this.garageMode; }

  private buildGarage() {
    this.garageBuilt = true;
    const GO = GameScene.GO;
    const room = new THREE.Group();
    const wallTex = canvasTex(64, (g, s) => {
      g.fillStyle = '#3a3a40'; g.fillRect(0, 0, s, s);
      g.strokeStyle = '#2e2e34'; g.lineWidth = 2;
      for (let y = 0; y <= s; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
      for (let y = 0; y < s; y += 16) for (let x = (y / 16) % 2 ? 0 : 16; x <= s; x += 32) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 16); g.stroke();
      }
    });
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    wallTex.repeat.set(4, 2);
    const shell = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 14),
      this.mat(0xffffff, { map: wallTex, side: THREE.BackSide }));
    shell.position.set(0, 2.5, 0);
    room.add(shell);
    const floorTex = canvasTex(64, (g, s) => {
      g.fillStyle = '#4a4a50'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 90; i++) {
        g.fillStyle = Math.random() > 0.5 ? '#44444a' : '#505056';
        g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
      }
      g.fillStyle = '#3a3a3e'; g.beginPath(); g.ellipse(s * 0.7, s * 0.65, 9, 5, 0.4, 0, 7); g.fill();
    });
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(3, 3);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), this.mat(0xffffff, { map: floorTex }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    room.add(floor);
    // ceiling light strip + actual light
    const strip = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 0.5), new THREE.MeshBasicMaterial({ color: 0xfff4d8 }));
    strip.position.set(0, 4.9, 0);
    room.add(strip);
    const bulb = new THREE.PointLight(0xfff0d8, 60, 20);
    bulb.position.set(0, 4.2, 0);
    room.add(bulb);
    // shop desk with a laptop terminal (tap it to open the cosmetics shop)
    const desk = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.9, 1), this.mat(0x5a4a3a));
    desk.position.set(-5.2, 0.45, -5.6);
    room.add(desk);
    const legM = this.mat(0x2a2e2e);
    for (const [lx, lz] of [[-1.2, -0.35], [-1.2, 0.35], [1.2, -0.35], [1.2, 0.35]] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), legM);
      leg.position.set(-5.2 + lx, 0, -5.6 + lz);
      room.add(leg);
    }
    const laptop = new THREE.Group();
    const lbase = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.5), this.mat(0x2a2e2e));
    lbase.position.set(0, 0.02, 0); laptop.add(lbase);
    const lscreen = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.03), this.mat(0x1c1e28));
    lscreen.position.set(0, 0.27, -0.2); lscreen.rotation.x = 0.15; laptop.add(lscreen);
    const lglow = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.38, 0.02), new THREE.MeshBasicMaterial({ color: 0x88d5ff }));
    lglow.position.set(0, 0.26, -0.205); lglow.rotation.x = 0.15; laptop.add(lglow);
    const lkeys = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.02, 0.38), this.mat(0x22262a));
    lkeys.position.set(0, 0.04, 0.04); laptop.add(lkeys);
    laptop.position.set(-5.2, 0.9, -5.6);
    laptop.userData.isLaptop = true;
    room.add(laptop);
    this.garageLaptop = laptop;
    // desk lamp
    const lamp = new THREE.Group();
    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.05, 8), this.mat(0x3a3a3e));
    lampBase.position.set(0, 0.025, 0); lamp.add(lampBase);
    const lampStick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 6), this.mat(0x2a2e2e));
    lampStick.position.set(0, 0.2, 0); lampStick.rotation.z = 0.3; lamp.add(lampStick);
    const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.12, 8), this.mat(0x8a7a4a));
    lampShade.position.set(0.1, 0.35, 0); lampShade.rotation.z = 0.3; lamp.add(lampShade);
    const lampLight = new THREE.PointLight(0xffe8b0, 15, 3);
    lampLight.position.set(0.1, 0.32, 0); lamp.add(lampLight);
    lamp.position.set(-4.8, 0.9, -5.2);
    room.add(lamp);
    // tire stack set dressing
    const tireM = this.mat(0x18181c);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 10), tireM);
      t.position.set(5.4, 0.16 + i * 0.32, -5.4);
      room.add(t);
    }
    // goop display drum (top tints with the equipped goop color)
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 10), this.mat(0x4a5a6a));
    drum.position.set(4.9, 0.55, 5.0);
    room.add(drum);
    this.garageGoopTop = this.mat(0xf2f0e8);
    const goopTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 10), this.garageGoopTop);
    goopTop.position.set(4.9, 1.14, 5.0);
    room.add(goopTop);
    room.position.copy(GO);
    this.scene.add(room);
    // the player's car (matches the red street cockpit)
    this.garageCar = this.buildCar({
      id: 'player', name: 'player', blurb: '', tapsRequired: 0,
      carColor: 0x8e2222, carAccent: 0x26262e, carStyle: 'sedan',
      mentalityReward: 0, spriteSlot: '',
    });
    // interior kit so first-person has a real driver's seat view
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.34), this.mat(0x1c1c22));
    dash.position.set(0, 1.02, 0.66);
    this.garageCar.add(dash);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 6, 12), this.mat(0x26262e));
    wheel.position.set(-0.42, 1.02, 0.48);
    wheel.rotation.x = -1.2;
    this.garageCar.add(wheel);
    this.garageCar.position.copy(GO);
    this.scene.add(this.garageCar);
    // NOTE: the procedural car is the customizable one — cosmetics (paint,
    // decal, ornament, goop) apply to it. No Higgsfield mesh overlay here.
  }

  /** Load a GLB, normalize it to ~4-unit length sitting on the floor, apply
   *  the PSX vertex-snap + flat shading, and hand back the prepared group. */
  private loadCarMesh(url: string, onReady: (m: THREE.Group) => void, tint?: number, onFail?: () => void) {
    new GLTFLoader().load(url, (gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      const targetLen = 4.2;
      const scale = targetLen / Math.max(size.x, size.z);
      const g = new THREE.Group();
      root.position.sub(center);            // center at origin
      root.scale.setScalar(scale);
      root.position.multiplyScalar(scale);
      root.position.y += (size.y * scale) / 2; // sit on the floor
      // orient: image_to_3d faces +Z toward camera; our cars face -Z (forward)
      root.rotation.y = Math.PI;
      // largest mesh = the body; tint it toward the car's paint color
      let biggest: THREE.Mesh | null = null; let bMax = 0;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mb = new THREE.Box3().setFromObject(m); const ms = new THREE.Vector3(); mb.getSize(ms);
        const vol = ms.x * ms.y * ms.z; if (vol > bMax) { bMax = vol; biggest = m; }
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat) { mat.flatShading = true; psxify(mat, this.psxRes); mat.needsUpdate = true; }
      });
      if (tint !== undefined && biggest) {
        const bm = (biggest as THREE.Mesh).material as THREE.MeshStandardMaterial;
        bm.color.setHex(tint);
        if (bm.map) bm.map = null; // drop pale baked texture so the tint reads
      }
      g.add(root);
      onReady(g);
    }, undefined, () => { onFail?.(); /* load failed — procedural car stays */ });
  }

  // ---- Higgsfield fleet meshes ------------------------------------------------
  // ONE neutral-white PS1 mesh covers the whole sedan family: the white baked
  // texture multiplies with each opponent's paint color, and scale variants
  // produce hatch/compact/lowrider/limo silhouettes.
  private static carMeshCache = new Map<string, Promise<THREE.Group | null>>();

  private static meshFor(style: OpponentDef['carStyle']): { url: string; scale: [number, number, number] } | null {
    const S: Partial<Record<OpponentDef['carStyle'], [number, number, number]>> = {
      sedan: [1, 1, 1], taxi: [1, 1, 1], divine: [1, 1, 1],
      hatch: [1, 1.04, 0.9], compact: [0.94, 0.97, 0.88],
      lowrider: [1.02, 0.84, 1], limo: [1, 0.96, 1.52],
    };
    const sc = S[style];
    return sc ? { url: 'models/car_sedan_white.glb', scale: sc } : null;
  }

  private carMeshMaster(url: string): Promise<THREE.Group | null> {
    let p = GameScene.carMeshCache.get(url);
    if (!p) {
      p = new Promise<THREE.Group | null>((res) =>
        this.loadCarMesh(url, (m) => res(m), undefined, () => res(null)));
      GameScene.carMeshCache.set(url, p);
    }
    return p;
  }

  /** swap a procedural car for a tinted Higgsfield mesh when it's available */
  private attachFleetMesh(g: THREE.Group, def: OpponentDef) {
    const src = GameScene.meshFor(def.carStyle);
    if (!src) return; // style keeps its procedural body (cube stays the joke)
    void this.carMeshMaster(src.url).then((master) => {
      if (!master || !g.parent) return;
      const inst = master.clone(true);
      inst.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.flatShading = true;
        mat.color.setHex(def.carColor); // white texture x paint = opponent color
        psxify(mat, this.psxRes);       // clone drops onBeforeCompile — reapply
        mat.needsUpdate = true;
        m.material = mat;
      });
      inst.scale.set(src.scale[0], src.scale[1], src.scale[2]);
      for (const c of [...g.children]) {
        if (!c.userData.keep) c.visible = false; // hide procedural body
      }
      g.add(inst);
    });
  }

  enterGarage() {
    if (!this.garageBuilt) this.buildGarage();
    this.garageMode = true;
    this.garageFP = false;
  }

  exitGarage() { this.garageMode = false; }

  /** swipe: third-person orbits the car; first-person looks around the cabin */
  garageSwipe(dx: number, dy: number) {
    if (this.garageFP) {
      this.fpYaw -= dx * 0.006;
      this.fpPitch = Math.min(0.7, Math.max(-0.7, this.fpPitch - dy * 0.004));
    } else {
      this.garageYaw -= dx * 0.008;
      this.garagePitch = Math.min(0.9, Math.max(0.06, this.garagePitch + dy * 0.004));
    }
  }

  /** tap the laptop → open the shop; tap elsewhere → toggle first-person seat */
  garageTap(x?: number, y?: number) {
    if (this.garageLaptop && x !== undefined && y !== undefined) {
      const n = new THREE.Vector3();
      this.garageLaptop.getWorldPosition(n);
      n.project(this.garageCam);
      const sx = (n.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-n.y * 0.5 + 0.5) * window.innerHeight;
      if (Math.abs(sx - x) < 46 && Math.abs(sy - y) < 46) { this.onGarageShop?.(); return; }
    }
    this.garageFP = !this.garageFP;
    if (this.garageFP) { this.fpYaw = 0; this.fpPitch = -0.08; } // face the windshield
  }

  /** Screen position of the garage laptop (for the "open shop" arrow), or
   *  null when it's behind the camera / not in third-person garage view. */
  garageLaptopScreen(): { x: number; y: number } | null {
    if (!this.garageMode || this.garageFP || !this.garageLaptop) return null;
    const n = new THREE.Vector3();
    this.garageLaptop.getWorldPosition(n);
    n.project(this.garageCam);
    if (n.z > 1) return null; // behind camera
    return { x: (n.x * 0.5 + 0.5) * window.innerWidth, y: (-n.y * 0.5 + 0.5) * window.innerHeight };
  }

  /** pinch/wheel zoom: third-person changes orbit distance, first-person FOV */
  garageZoom(delta: number) {
    if (this.garageFP) {
      this.fpZoom = Math.min(1.6, Math.max(0.55, this.fpZoom + delta * 0.4));
    } else {
      this.garageDist = Math.min(9, Math.max(2.6, this.garageDist + delta));
    }
  }

  setGarageCosmetics(decal?: string, ornament?: string, goop?: string) {
    if (!this.garageBuilt || !this.garageCar) return;
    if (this.garageDecal) { this.garageCar.remove(this.garageDecal); this.garageDecal = null; }
    if (decal) {
      const tex = canvasTex(128, (g, s) => {
        g.clearRect(0, 0, s, s);
        g.font = 'bold 18px monospace';
        g.textAlign = 'center';
        g.fillStyle = '#ffffff';
        g.strokeStyle = '#000000';
        g.lineWidth = 3;
        g.strokeText(decal, s / 2, s / 2);
        g.fillText(decal, s / 2, s / 2);
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.62),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
      m.position.set(0, 1.24, 0.72);
      m.rotation.x = -0.73; // lies on the windshield slope, readable both sides
      this.garageCar.add(m);
      this.garageDecal = m;
    }
    if (this.garageOrn) { this.garageCar.remove(this.garageOrn); this.garageOrn = null; }
    if (ornament) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(ornament) }));
      m.position.set(-0.38, 1.06, 0.52); // on the dash, driver's side
      this.garageCar.add(m);
      this.garageOrn = m;
    }
    if (this.garageGoopTop) this.garageGoopTop.color.set(goop ?? '#f2f0e8');
  }

  // ---- effects ------------------------------------------------------------------
  setShakeAmp(a: number) { this.shakeAmp = a; }
  tapPulse() { this.pulse = Math.min(this.pulse + 0.5, 1.6); }

  /** Cover the opponent car in goop blobs + splat particles. */
  goop(colorHex = '#f2f0e8') {
    const color = new THREE.Color(colorHex);
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    psxify(m, this.psxRes);
    const rng = mulberry(42);
    for (let i = 0; i < 34; i++) {
      const r = 0.18 + rng() * 0.42;
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), m);
      blob.position.set((rng() - 0.5) * 2.2, 0.5 + rng() * 1.4, (rng() - 0.5) * 4.2);
      blob.scale.y = 0.55 + rng() * 0.3; // flattened, dripping look
      this.goopGroup.add(blob);
    }
    // drips down the windows
    for (let i = 0; i < 10; i++) {
      const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 0.5 + rng() * 0.7, 5), m);
      drip.position.set((rng() - 0.5) * 1.8, 0.9 + rng() * 0.5, (rng() - 0.5) * 3.6);
      this.goopGroup.add(drip);
    }
    // airborne splats
    const splatMat = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < 26; i++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05 + rng() * 0.08, 0), splatMat);
      p.position.copy(this.opponentAnchor.position).add(new THREE.Vector3(0, 1.2, 0));
      this.scene.add(p);
      this.splats.push({
        m: p,
        v: new THREE.Vector3((rng() - 0.5) * 5, 2 + rng() * 4, (rng() - 0.5) * 5),
        life: 1.4,
      });
    }
  }

  /** Green light: face the road and actually DRIVE — the world streams past,
   *  the beaten car falls behind, and the next rival is visible ahead,
   *  parked at the next red light, growing as you pull up beside them. */
  driveToNext(nextDef: OpponentDef, onDone: () => void) {
    this.driving = true;
    this.driveT = 0;
    this.driveS = 0;
    this.onDriveDone = onDone;
    this.gaze = 'road'; // eyes back on the road until the next red light
    this.setLight('green');
    // stage the next rival at the next intersection down the road
    const far = this.intersections[this.curI === 0 ? 1 : 0];
    this.setLightFor(far, 'red');
    this.nextAnchor.clear();
    this.nextAnchor.add(this.buildCar(nextDef));
    const ndp = GameScene.driverPlace(nextDef.carStyle);
    const driver = makeDriverSprite(nextDef.spriteSlot, 0);
    driver.scale.set(ndp.scale, ndp.scale, 1);
    driver.position.set(0.45, ndp.y, ndp.z);
    this.nextAnchor.add(driver);
    this.nextAnchor.position.set(-2, 0, GameScene.parkZ(nextDef.carStyle, -GameScene.SPACING));
  }

  // ---- frame ------------------------------------------------------------------
  render(dt: number) {
    this.time += dt;
    this.pulse = Math.max(0, this.pulse - dt * 3.2);

    // garage view: orbit or driver's-seat camera, same PSX pipeline
    if (this.garageMode) {
      const GO = GameScene.GO;
      if (this.garageFP) {
        // driver's seat with free look: swipe to look around the cabin
        this.garageCam.fov = 62 / this.fpZoom;
        this.garageCam.updateProjectionMatrix();
        const eye = new THREE.Vector3(GO.x - 0.42, GO.y + 1.3, GO.z - 0.12);
        this.garageCam.position.copy(eye);
        this.garageCam.lookAt(
          eye.x + Math.sin(this.fpYaw) * Math.cos(this.fpPitch),
          eye.y + Math.sin(this.fpPitch),
          eye.z + Math.cos(this.fpYaw) * Math.cos(this.fpPitch),
        );
      } else {
        if (this.garageCam.fov !== 62) { this.garageCam.fov = 62; this.garageCam.updateProjectionMatrix(); }
        const r = this.garageDist;
        this.garageCam.position.set(
          GO.x + Math.sin(this.garageYaw) * Math.cos(this.garagePitch) * r,
          GO.y + 0.6 + Math.sin(this.garagePitch) * r,
          GO.z + Math.cos(this.garageYaw) * Math.cos(this.garagePitch) * r,
        );
        this.garageCam.lookAt(GO.x, GO.y + 0.85, GO.z);
      }
      this.renderer.setRenderTarget(this.rt);
      this.renderer.render(this.scene, this.garageCam);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.compScene, this.compCam);
      return;
    }

    // opponent shake: tier amplitude + per-tap pulse kick
    const a = this.shakeAmp * (1 + this.pulse * 2.5);
    const t = this.time;
    this.opponentGroup.position.x = Math.sin(t * 31) * a;
    this.opponentGroup.position.y = Math.abs(Math.sin(t * 47)) * a * 0.8;
    this.opponentGroup.position.z = Math.cos(t * 23) * a * 0.6;
    this.opponentGroup.rotation.z = Math.sin(t * 39) * a * 0.35;
    this.opponentGroup.rotation.x = Math.cos(t * 27) * a * 0.2;

    // subtle idle sway on the player cam (engine running)
    this.camera.position.y = 1.25 + Math.sin(t * 2.1) * 0.008;

    // head turn: smoothly swing between the opponent's window and the road.
    // Eye contact aims at the DRIVER'S actual head height (buses, cube cars
    // and low wedges all differ), not a fixed line.
    const gazeTarget = this.gaze === 'opponent'
      ? new THREE.Vector3(this.opponentAnchor.position.x - 0.45, this.spritePos.y + 0.05, this.opponentAnchor.position.z - this.spritePos.z)
      : new THREE.Vector3(this.camera.position.x, 1.15, this.camera.position.z - 30);
    this.gazeHelper.position.copy(this.camera.position);
    this.gazeHelper.lookAt(gazeTarget);
    this.camera.quaternion.slerp(this.gazeHelper.quaternion, Math.min(1, dt * 3.2));

    // splat particles
    for (let i = this.splats.length - 1; i >= 0; i--) {
      const sp = this.splats[i];
      sp.life -= dt;
      sp.v.y -= 9.8 * dt;
      sp.m.position.addScaledVector(sp.v, dt);
      if (sp.life <= 0 || sp.m.position.y < 0.02) {
        this.scene.remove(sp.m);
        this.splats.splice(i, 1);
      }
    }

    // drive phase: the player rolls one block — everything parked streams
    // past (+z), the two intersections leapfrog, and the staged next rival
    // slides in from the distance until you stop abreast at their light
    if (this.driving) {
      this.driveT += dt;
      const T = 4.4;
      const p = Math.min(1, this.driveT / T);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // in-out
      const s = GameScene.SPACING * ease;
      const dz = s - this.driveS;
      this.driveS = s;
      this.opponentAnchor.position.z += dz; // beaten goop-car falls behind
      this.nextAnchor.position.z += dz;     // next rival approaches
      for (const it of this.intersections) {
        it.group.position.z += dz;
        if (it.group.position.z > GameScene.SPACING / 2) it.group.position.z -= GameScene.SPACING * 2;
      }
      for (const sc of this.scrollers) {
        sc.obj.position.z += dz;
        if (sc.obj.position.z > 20) sc.obj.position.z -= sc.span;
      }
      // gentle acceleration bob
      this.camera.position.y = 1.25 + Math.sin(this.driveT * 9) * 0.02 * Math.sin(Math.PI * p);
      if (p >= 1) {
        this.driving = false;
        this.curI = Math.abs(this.intersections[0].group.position.z) < Math.abs(this.intersections[1].group.position.z) ? 0 : 1;
        const cb = this.onDriveDone;
        this.onDriveDone = null;
        cb?.(); // setOpponent swaps the staged rival for the live one in place
      }
    }

    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.compCam);
  }

  /** Derive vertical FOV so a fixed world-height frames at the opponent's
   *  distance — keeps the driver a consistent prominent size and centered
   *  across every aspect ratio, so eye contact works in portrait too. */
  /** Frame so the OPPONENT'S HEAD is the hero — ~11% of screen height, dead
   *  center. We zoom to the driver's actual head size (derived from his sprite
   *  scale), so the face is prominent on every vehicle; the car is scaled up
   *  around it and may run off-screen (that's intended). */
  private reframe() {
    const dist = this.camera.position.distanceTo(
      new THREE.Vector3(this.opponentAnchor.position.x - 0.45, this.spritePos.y + 0.05,
        this.opponentAnchor.position.z - this.spritePos.z));
    const headWorld = 0.44 * this.driverScale;   // head ≈ top 44% of the bust
    const targetFrac = 0.125;                     // head is the hero: ~12% of frame
    // visible world-height that makes the head the target fraction; portrait
    // gets a touch more height so a sliver of car reads under the face
    const aspect = this.camera.aspect;
    const h = (headWorld / targetFrac) * (aspect < 1 ? 1 + (1 - aspect) * 0.4 : 1);
    this.camera.fov = 2 * Math.atan((h / 2) / Math.max(1, dist)) * (180 / Math.PI);
    this.camera.updateProjectionMatrix();
  }

  private onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.reframe();
    this.garageCam.aspect = w / h;
    this.garageCam.updateProjectionMatrix();
    const rw = Math.round(PSX_H * (w / h));
    this.rt.setSize(rw, PSX_H);
    this.psxRes.set(rw, PSX_H);
  }
}

// 2D driver billboards: original chunky pixel-art characters, one distinct
// look per handcrafted opponent (procedural opponents get seeded variants).
// THREE.Sprite always faces the camera, so the driver holds eye contact no
// matter what. `anger` (0..4) tracks shake milestones: skin flushes red,
// brows V, eyes narrow, teeth grit.
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => {
    const va = (pa >> sh) & 255, vb = (pb >> sh) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

interface DriverLook {
  skin: string; shirt: string;
  hair?: string;                       // undefined = bald
  hairStyle?: 'flat' | 'mohawk' | 'afro' | 'spiky' | 'long';
  hat?: 'cap' | 'cowboy' | 'beanie' | 'halo' | 'horns' | 'crown' | 'helmet' | 'chef' | 'wizard';
  hatColor?: string;
  shades?: boolean;                    // sunglasses band
  visor?: boolean;                     // full glowing visor (robots/astronauts)
  eyepatch?: boolean;
  mask?: boolean;                      // balaclava lower face
  bandana?: boolean;
  mustache?: boolean;
  beard?: boolean;
  headphones?: boolean;
  glow?: boolean;                      // radiant outline
  stubble?: boolean;
  facePaint?: string;                  // mime white, warpaint, etc.
}

// Original character designs riffing on the opponent archetypes.
const DRIVER_LOOKS: Record<string, DriverLook> = {
  char_og:         { skin: '#e8b48a', shirt: '#7a8a99', hair: '#4a2e1a', stubble: true },
  char_mentality:  { skin: '#f0d0b0', shirt: '#d8d8d8', hat: 'cap', hatColor: '#2e2e36' },
  char_blockhead:  { skin: '#7fae4e', shirt: '#5f8a3a', hair: '#3c5c22' },
  char_easyface:   { skin: '#f2d24a', shirt: '#4aa8e0' },
  char_merc:       { skin: '#c68a5a', shirt: '#8e3a2e', mask: true, hatColor: '#2a2a2e' },
  char_metro:      { skin: '#c9a184', shirt: '#5a5a66', hat: 'beanie', hatColor: '#3d4148' },
  char_cowboy:     { skin: '#d8a878', shirt: '#6a4a9e', hat: 'cowboy', hatColor: '#4d2d66', bandana: true },
  char_demon:      { skin: '#8e2222', shirt: '#1c1c22', hat: 'horns', hatColor: '#3a0e0e' },
  char_sigma:      { skin: '#e0b890', shirt: '#16161c', hair: '#1a1a1a', shades: true },
  char_discipline: { skin: '#f4f4f0', shirt: '#e8e8e4', hat: 'halo', hatColor: '#ffe98a', glow: true },
  // act 2
  char_gymbro:     { skin: '#e0a878', shirt: '#d84a4a', hair: '#2a2018', hairStyle: 'spiky', stubble: true },
  char_npc:        { skin: '#c8c8c8', shirt: '#9a9a9a', hair: '#7a7a7a' },
  char_doomer:     { skin: '#c9b49a', shirt: '#2e3440', hat: 'beanie', hatColor: '#1a1e26', stubble: true },
  char_bloomer:    { skin: '#e8c098', shirt: '#7ac47a', hair: '#c9a227', hairStyle: 'flat' },
  char_yapper:     { skin: '#e8b48a', shirt: '#e08ab0', hair: '#4a2e1a', hairStyle: 'long' },
  char_cryptouncle:{ skin: '#d8a878', shirt: '#c9a227', hair: '#666666', mustache: true, shades: true },
  char_aurafarmer: { skin: '#b89ae0', shirt: '#8a3ab0', hair: '#5a2472', hairStyle: 'spiky', glow: true },
  char_granny:     { skin: '#e8c8b0', shirt: '#b8a8d8', hair: '#e0e0e0', hairStyle: 'afro' },
  char_mime:       { skin: '#f0f0f0', shirt: '#2a2a2e', hat: 'beanie', hatColor: '#1a1a1e', facePaint: '#ffffff' },
  char_kingpin:    { skin: '#c68a5a', shirt: '#e8862a', hat: 'helmet', hatColor: '#e8862a', beard: true },
  // act 3
  char_valet:      { skin: '#e0b890', shirt: '#2a2a2e', hat: 'cap', hatColor: '#c9a227', mustache: true },
  char_chef:       { skin: '#e8b48a', shirt: '#e8e0d0', hat: 'chef', hatColor: '#f0f0ec', mustache: true },
  char_detective:  { skin: '#c9a184', shirt: '#8a7a5c', hat: 'cowboy', hatColor: '#4a4234', stubble: true },
  char_surgeon:    { skin: '#d8b898', shirt: '#7ab8c8', mask: true, hatColor: '#5a98a8' },
  char_lifeguard:  { skin: '#e0a068', shirt: '#e8482a', hair: '#e8d84a', hairStyle: 'long', shades: true },
  char_astronaut:  { skin: '#e8c8a8', shirt: '#d8d8e0', hat: 'helmet', hatColor: '#b8b8c8', visor: true },
  char_conductor:  { skin: '#d8b090', shirt: '#1c1c22', hair: '#e0e0e0', hairStyle: 'spiky' },
  char_beekeeper:  { skin: '#e0b890', shirt: '#e8c84a', hat: 'helmet', hatColor: '#f0e8c0', visor: true },
  char_librarian:  { skin: '#c9a184', shirt: '#6a4a2e', hair: '#4a3a2a', hairStyle: 'flat', shades: true },
  char_mailman:    { skin: '#c68a5a', shirt: '#4a6ab0', hat: 'cap', hatColor: '#2e4472' },
  // act 4
  char_knight:     { skin: '#d8b898', shirt: '#8a8a9a', hat: 'helmet', hatColor: '#6a6a7a', visor: true },
  char_pharaoh:    { skin: '#c68a5a', shirt: '#2a6a8a', hat: 'crown', hatColor: '#c9a227' },
  char_viking:     { skin: '#e0b088', shirt: '#5a4a3a', hat: 'horns', hatColor: '#d8d0c0', beard: true },
  char_samurai:    { skin: '#d8b090', shirt: '#b03a3a', hair: '#1a1a1a', hairStyle: 'long', bandana: true },
  char_pirate:     { skin: '#c9a184', shirt: '#2a2a2e', hat: 'cowboy', hatColor: '#1a1a1e', eyepatch: true, beard: true },
  char_wizard:     { skin: '#e0c8b0', shirt: '#4a2a8a', hat: 'wizard', hatColor: '#4a2a8a', beard: true },
  char_alien:      { skin: '#8ae0c0', shirt: '#4ae0c0', glow: true },
  char_robot:      { skin: '#9aa8b4', shirt: '#6a7a8a', visor: true },
  char_vampire:    { skin: '#e8e0e8', shirt: '#1c1016', hair: '#0a0a0a', hairStyle: 'flat' },
  char_timetraveler:{ skin: '#d8b898', shirt: '#b87a2a', hair: '#e0e0e0', hairStyle: 'spiky', shades: true },
};

function lookFor(slot: string): DriverLook {
  if (DRIVER_LOOKS[slot]) return DRIVER_LOOKS[slot];
  let h = 7;
  for (const ch of slot) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  const rng = mulberry(h);
  const pick = (arr: string[]) => arr[Math.floor(rng() * arr.length)];
  return {
    skin: pick(['#e8b48a', '#c68a5a', '#8a5a3a', '#f0d0b0', '#6a4a2e', '#d8a878', '#c9a184']),
    shirt: pick(['#b03a3a', '#3a6ab0', '#3ab06a', '#8a3ab0', '#2e2e36', '#c9a227', '#e08ab0', '#4ac0a0', '#e8862a']),
    hair: rng() < 0.2 ? undefined : pick(['#1a1a1a', '#4a2e1a', '#c9a227', '#666666', '#b03a3a', '#e0e0e0', '#4a2a8a']),
    hairStyle: pick(['flat', 'flat', 'flat', 'mohawk', 'afro', 'spiky', 'long']) as DriverLook['hairStyle'],
    hat: rng() < 0.25 ? (pick(['cap', 'beanie', 'cowboy', 'helmet']) as DriverLook['hat']) : undefined,
    hatColor: pick(['#2e2e36', '#5a3a2a', '#3a5a2a', '#8e2222', '#2e4472']),
    shades: rng() < 0.15,
    eyepatch: rng() < 0.05,
    mustache: rng() < 0.18,
    beard: rng() < 0.15,
    headphones: rng() < 0.12,
    stubble: rng() < 0.25,
  };
}

function makeDriverSprite(slot: string, anger = 0): THREE.Sprite {
  const L = lookFor(slot);
  const a = Math.max(0, Math.min(4, anger));
  const skin = lerpHex(L.skin, '#d82818', (a / 4) * 0.8);

  const tex = canvasTex(48, (g) => {
    g.clearRect(0, 0, 48, 48);
    if (L.glow) {                                             // radiant aura
      g.fillStyle = 'rgba(255,244,180,0.5)';
      g.fillRect(10, 2, 28, 34); g.fillRect(6, 32, 36, 16);
    }
    // hard black outline so every look reads through glass at 240p
    g.fillStyle = '#000000';
    g.fillRect(12, 4, 24, 30);                                // head
    g.fillRect(7, 32, 34, 16);                                // torso
    g.fillStyle = L.shirt; g.fillRect(9, 35, 30, 13);         // shoulders
    g.fillStyle = skin;
    g.fillRect(20, 29, 8, 7);                                 // neck
    g.fillRect(14, 8, 20, 23);                                // face
    if (L.facePaint) { g.fillStyle = L.facePaint; g.fillRect(14, 8, 20, 23); }
    // hair / hats
    if (L.hair && !L.hat) {
      g.fillStyle = L.hair;
      const hs = L.hairStyle ?? 'flat';
      if (hs === 'flat')   { g.fillRect(13, 5, 22, 6); g.fillRect(13, 5, 4, 13); }
      if (hs === 'mohawk') { g.fillRect(21, 0, 6, 11); }
      if (hs === 'afro')   { g.fillRect(11, 1, 26, 9); g.fillRect(9, 4, 4, 9); g.fillRect(35, 4, 4, 9); }
      if (hs === 'spiky')  { g.fillRect(13, 5, 22, 4); for (let x = 14; x < 34; x += 5) g.fillRect(x, 1, 3, 5); }
      if (hs === 'long')   { g.fillRect(13, 5, 22, 6); g.fillRect(12, 5, 5, 24); g.fillRect(31, 5, 5, 24); }
    }
    if (L.hat === 'cap')    { g.fillStyle = L.hatColor!; g.fillRect(12, 3, 24, 7); g.fillRect(30, 8, 10, 3); }
    if (L.hat === 'beanie') { g.fillStyle = L.hatColor!; g.fillRect(12, 3, 24, 9); }
    if (L.hat === 'cowboy') { g.fillStyle = L.hatColor!; g.fillRect(16, 1, 16, 6); g.fillRect(8, 6, 32, 3); }
    if (L.hat === 'horns')  { g.fillStyle = L.hatColor!; g.fillRect(11, 1, 4, 8); g.fillRect(33, 1, 4, 8); }
    if (L.hat === 'halo')   { g.fillStyle = L.hatColor!; g.fillRect(15, 0, 18, 2); }
    if (L.hat === 'crown')  { g.fillStyle = L.hatColor!; g.fillRect(13, 2, 22, 5); for (let x = 14; x < 34; x += 6) g.fillRect(x, 0, 3, 4); }
    if (L.hat === 'helmet') { g.fillStyle = L.hatColor!; g.fillRect(11, 2, 26, 10); g.fillRect(11, 2, 3, 18); g.fillRect(34, 2, 3, 18); }
    if (L.hat === 'chef')   { g.fillStyle = L.hatColor!; g.fillRect(14, 0, 20, 9); g.fillRect(12, 6, 24, 4); }
    if (L.hat === 'wizard') { g.fillStyle = L.hatColor!; g.fillRect(20, 0, 8, 4); g.fillRect(16, 3, 16, 4); g.fillRect(10, 6, 28, 3); }
    if (L.headphones) {
      g.fillStyle = '#1a1a1e';
      g.fillRect(11, 12, 4, 8); g.fillRect(33, 12, 4, 8); g.fillRect(12, 2, 24, 3);
    }
    // eyes: narrow with anger, red pupils past tier 2 (shades/visor replace them)
    if (L.visor) {
      g.fillStyle = a >= 3 ? '#e04a2a' : '#4ae0c0';
      g.fillRect(14, 13, 20, 7);
    } else if (L.shades) {
      g.fillStyle = '#0a0a0a'; g.fillRect(14, 14, 20, 5);
      if (a >= 3) { g.fillStyle = '#c01010'; g.fillRect(17, 16, 3, 2); g.fillRect(28, 16, 3, 2); } // glare through
    } else if (L.eyepatch) {
      g.fillStyle = '#111111'; g.fillRect(15, 13, 8, 6); g.fillRect(14, 12, 20, 2);
      const eyeH = a >= 3 ? 3 : 5;
      g.fillStyle = '#ffffff'; g.fillRect(26, 15, 6, eyeH);
      g.fillStyle = a >= 3 ? '#c01010' : '#111111'; g.fillRect(28, 16, 3, Math.min(3, eyeH));
    } else {
      const eyeH = a >= 3 ? 3 : a >= 2 ? 4 : 6;
      g.fillStyle = '#ffffff';
      g.fillRect(16, 15, 6, eyeH); g.fillRect(26, 15, 6, eyeH);
      g.fillStyle = a >= 3 ? '#c01010' : '#111111';
      g.fillRect(18, 16, 3, Math.min(3, eyeH)); g.fillRect(28, 16, 3, Math.min(3, eyeH));
    }
    // brows: angle into a V as anger rises
    g.fillStyle = '#111111';
    for (let i = 0; i < 7; i++) {
      const drop = Math.floor((i * a) / 4);
      g.fillRect(15 + i, 11 + drop, 1, 3);
      g.fillRect(32 - i, 11 + drop, 1, 3);
    }
    // facial hair first — the mouth draws over it (teeth carve through beards)
    if (L.beard)    { g.fillStyle = L.hair ?? '#2a2018'; g.fillRect(14, 24, 20, 8); g.fillRect(17, 30, 14, 4); }
    if (L.mustache) { g.fillStyle = L.hair ?? '#2a2018'; g.fillRect(17, 22, 14, 3); }
    // lower face: mask/bandana cover the mouth, otherwise anger mouth
    if (L.mask || L.bandana) {
      g.fillStyle = L.bandana ? '#8e3a2e' : (L.hatColor ?? '#22222a');
      g.fillRect(14, 21, 20, 10);
      if (L.bandana) { g.fillStyle = '#6e2a20'; for (let x = 16; x < 32; x += 4) g.fillRect(x, 24, 2, 2); }
    } else if (a < 3) {
      g.fillRect(21 - a * 2, 26, 6 + a * 4, 2);
    } else {
      g.fillStyle = '#111111'; g.fillRect(16, 24, 16, 6);     // open snarl
      g.fillStyle = '#ffffff'; g.fillRect(17, 25, 14, 3);     // teeth
      g.fillStyle = '#111111';
      for (let x = 19; x < 31; x += 3) g.fillRect(x, 25, 1, 3);
    }
    if (L.stubble) {
      g.fillStyle = 'rgba(40,30,20,0.55)';
      g.fillRect(15, 24, 4, 6); g.fillRect(29, 24, 4, 6); g.fillRect(15, 29, 18, 2);
    }
    if (a === 4) {                                            // forehead vein
      g.fillStyle = '#8e1010';
      g.fillRect(15, 9, 3, 1); g.fillRect(16, 10, 1, 2); g.fillRect(14, 10, 1, 2);
    }
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  s.scale.set(0.9, 0.9, 1);
  return s;
}

// Extrudes a 2D side-profile silhouette (points in car (z, y) space, +z =
// front) across the car's width — the classic PS1 way to model a vehicle.
function profileMesh(pts: [number, number][], width: number, mat: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-Math.PI / 2); // profile axis -> car +z, extrusion -> car x
  return new THREE.Mesh(geo, mat);
}

// Custom sprite loader: checks public/sprites/<slot>.png once per session and
// caches the result. Final art (Higgsfield or hand-made) drops into that
// folder and the game uses it with zero code changes; misses fall back to the
// procedural pixel characters.
const spriteTexCache = new Map<string, THREE.Texture | null | 'miss'>();
function loadCustomSprite(key: string, onLoad: (t: THREE.Texture) => void, onMiss?: () => void) {
  const cached = spriteTexCache.get(key);
  if (cached === 'miss') { onMiss?.(); return; }
  if (cached instanceof THREE.Texture) { onLoad(cached); return; }
  new THREE.TextureLoader().load(
    `sprites/${key}.png`,
    (t) => {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      spriteTexCache.set(key, t);
      onLoad(t);
    },
    undefined,
    () => { spriteTexCache.set(key, 'miss'); onMiss?.(); }
  );
}

// deterministic tiny PRNG (no Math.random in render setup -> stable look)
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
