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

  private opponentGroup = new THREE.Group();  // car + goop, shaken as a unit
  private opponentAnchor = new THREE.Group(); // world placement
  private goopGroup = new THREE.Group();
  private sprite: THREE.Object3D | null = null; // 2D driver billboard
  private spriteSlot = '';
  private spriteAnger = -1;
  private spritePos = new THREE.Vector3();
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
    // Driver's seat (car local +x = far lane side, like the meme: he's in his
    // seat, head turned, staring at you through the glass). The 2D character
    // billboard mounts here and always faces the player camera.
    const mountY = def.carStyle === 'cube' ? 2.0 : def.carStyle === 'metro' ? 1.85
      : def.carStyle === 'van' ? 1.45 : def.carStyle === 'wedge' ? 0.98 : 1.25;
    const mount = new THREE.Object3D();
    mount.name = `sprite:${def.spriteSlot}`;
    mount.position.set(0.45, mountY, 0.15);
    this.opponentGroup.add(mount);
    // Procedural placeholder driver (classic PS1 billboard) until the real
    // meme character art replaces it — seeded per slot so every driver looks
    // different, eyes locked dead on the player.
    this.spriteSlot = def.spriteSlot;
    this.spritePos.copy(mount.position);
    this.spriteAnger = -1;
    this.setDriverAnger(0);
  }

  /** Redraw the driver at an anger tier (0 calm .. 4 furious & beet red). */
  setDriverAnger(tier: number) {
    const a = Math.max(0, Math.min(4, Math.floor(tier)));
    if (a === this.spriteAnger || !this.spriteSlot) return;
    this.spriteAnger = a;
    if (this.sprite) this.opponentGroup.remove(this.sprite);
    const driver = makeDriverSprite(this.spriteSlot, a);
    driver.position.copy(this.spritePos);
    this.opponentGroup.add(driver);
    this.sprite = driver;
  }

  private buildCar(def: OpponentDef): THREE.Group {
    const g = new THREE.Group();
    const body = this.mat(def.carColor);
    const trim = this.mat(def.carAccent);
    // see-through glass (PSX-style semi-transparency) so the driver is visible;
    // interiors hold empty seats until the 2D characters arrive
    const glass = this.mat(0xc8e4f0, { transparent: true, opacity: 0.16 });
    const seatM = this.mat(0x23262c);
    const tire = this.mat(0x18181c);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      g.add(mesh);
      return mesh;
    };

    const s = def.carStyle;
    const long = s === 'limo' ? 6.4 : s === 'metro' ? 7.5 : s === 'van' || s === 'pickup' ? 4.6 : 4.0;
    const tall = s === 'van' || s === 'metro' ? 1.9 : s === 'cube' ? 1.6 : 1.0;

    if (s === 'cube') {
      add(new THREE.BoxGeometry(1.9, 1.6, 3.4), body, 0, 1.0, 0);
      add(new THREE.BoxGeometry(1.4, 0.55, 0.8), seatM, 0, 1.6, 0.1); // bench seat
      add(new THREE.BoxGeometry(1.7, 0.9, 1.5), glass, 0, 1.85, 0.2);
      for (const [x, z] of [[-1, 1.2], [1, 1.2], [-1, -1.2], [1, -1.2]] as const)
        add(new THREE.BoxGeometry(0.5, 0.7, 0.7), tire, x * 1.0, 0.35, z);
    } else if (s === 'metro') {
      add(new THREE.BoxGeometry(2.4, 2.2, long), body, 0, 1.45, 0);
      for (let i = -2; i <= 2; i++) add(new THREE.BoxGeometry(2.44, 0.6, 0.9), glass, 0, 1.9, i * 1.4);
      add(new THREE.BoxGeometry(2.5, 0.35, long), trim, 0, 0.35, 0);
    } else {
      // unibody: lower body + glass greenhouse cabin (so the driver is
      // actually visible inside) capped with a body-colored roof slab
      const bodyH = s === 'wedge' ? 0.45 : 0.62;
      const bodyY = s === 'wedge' ? 0.5 : 0.62;
      add(new THREE.BoxGeometry(2.0, bodyH, long), body, 0, bodyY, 0);
      const cabLen = s === 'limo' ? 2.2 : s === 'muscle' ? 1.7 : s === 'pickup' ? 1.5 : 2.3;
      const cabH = s === 'van' ? 1.15 : s === 'wedge' ? 0.55 : 0.72;
      const cabY = bodyY + bodyH / 2 + cabH / 2;
      const cabZ = s === 'muscle' ? -0.5 : s === 'van' ? 0.4 : s === 'pickup' ? 0.9 : -0.2;
      // seats first (opaque pass renders before the transparent greenhouse)
      for (const sx of [0.45, -0.45]) {
        add(new THREE.BoxGeometry(0.55, 0.16, 0.6), seatM, sx, cabY - cabH / 2 + 0.1, cabZ + 0.25);
        add(new THREE.BoxGeometry(0.55, 0.55, 0.13), seatM, sx, cabY - cabH / 2 + 0.35, cabZ - 0.1);
      }
      const cab = add(new THREE.BoxGeometry(1.7, cabH, cabLen), glass, 0, cabY, cabZ);
      add(new THREE.BoxGeometry(1.74, 0.1, cabLen * 1.02), body, 0, cabY + cabH / 2, cabZ); // roof
      if (s === 'taxi') {
        add(new THREE.BoxGeometry(0.8, 0.22, 0.4), new THREE.MeshBasicMaterial({ color: 0xe8c84a }), 0, cabY + cabH / 2 + 0.16, cabZ);
      }
      if (s === 'pickup') {                                   // open bed walls
        add(new THREE.BoxGeometry(1.9, 0.3, 0.12), trim, 0, 1.05, -long / 2 + 0.06);
        add(new THREE.BoxGeometry(0.12, 0.3, 1.9), trim, -0.94, 1.05, -1.25);
        add(new THREE.BoxGeometry(0.12, 0.3, 1.9), trim, 0.94, 1.05, -1.25);
      }
      if (s === 'wedge') add(new THREE.BoxGeometry(1.7, 0.1, 0.4), trim, 0, 1.1, -long / 2 + 0.3); // spoiler
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
