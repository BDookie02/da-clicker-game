import * as THREE from 'three';
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
};

export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private rt: THREE.WebGLRenderTarget;
  private compScene = new THREE.Scene();
  private compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private psxRes = new THREE.Vector2(320, 240);

  private opponentGroup = new THREE.Group();  // car + goop, shaken as a unit
  private opponentAnchor = new THREE.Group(); // world placement
  private goopGroup = new THREE.Group();
  private sprite: THREE.Mesh | null = null;   // future 2D character billboard
  private trafficLights: THREE.MeshBasicMaterial[] = [];
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

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets us grab devlog screenshots off the canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);

    this.camera = new THREE.PerspectiveCamera(62, 4 / 3, 0.1, 60);
    // Driver's seat POV: you're stopped in your lane, glancing left at the
    // opponent idling beside you. Both cars face down the road normally.
    this.camera.position.set(0, 1.25, 0);
    this.camera.lookAt(-2.6, 1.15, -3.6);

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

    // Next lane over, slightly ahead, pointed down the road like normal
    // traffic — the CAR faces forward; only the driver's head faces you.
    this.opponentAnchor.position.set(-2.9, 0, -3.4);
    this.opponentAnchor.rotation.y = Math.PI; // headlights toward the intersection
    this.opponentAnchor.add(this.opponentGroup);
    this.scene.add(this.opponentAnchor);
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

    // Lane dashes + stop line
    const paint = this.mat(0xd8d8c8);
    for (let z = 2; z > -110; z -= 4) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1.6), paint);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(-1.7, 0.01, z);
      this.scene.add(dash);
    }
    const stop = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.5), paint);
    stop.rotation.x = -Math.PI / 2;
    stop.position.set(-1.6, 0.01, -6.2);
    this.scene.add(stop);
    for (let x = -5; x <= 2; x += 1.1) {
      const zebra = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 2.4), paint);
      zebra.rotation.x = -Math.PI / 2;
      zebra.position.set(x, 0.01, -8.4);
      this.scene.add(zebra);
    }

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
      }
    }

    this.buildTrafficLight();
  }

  private buildTrafficLight() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.4, 6), this.mat(0x2e2e36));
    pole.position.y = 2.7;
    g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.16, 0.16), this.mat(0x2e2e36));
    arm.position.set(-3.7, 5.3, 0);
    g.add(arm);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.35, 0.35), this.mat(0x1a1a20));
    box.position.set(-7.2, 4.75, 0);
    g.add(box);
    const colors = [0xff2222, 0xffaa00, 0x22ff44];
    colors.forEach((c, i) => {
      const m = new THREE.MeshBasicMaterial({ color: c });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), m);
      lamp.position.set(-7.2, 5.18 - i * 0.42, 0.2);
      g.add(lamp);
      this.trafficLights.push(m);
    });
    g.position.set(4.6, 0, -8.8);
    this.scene.add(g);
    this.setLight('red');
  }

  setLight(state: 'red' | 'green') {
    const on = state === 'red' ? 0 : 2;
    this.trafficLights.forEach((m, i) => m.color.multiplyScalar(0).addScalar(0).setHex(
      i === on ? (i === 0 ? 0xff2222 : 0x22ff44) : (i === 0 ? 0x441010 : i === 1 ? 0x443310 : 0x104414)
    ));
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
    // A-pillars
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.3, 0.09), this.mat(0x14141a));
      pillar.position.set(side * 1.15, 1.45, -0.85);
      pillar.rotation.x = -0.35;
      g.add(pillar);
    }
    // wheel
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.045, 6, 12), this.mat(0x26262e));
    wheel.position.set(0.45, 0.95, -0.62);
    wheel.rotation.x = -1.15;
    g.add(wheel);
    g.name = 'cockpit';
    this.camera.add(g);
    g.position.set(0, -1.25, 0); // camera-relative
    this.scene.add(this.camera);
  }

  setDecal(text?: string) {
    if (this.dashDecal) { this.camera.remove(this.dashDecal); this.dashDecal = null; }
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
    m.position.set(0, 0.35, -1.4);
    this.camera.add(m);
    this.dashDecal = m;
  }

  setOrnament(colorHex?: string) {
    if (this.ornament) { this.camera.remove(this.ornament); this.ornament = null; }
    if (!colorHex) return;
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.06, 0),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) })
    );
    m.position.set(-0.5, -0.28, -0.75);
    this.camera.add(m);
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
  setOpponent(def: OpponentDef) {
    this.opponentGroup.clear();
    this.goopGroup = new THREE.Group();
    const car = this.buildCar(def);
    this.opponentGroup.add(car, this.goopGroup);
    this.opponentGroup.position.set(0, 0, 0);
    // Empty billboard mount at the driver's window — 2D character art goes here
    // later (Higgsfield pipeline), keyed by def.spriteSlot.
    // Car is rotated 180° in world, so local -x = the window facing the player.
    const mount = new THREE.Object3D();
    mount.name = `sprite:${def.spriteSlot}`;
    mount.position.set(-0.95, 1.25, -0.3);
    this.opponentGroup.add(mount);
    this.sprite = null;
  }

  private buildCar(def: OpponentDef): THREE.Group {
    const g = new THREE.Group();
    const body = this.mat(def.carColor);
    const trim = this.mat(def.carAccent);
    const glass = this.mat(0x0e1218); // dark windows: vehicle intentionally "empty"
    const tire = this.mat(0x18181c);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      g.add(mesh);
      return mesh;
    };

    const s = def.carStyle;
    const long = s === 'limo' ? 6.4 : s === 'metro' ? 7.5 : s === 'van' ? 4.6 : 4.0;
    const tall = s === 'van' || s === 'metro' ? 1.9 : s === 'cube' ? 1.6 : 1.0;

    if (s === 'cube') {
      add(new THREE.BoxGeometry(1.9, 1.6, 3.4), body, 0, 1.0, 0);
      add(new THREE.BoxGeometry(1.7, 0.9, 1.5), glass, 0, 1.85, 0.2);
      for (const [x, z] of [[-1, 1.2], [1, 1.2], [-1, -1.2], [1, -1.2]] as const)
        add(new THREE.BoxGeometry(0.5, 0.7, 0.7), tire, x * 1.0, 0.35, z);
    } else if (s === 'metro') {
      add(new THREE.BoxGeometry(2.4, 2.2, long), body, 0, 1.45, 0);
      for (let i = -2; i <= 2; i++) add(new THREE.BoxGeometry(2.44, 0.6, 0.9), glass, 0, 1.9, i * 1.4);
      add(new THREE.BoxGeometry(2.5, 0.35, long), trim, 0, 0.35, 0);
    } else {
      // unibody: lower body + cabin
      add(new THREE.BoxGeometry(2.0, 0.62, long), body, 0, 0.62, 0);
      const cabLen = s === 'limo' ? 2.2 : s === 'muscle' ? 1.7 : 2.3;
      const cabH = s === 'van' ? 1.15 : 0.72;
      const cab = add(new THREE.BoxGeometry(1.8, cabH, cabLen), body, 0, 0.62 + 0.31 + cabH / 2, s === 'muscle' ? -0.5 : (s === 'van' ? 0.4 : -0.2));
      cab.scale.x = 0.92;
      add(new THREE.BoxGeometry(1.84, cabH * 0.62, cabLen * 0.94), glass, 0, cab.position.y + 0.08, cab.position.z);
      add(new THREE.BoxGeometry(2.02, 0.16, long * 0.98), trim, 0, 0.3, 0);
      if (s === 'lowrider') g.position.y = -0.18;
      if (s === 'muscle') add(new THREE.BoxGeometry(1.6, 0.12, 0.5), trim, 0, 1.15, -1.8); // spoiler
      if (s === 'divine') {
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 6, 14), new THREE.MeshBasicMaterial({ color: 0xfff8c0 }));
        halo.rotation.x = Math.PI / 2;
        halo.position.set(0, 2.1, -0.2);
        g.add(halo);
      }
      const wy = s === 'lowrider' ? 0.28 : 0.32;
      for (const [x, z] of [[-1, long * 0.32], [1, long * 0.32], [-1, -long * 0.32], [1, -long * 0.32]] as const) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.26, 8), tire);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * 1.02, wy, z);
        g.add(w);
      }
      // headlights toward +z (facing the intersection, angled at player)
      const hl = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
      add(new THREE.BoxGeometry(0.3, 0.14, 0.06), hl, -0.6, 0.72, long / 2 + 0.01);
      add(new THREE.BoxGeometry(0.3, 0.14, 0.06), hl, 0.6, 0.72, long / 2 + 0.01);
    }
    void tall;
    return g;
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

  /** Green light: dolly forward to the next intersection, then reset. */
  driveToNext(onDone: () => void) {
    this.driving = true;
    this.driveT = 0;
    this.onDriveDone = onDone;
    this.setLight('green');
  }

  // ---- frame ------------------------------------------------------------------
  render(dt: number) {
    this.time += dt;
    this.pulse = Math.max(0, this.pulse - dt * 3.2);

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

    // drive transition: world slides past (player "moves" to the next light)
    if (this.driving) {
      this.driveT += dt;
      const speed = Math.min(this.driveT * 6, 14);
      this.opponentAnchor.position.z += speed * dt * 0.4; // beaten car falls behind
      // fade handled by UI; after 2.6s snap back and restore
      if (this.driveT > 2.6) {
        this.driving = false;
        this.opponentAnchor.position.set(-2.9, 0, -3.4);
        this.setLight('red');
        const cb = this.onDriveDone;
        this.onDriveDone = null;
        cb?.();
      }
    }

    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.compCam);
  }

  private onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const rw = Math.round(PSX_H * (w / h));
    this.rt.setSize(rw, PSX_H);
    this.psxRes.set(rw, PSX_H);
  }
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
