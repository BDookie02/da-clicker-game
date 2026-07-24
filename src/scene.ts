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
  uniform sampler2D tCosmetics;
  uniform sampler2D tSceneDepth;
  uniform sampler2D tCosmeticDepth;
  uniform float uNoir;
  varying vec2 vUv;
  const mat4 bayer = mat4(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  void main() {
    vec4 base = texture2D(tScene, vUv);
    vec4 cosmetic = texture2D(tCosmetics, vUv);
    // The coarse cosmetic pass has its own color/depth buffer. Reject pixels
    // behind the normal scene so dashboard props stay inside the windshield
    // and the roof sign cannot bleed through the cabin in first person.
    float sceneDepth = texture2D(tSceneDepth, vUv).r;
    float cosmeticDepth = texture2D(tCosmeticDepth, vUv).r;
    cosmetic.a *= step(cosmeticDepth, sceneDepth + 0.00015);
    vec3 c = mix(base.rgb, cosmetic.rgb, cosmetic.a);
    c = pow(c, vec3(0.4545));                 // linear RT -> sRGB out
    ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
    float d = (bayer[p.x][p.y] / 16.0 - 0.5) / 32.0;
    c = floor((c + d) * 31.0 + 0.5) / 31.0;   // 5 bits per channel
    if (uNoir > 0.5) {
      float gray = dot(c, vec3(0.299, 0.587, 0.114));
      c = vec3(gray);
    }
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
  private cosmeticRT: THREE.WebGLRenderTarget;
  private compScene = new THREE.Scene();
  private compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private psxRes = new THREE.Vector2(320, 240);
  private cosmeticRes = new THREE.Vector2(160, 120);
  private cosmeticLoader = new GLTFLoader();
  private cosmeticSources = new Map<string, Promise<THREE.Object3D>>();
  private compositeMaterial!: THREE.ShaderMaterial;
  private dashboardLoadVersion = 0;
  private danglerLoadVersion = 0;
  private garageLoadVersion = 0;
  private hornLoadVersion = 0;

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
  private ornament: THREE.Group | null = null;
  private dangler: THREE.Group | null = null;
  private hornVisual: THREE.Object3D | null = null;
  private cockpitMirror: THREE.Group | null = null;
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
  private freeLook = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;
  private lookDragYaw = 0;
  private lookDragPitch = 0;
  private lookSensitivity = Number(localStorage.getItem('discipline-look-sensitivity') ?? '1.5');
  private fovScale = Number(localStorage.getItem('discipline-fov') ?? '100') / 100;
  private reducedMotion = localStorage.getItem('discipline-reduced-motion') === '1';
  // must be a Camera: Camera.lookAt aims -z (view direction), Object3D aims +z
  private gazeHelper = new THREE.PerspectiveCamera();

  /** Start a new absolute drag gesture from the view currently on screen. */
  beginTapLook() {
    if (!this.freeLook) {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.lookYaw = Math.atan2(dir.x, -dir.z);
      this.lookPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.lookTargetYaw = this.lookYaw;
      this.lookTargetPitch = this.lookPitch;
      this.freeLook = true;
    }
    this.lookDragYaw = this.lookTargetYaw;
    this.lookDragPitch = this.lookTargetPitch;
  }

  /** Apply total drag displacement. The rendered scene follows the finger,
   * matching direct-manipulation scrolling: right moves content right and
   * down moves content down. */
  tapLook(totalDx: number, totalDy: number) {
    if (!this.freeLook) this.beginTapLook();
    const s = this.lookSensitivity;
    this.lookTargetYaw = this.lookDragYaw - totalDx * 0.0065 * s;
    this.lookTargetPitch = THREE.MathUtils.clamp(this.lookDragPitch + totalDy * 0.0052 * s, -0.75, 0.75);
  }

  setViewSettings(fovPercent: number, lookSensitivity: number, reducedMotion: boolean) {
    this.fovScale = THREE.MathUtils.clamp(fovPercent / 100, 0.7, 1.3);
    this.lookSensitivity = THREE.MathUtils.clamp(lookSensitivity, 0.5, 3);
    this.reducedMotion = reducedMotion;
    this.reframe();
  }

  resetTapLook() { this.freeLook = false; }
  streetSwipe(dx: number, dy: number) { this.tapLook(dx, dy); }
  resetLook() { this.resetTapLook(); }

  constructor(canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets us grab devlog screenshots off the canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);

    this.camera = new THREE.PerspectiveCamera(62, 4 / 3, 0.1, 60);
    // Driver's seat POV on a one-way 4-lane road. Player parked in a center
    // lane (x=+2), opponent in the adjacent lane (x=-2) — parallel, side by
    // side, both stopped at the light. The camera (your head) turns: toward
    // the opponent while the light is red, back to the road when it's green.
    this.camera.position.set(1.55, 1.25, 0); // Tap scene faces -z; car-local x=-.45 is its left seat
    this.camera.lookAt(-2.45, 1.3, -0.55);   // straight across at the neighbor

    this.scene.fog = new THREE.Fog(SKIES.day.fog, 10, 55);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x556677, 2.0);
    this.hemi.layers.enable(1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, SKIES.day.sun);
    this.sun.layers.enable(1);
    this.sun.position.set(4, 8, 2);
    this.scene.add(this.sun);

    this.rt = new THREE.WebGLRenderTarget(320, PSX_H, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.rt.depthTexture = new THREE.DepthTexture(320, PSX_H, THREE.UnsignedShortType);
    // Cosmetic models render at half the game's native PSX resolution. When
    // nearest-upscaled into the compositor each cosmetic pixel is exactly 2x
    // the regular scene pixel, matching the approved visual checkpoint.
    this.cosmeticRT = new THREE.WebGLRenderTarget(160, PSX_H / 2, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      depthBuffer: true,
      format: THREE.RGBAFormat,
    });
    this.cosmeticRT.depthTexture = new THREE.DepthTexture(160, PSX_H / 2, THREE.UnsignedShortType);
    const compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture },
        tCosmetics: { value: this.cosmeticRT.texture },
        tSceneDepth: { value: this.rt.depthTexture },
        tCosmeticDepth: { value: this.cosmeticRT.depthTexture },
        uNoir: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
    });
    this.compositeMaterial = compMat;
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

  private cosmeticSource(id: string): Promise<THREE.Object3D> {
    const cached = this.cosmeticSources.get(id);
    if (cached) return cached;
    // These two ultra-thin/rounded Blender exports lost their silhouettes in
    // the 160×120 cosmetic pass. Author their readable geometry explicitly.
    if (id === 'orn_napkin' || id === 'orn_monk' || id === 'horn_air' || id === 'horn_sad') {
      const authored = Promise.resolve(id === 'orn_napkin' ? this.makeReadableNapkin()
        : id === 'orn_monk' ? this.makeReadableBuddha()
          : id === 'horn_air' ? this.makeReadableAirhorn()
            : this.makeReadableViolin());
      this.cosmeticSources.set(id, authored);
      return authored;
    }
    const pending = this.cosmeticLoader.loadAsync(`/assets/cosmetics/${id}.glb`).then(({ scene }) => {
      scene.traverse((node) => {
        node.layers.set(1);
        if (!(node instanceof THREE.Mesh)) return;
        // Preserve the original fuzzy-dice model and all of its authored pips.
        // Only recolor it: lavender plush, dark readable counter dots, dark cord.
        if (id === 'dangle_dice') {
          const name = node.name.toLowerCase();
          const recolor = (material: THREE.Material) => {
            const copy = material.clone() as THREE.MeshStandardMaterial;
            copy.map = null;
            copy.color?.setHex(name.includes('pip') ? 0x24132d
              : (name.includes('cord') || name.includes('knot')) ? 0x746979
                : 0xb98ad8);
            if ('roughness' in copy) copy.roughness = 0.9;
            return copy;
          };
          node.material = Array.isArray(node.material)
            ? node.material.map(recolor)
            : recolor(node.material);
        } else if (id === 'dangle_testing_coals') {
          // The accepted Comfy mesh stores its marled magenta finish directly
          // in COLOR_0. Use those exact colors without scene-light blackouts;
          // the game's pixel pass supplies the intended PSX-style treatment.
          node.material = new THREE.MeshBasicMaterial({
            color: 0xd07aa0,
            vertexColors: Boolean(node.geometry.getAttribute('color')),
            side: THREE.DoubleSide,
          });
        } else if (id === 'dangle_beads' && /bead cord/i.test(node.name)) {
          const recolor = (material: THREE.Material) => {
            const copy = material.clone() as THREE.MeshStandardMaterial;
            copy.map = null;
            copy.color?.setHex(0x746979);
            if ('roughness' in copy) copy.roughness = 0.9;
            return copy;
          };
          node.material = Array.isArray(node.material)
            ? node.material.map(recolor)
            : recolor(node.material);
        }
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if ('flatShading' in material) (material as THREE.MeshStandardMaterial).flatShading = true;
          const map = (material as THREE.MeshStandardMaterial).map;
          if (map) {
            map.magFilter = THREE.NearestFilter;
            map.minFilter = THREE.NearestFilter;
            map.generateMipmaps = false;
          }
          psxify(material, this.cosmeticRes);
          material.needsUpdate = true;
        }
      });
      return scene;
    });
    this.cosmeticSources.set(id, pending);
    return pending;
  }

  private makeReadableNapkin(): THREE.Object3D {
    const g = new THREE.Group();
    const paper = this.mat(0xf4f0e8);
    const shade = this.mat(0xc9c3b8);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.82), paper);
    base.position.y = 0.03; base.rotation.y = 0.18; g.add(base);
    const fold = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.045, 0.36), this.mat(0xffffff));
    fold.position.set(0.12, 0.075, -0.08); fold.rotation.y = -0.20; g.add(fold);
    const crease = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.025, 0.045), shade);
    crease.position.set(-0.05, 0.102, 0.02); crease.rotation.y = 0.65; g.add(crease);
    return g;
  }

  private makeReadableBuddha(): THREE.Object3D {
    const g = new THREE.Group();
    const gold = this.mat(0xd8a72f), robe = this.mat(0xe7c34b), dark = this.mat(0x302118);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m;
    };
    // Wide crossed legs and round belly make the seated Buddha silhouette.
    const l = add(new THREE.CapsuleGeometry(.28, .34, 3, 8), gold, -.20, .17); l.rotation.z = Math.PI / 2;
    const r = add(new THREE.CapsuleGeometry(.28, .34, 3, 8), gold, .20, .17); r.rotation.z = Math.PI / 2;
    add(new THREE.SphereGeometry(.39, 10, 7), robe, 0, .55);
    add(new THREE.SphereGeometry(.24, 10, 7), gold, 0, .94);
    add(new THREE.SphereGeometry(.07, 7, 5), gold, -.23, .95);
    add(new THREE.SphereGeometry(.07, 7, 5), gold, .23, .95);
    add(new THREE.SphereGeometry(.10, 8, 5), dark, 0, 1.18);
    add(new THREE.BoxGeometry(.09, .025, .035), dark, -.08, .98, .22);
    add(new THREE.BoxGeometry(.09, .025, .035), dark, .08, .98, .22);
    const smile = add(new THREE.TorusGeometry(.065, .015, 4, 8, Math.PI), dark, 0, .86, .23);
    smile.rotation.z = Math.PI;
    return g;
  }

  private makeReadableAirhorn(): THREE.Object3D {
    const g = new THREE.Group();
    const chrome = this.mat(0xe9eef0), shade = this.mat(0x77838a);
    const dark = this.mat(0x171b20), red = this.mat(0xb93128);

    // A continuous long trumpet profile gives the item the unmistakable
    // vehicle-air-horn silhouette: narrow throat, long pipe and a wide,
    // visibly hollow bell. The old tank-first silhouette read like a raygun.
    const trumpet = new THREE.Group();
    const profile = [
      new THREE.Vector2(.10, 0), new THREE.Vector2(.09, .18),
      new THREE.Vector2(.085, .82), new THREE.Vector2(.12, 1.10),
      new THREE.Vector2(.22, 1.38), new THREE.Vector2(.43, 1.67),
    ];
    const shell = new THREE.Mesh(new THREE.LatheGeometry(profile, 12), chrome);
    trumpet.add(shell);
    const bellInterior = new THREE.Mesh(new THREE.CylinderGeometry(.39, .39, .025, 12), dark);
    bellInterior.position.y = 1.675; trumpet.add(bellInterior);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.43, .035, 5, 12), shade);
    rim.rotation.x = Math.PI / 2; rim.position.y = 1.69; trumpet.add(rim);
    trumpet.rotation.z = -Math.PI / 2;
    trumpet.position.set(-.72, .56, 0);
    g.add(trumpet);

    // Compact compressor sits below and behind the trumpet instead of forming
    // its main body, matching real single-trumpet 12 V air-horn assemblies.
    const compressor = new THREE.Mesh(new THREE.CylinderGeometry(.20, .20, .48, 10), red);
    compressor.position.set(-.55, .25, .24); g.add(compressor);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.16, .18, .08, 10), dark);
    cap.position.set(-.55, .53, .24); g.add(cap);
    for (const x of [-.38, .42]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(.12, .12, .34), shade);
      foot.position.set(x, .06, 0); g.add(foot);
    }
    return g;
  }

  private makeReadableViolin(): THREE.Object3D {
    const g = new THREE.Group();
    const wood = this.mat(0xb85b25), dark = this.mat(0x382017), string = this.mat(0xe8d8a8);
    const lower = new THREE.Mesh(new THREE.SphereGeometry(.34, 10, 7), wood);
    lower.scale.set(1, 1.15, .32); lower.position.y = .34; g.add(lower);
    const upper = new THREE.Mesh(new THREE.SphereGeometry(.25, 10, 7), wood);
    upper.scale.set(1, 1.05, .32); upper.position.y = .78; g.add(upper);
    const waist = new THREE.Mesh(new THREE.BoxGeometry(.30, .28, .16), wood);
    waist.position.y = .58; g.add(waist);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(.10, .58, .10), dark);
    neck.position.y = 1.18; g.add(neck);
    const peg = new THREE.Mesh(new THREE.BoxGeometry(.20, .18, .12), dark);
    peg.position.y = 1.52; g.add(peg);
    for (const x of [-.025, .025]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(.012, 1.12, .018), string);
      s.position.set(x, .83, .13); g.add(s);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(.30, .06, .12), string);
    bridge.position.set(0, .57, .13); g.add(bridge);
    return g;
  }

  /** Clone and normalize a Blender cosmetic into a physical mount.
   * Dashboard/roof items sit with their lowest vertex on y=0; danglers put
   * their highest vertex at y=0 so their own hanger touches the mirror. */
  private async cosmeticModel(id: string, targetMax: number, hanging = false): Promise<THREE.Group> {
    const content = (await this.cosmeticSource(id)).clone(true);
    // Keep the original authored dice, but make the tiny export gap survive
    // the 160x120 cosmetic pass so the pair cannot read as one wide block.
    if (id === 'dangle_dice') {
      content.traverse((node) => {
        if (node.name.startsWith('Left_')) node.position.x -= 0.22;
        else if (node.name.startsWith('Right_')) node.position.x += 0.22;
      });
    }
    const box = new THREE.Box3().setFromObject(content);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z, 0.0001);
    // Preserve any authoring/export scale on the GLTF root. Replacing the
    // scale outright makes models exported with a non-unit root wildly large.
    content.scale.multiplyScalar(targetMax / longest);
    const fitted = new THREE.Box3().setFromObject(content);
    const center = fitted.getCenter(new THREE.Vector3());
    content.position.x -= center.x;
    content.position.z -= center.z;
    content.position.y -= hanging ? fitted.max.y : fitted.min.y;
    content.traverse((node) => node.layers.set(1));

    // Move this wrapper at placement time. Keeping the fitted offsets on its
    // child prevents a later position.set(...) from erasing normalization and
    // sinking or floating models according to their Blender origin.
    const mount = new THREE.Group();
    mount.name = `cosmetic:${id}`;
    mount.layers.set(1);
    mount.userData.cosmeticContent = content;
    mount.userData.cosmeticId = id;
    mount.userData.hanging = hanging;
    mount.add(content);
    return mount;
  }

  /** Derive six equal dashboard cells and the exact top surface from the real
   * mesh instead of hand-entered coordinates. */
  private dashboardMounts(parent: THREE.Group) {
    const dashboard = parent.getObjectByName('dashboard-surface');
    if (!(dashboard instanceof THREE.Mesh))
      throw new Error('dashboard-surface mesh is missing');
    dashboard.geometry.computeBoundingBox();
    const box = dashboard.geometry.boundingBox;
    if (!box) throw new Error('dashboard-surface has no geometry bounds');
    const minX = dashboard.position.x + box.min.x * dashboard.scale.x;
    const maxX = dashboard.position.x + box.max.x * dashboard.scale.x;
    const minZ = dashboard.position.z + box.min.z * dashboard.scale.z;
    const maxZ = dashboard.position.z + box.max.z * dashboard.scale.z;
    const cellWidth = (maxX - minX) / 6;
    return {
      xs: Array.from({ length: 6 }, (_, index) => minX + cellWidth * (index + 0.5)),
      y: dashboard.position.y + box.max.y * dashboard.scale.y,
      z: dashboard.position.z,
      minX,
      maxX,
      minZ,
      maxZ,
      cellWidth,
    };
  }

  /** Fit a dashboard accessory to the actual surface after applying its
   * requested orientation. This keeps large accessories passenger-side while
   * preventing any edge from hanging beyond the dashboard. */
  private mountDashboardAccessory(
    parent: THREE.Group,
    item: THREE.Group,
    dashboard: ReturnType<GameScene['dashboardMounts']>,
    preferredX: number,
    rotationY = 0,
  ) {
    item.rotation.y = rotationY;
    item.updateWorldMatrix(true, true);
    const localBounds = new THREE.Box3().setFromObject(item);
    const clamp = (value: number, min: number, max: number) =>
      min <= max ? THREE.MathUtils.clamp(value, min, max) : (min + max) * 0.5;
    const x = clamp(
      preferredX,
      dashboard.minX - localBounds.min.x,
      dashboard.maxX - localBounds.max.x,
    );
    const z = clamp(
      dashboard.z,
      dashboard.minZ - localBounds.min.z,
      dashboard.maxZ - localBounds.max.z,
    );
    item.position.set(x, dashboard.y, z);
    parent.add(item);
  }

  private danglingBodyBounds(item: THREE.Object3D): THREE.Box3 {
    item.updateWorldMatrix(true, true);
    const itemWorldInverse = item.matrixWorld.clone().invert();
    const body = new THREE.Box3();
    const point = new THREE.Vector3();
    item.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !node.visible) return;
      // Connector geometry is normalized independently below. Including dark
      // Blender cords, knots, or hanger rings here would align those invisible
      // pixels instead of the recognizable body.
      if (/cord|hanger|knot/i.test(node.name) || node.name === 'pixel-censor-filter') return;
      node.geometry.computeBoundingBox();
      const bounds = node.geometry.boundingBox;
      if (!bounds) return;
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            point.set(x, y, z)
              .applyMatrix4(node.matrixWorld)
              .applyMatrix4(itemWorldInverse);
            body.expandByPoint(point);
          }
    });
    if (body.isEmpty()) throw new Error('mirror dangler has no visible body bounds');
    return body;
  }

  /** Replace origin-dependent, nearly invisible GLB top cords with one short,
   * readable physical attachment. The visible body—not an invisible cord—now
   * determines where every accessory hangs. */
  private compactDanglerToMirror(item: THREE.Group) {
    const content = item.userData.cosmeticContent as THREE.Object3D | undefined;
    if (!content) throw new Error('fitted mirror dangler content is missing');
    item.traverse((node) => {
      if (/cord|hanger|knot/i.test(node.name)) node.visible = false;
    });
    const body = this.danglingBodyBounds(item);
    const center = body.getCenter(new THREE.Vector3());
    const shortDrop = 0.026;
    content.position.x -= center.x;
    content.position.z -= center.z;
    content.position.y += -shortDrop - body.max.y;

    // Six pixels wide in the cosmetic pass at the normal mirror distance:
    // dark enough to read as a cord, light enough not to disappear on the
    // garage wall. Its top is exactly the mirror's bottom-center anchor.
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0065, 0.0065, shortDrop, 5),
      this.mat(0x746979),
    );
    cord.name = 'Short Mirror Cord';
    cord.position.y = -shortDrop * 0.5;
    cord.layers.set(1);
    item.add(cord);
    item.userData.visibleBodyTop = -shortDrop;
  }

  private danglerTargetMax(style: string): number {
    // The bead strand attaches with its own two top beads and intentionally
    // gets no central cord. Its former .20 height projected onto the dash.
    return style === 'beads' ? 0.14
      : style === 'testing_coals' ? 0.16
        : style === 'dice' ? 0.22 : 0.20;
  }

  /** Tap FPV and Garage use the same bottom-center mirror attachment path. */
  private mountDangler(mirror: THREE.Group, item: THREE.Group, style: string) {
    const anchor = mirror.getObjectByName('dangler-anchor');
    if (!(anchor instanceof THREE.Group))
      throw new Error('rear-view mirror dangler anchor is missing');
    if (style === 'testing_coals') {
      const content = item.userData.cosmeticContent as THREE.Object3D | undefined;
      if (!content) throw new Error('Testing Coals fitted content is missing');
      // The source OBJ is Z-up. Convert it once to the game's Y-up cabin,
      // then present the accepted 135-degree reference side toward the driver
      // in each of the two oppositely oriented cockpits.
      const driverFacingYaw = mirror.userData.facing < 0
        ? -1.42244334
        : 1.92914931;
      content.rotation.set(-Math.PI / 2, driverFacingYaw, 0, 'YXZ');
    }
    // These authored faces point along +z; turn their readable face toward the
    // driver-facing mirror anchor without changing the geometry.
    if (style === 'dice' || style === 'yinyang' || style === 'fire')
      item.rotation.y = mirror.userData.facing < 0 ? Math.PI : 0;
    if (style !== 'beads') this.compactDanglerToMirror(item);
    // Real mirror accessories attach behind the shell. This inset hides the
    // mounting tip and, in the driver's actual projection, leaves visible air
    // between the accessory and the dashboard instead of a false contact.
    item.position.y = style === 'beads' ? 0.024
      : style === 'testing_coals' ? 0.060 : 0.040;
    item.userData.mirrorShellInset = item.position.y;
    if (style === 'censored') this.addCensorFilter(item);
    anchor.add(item);
    return item;
  }

  private dashboardAsset(value: string): { id: string; size: number } | null {
    return ({
      '#e8e4d8': { id: 'orn_napkin', size: 0.26 },
      '#7a4a9e': { id: 'orn_cowboy', size: 0.24 },
      '#e8862a': { id: 'orn_cone', size: 0.20 },
      '#e8c84a': { id: 'orn_monk', size: 0.24 },
    } as Record<string, { id: string; size: number }>)[value] ?? null;
  }

  private danglerAsset(style: string): string | null {
    return ({
      dice: 'dangle_dice', beads: 'dangle_beads', yinyang: 'dangle_yinyang',
      fire: 'dangle_fire', censored: 'dangle_censored',
      testing_coals: 'dangle_testing_coals', goop: 'dangle_goop',
    } as Record<string, string>)[style] ?? null;
  }

  /** Camera-facing mosaic limited to the novelty body (not its mirror cord). */
  private addCensorFilter(item: THREE.Object3D) {
    // Keep the novelty and its filter in one pass so the model cannot be
    // composited over the censor afterward. The high renderOrder below then
    // guarantees only a muted silhouette remains visible through the mosaic.
    const body = new THREE.Box3();
    item.updateWorldMatrix(true, true);
    const itemWorldInverse = item.matrixWorld.clone().invert();
    item.traverse((node) => {
      node.layers.set(0);
      if (!(node instanceof THREE.Mesh)) return;
      const materialNames = (Array.isArray(node.material) ? node.material : [node.material])
        .map((material) => material.name.toLowerCase());
      const filterSkin = /filter.skin/i.test(node.name)
        || materialNames.some((name) => name.includes('censor filter'));
      if (filterSkin) {
        // Use one neutral video-style filter, not the old pink body-hugging
        // skins plus a second square over the top.
        node.visible = false;
        return;
      }
      if (/cord|hanger|hanging.ring/i.test(node.name)) return;
      node.geometry.computeBoundingBox();
      const bounds = node.geometry.boundingBox;
      if (!bounds) return;
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            const point = new THREE.Vector3(x, y, z)
              .applyMatrix4(node.matrixWorld)
              .applyMatrix4(itemWorldInverse);
            body.expandByPoint(point);
          }
    });
    if (body.isEmpty()) {
      const worldBody = new THREE.Box3().setFromObject(item);
      for (const x of [worldBody.min.x, worldBody.max.x])
        for (const y of [worldBody.min.y, worldBody.max.y])
          for (const z of [worldBody.min.z, worldBody.max.z])
            body.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(itemWorldInverse));
    }
    const bodySize = body.getSize(new THREE.Vector3());
    const bodyCenter = body.getCenter(new THREE.Vector3());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    const colors = ['#17191d', '#30343a', '#50555d', '#747981', '#24272c'];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = colors[(x * 3 + y * 5 + (x ^ y)) % colors.length];
      ctx.fillRect(x, y, 1, 1);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    const material = new THREE.SpriteMaterial({
      map: texture, transparent: true, opacity: 0.52,
      // The cosmetic compositor uses its depth texture as a visibility mask;
      // writing depth preserves the requested square instead of clipping the
      // mosaic back to the novelty model's silhouette.
      depthTest: false, depthWrite: true,
    });
    const filter = new THREE.Sprite(material);
    filter.name = 'pixel-censor-filter';
    // Authored body bounds are about 2.26 × 2.92 before normalization. A 3.0
    // square covers the item closely while leaving the hanging cord visible.
    const square = Math.max(bodySize.x, bodySize.y, bodySize.z) * 1.08;
    filter.scale.set(square, square, 1);
    filter.position.copy(bodyCenter);
    filter.renderOrder = 50;
    // Render this one deliberate video-style overlay in the main pass. The
    // cosmetic pass rejects pixels outside the underlying model's depth,
    // which would collapse this square back into the uncensored silhouette.
    filter.layers.set(0);
    item.add(filter);
  }

  setHornVisual(style?: string) {
    const version = ++this.hornLoadVersion;
    if (this.hornVisual) { this.hornVisual.parent?.remove(this.hornVisual); this.hornVisual = null; }
    const asset = style === 'violin' ? 'horn_sad' : style === 'airhorn' ? 'horn_air' : null;
    if (!asset) return;
    void this.cosmeticModel(asset, style === 'violin' ? 0.34 : 0.30).then((item) => {
      if (version !== this.hornLoadVersion) return;
      // Horn equipment has its own passenger-side dashboard mount so it never
      // displaces one of the player's six ornament slots.
      const dashboard = this.dashboardMounts(this.cockpit);
      this.mountDashboardAccessory(
        this.cockpit,
        item,
        dashboard,
        dashboard.xs[5],
        style === 'airhorn' ? Math.PI : 0,
      );
      this.hornVisual = item;
    }).catch((error) => console.error(`Unable to load cosmetic ${asset}`, error));
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
  private makeSteeringWheel(radius = 0.09) {
    const steering = new THREE.Group();
    const steeringMat = this.mat(0x26262e);
    steering.add(new THREE.Mesh(new THREE.TorusGeometry(radius, 0.03, 8, 16), steeringMat));
    for (const angle of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.86, 0.022, 0.022), steeringMat);
      spoke.position.x = radius * 0.43;
      spoke.rotation.z = angle;
      steering.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.045, 8), steeringMat);
    hub.rotation.x = Math.PI / 2;
    steering.add(hub);
    return steering;
  }

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
    dash.name = 'dashboard-surface';
    g.add(dash);
    // A-pillars at the windshield line — clear of the left side-window view
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.3, 0.09), this.mat(0x14141a));
      pillar.position.set(side * 1.18, 1.45, -1.35);
      pillar.rotation.x = -0.35;
      g.add(pillar);
    }
    // Steering assembly in front of the driver's (left) seat. Keep the rim
    // completely above and behind the dash: the old wheel was centered inside
    // the dashboard and tilted almost flat, which turned it into huge clipped
    // slabs in the low-resolution first-person render.
    const steering = this.makeSteeringWheel();
    const steeringMat = this.mat(0x26262e);
    steering.position.set(-0.45, 1.10, -0.68);
    steering.rotation.x = -0.28;
    g.add(steering);

    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 8), steeringMat);
    column.position.set(-0.45, 1.02, -0.55);
    column.rotation.x = Math.PI / 2 - 0.28;
    g.add(column);
    // Centered at the top of the windshield, above the driver's sight line.
    this.cockpitMirror = this.addRearViewMirror(g, 0, 1.63, -1.08);
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

  /** Create a deliberately readable, low-poly fuzzy cube.  Image-to-3D
   * reconstruction was rejected for these items because it rounded the dice
   * into blobs; the cube silhouette, pips, and mount are authored explicitly
   * so the same object reads identically in tap FPV and the garage. */
  private makeFuzzyDice(scale = 1, color = 0xb785d6) {
    const g = new THREE.Group();
    const cubeSize = 0.105 * scale;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize), this.mat(color));
    g.add(cube);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x7a0d58, transparent: true, opacity: 0.9 })
    );
    g.add(edge);
    const pip = (x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.010 * scale, 6, 4), this.mat(0x24112f));
      m.position.set(x, y, z); g.add(m);
    };
    const p = cubeSize * 0.24;
    // Top face: five pips. Front face: three pips. They stay visible from the
    // driver's seat while keeping the object unmistakably cubic.
    for (const [x, z] of [[-p, -p], [p, -p], [0, 0], [-p, p], [p, p]]) pip(x, cubeSize / 2 + 0.002, z);
    for (const [x, y] of [[-p, p], [0, 0], [p, -p]]) pip(x, y, cubeSize / 2 + 0.002);
    for (const [y, z] of [[p, -p], [-p, p]]) pip(cubeSize / 2 + 0.002, y, z);
    // A sparse fringe of deterministic fibers softens the silhouette without
    // changing the hard cube volume or creating an organic/blob-like shape.
    const fibers: number[] = [];
    for (let i = 0; i < 48; i++) {
      const t = ((i * 37) % 101) / 100 - 0.5;
      const u = ((i * 61) % 101) / 100 - 0.5;
      const face = i % 6;
      const h = cubeSize / 2 + 0.004;
      if (face === 0) fibers.push(t * cubeSize, h, u * cubeSize);
      else if (face === 1) fibers.push(t * cubeSize, -h, u * cubeSize);
      else if (face === 2) fibers.push(-h, t * cubeSize, u * cubeSize);
      else if (face === 3) fibers.push(h, t * cubeSize, u * cubeSize);
      else if (face === 4) fibers.push(t * cubeSize, u * cubeSize, h);
      else fibers.push(t * cubeSize, u * cubeSize, -h);
    }
    const fiberGeo = new THREE.BufferGeometry();
    fiberGeo.setAttribute('position', new THREE.Float32BufferAttribute(fibers, 3));
    g.add(new THREE.Points(fiberGeo, new THREE.PointsMaterial({ color: 0xd8b6ec, size: 0.006 * scale, sizeAttenuation: true })));
    return g;
  }

  /** Each item is built upward from y=0 so its mount always rests on the dash. */
  private makeDashboardItem(value: string, size: number) {
    const g = new THREE.Group();
    const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z = 0) => {
      const m = new THREE.Mesh(geometry, this.mat(color));
      m.position.set(x, y, z); g.add(m); return m;
    };
    const s = size / 0.06;
    if (value === '#e8e4d8') { // First Napkin Ornament
      const napkin = add(new THREE.BoxGeometry(.13 * s, .014 * s, .11 * s), 0xe8e4d8, 0, .007 * s);
      napkin.rotation.y = .22;
      const fold = add(new THREE.BoxGeometry(.105 * s, .009 * s, .015 * s), 0xb8b1a8, 0, .017 * s, .018 * s);
      fold.rotation.y = .22;
      const corner = add(new THREE.BoxGeometry(.075 * s, .008 * s, .012 * s), 0xffffff, -.018 * s, .020 * s, -.020 * s);
      corner.rotation.y = -.22;
    } else if (value === '#7a4a9e') { // Tiny Steel Cowboy bobblehead
      // Wider brim, tall crown, bandana, moustache, and a squared western
      // jaw keep this unmistakably a cowboy instead of a generic bobblehead.
      add(new THREE.CylinderGeometry(.035 * s, .045 * s, .06 * s, 6), 0x68717e, 0, .03 * s);
      add(new THREE.CylinderGeometry(.045 * s, .05 * s, .045 * s, 7), 0x8e3f46, 0, .075 * s);
      add(new THREE.BoxGeometry(.058 * s, .018 * s, .045 * s), 0x7a4a9e, 0, .098 * s, .036 * s);
      add(new THREE.SphereGeometry(.042 * s, 8, 6), 0xc08a62, 0, .125 * s);
      add(new THREE.SphereGeometry(.006 * s, 5, 4), 0x17171c, -.014 * s, .130 * s, .038 * s);
      add(new THREE.SphereGeometry(.006 * s, 5, 4), 0x17171c, .014 * s, .130 * s, .038 * s);
      add(new THREE.BoxGeometry(.025 * s, .009 * s, .012 * s), 0x3a1d16, 0, .113 * s, .040 * s);
      add(new THREE.CylinderGeometry(.073 * s, .073 * s, .018 * s, 8), 0x30323a, 0, .164 * s);
      add(new THREE.CylinderGeometry(.042 * s, .068 * s, .042 * s, 8), 0x30323a, 0, .190 * s);
      add(new THREE.BoxGeometry(.072 * s, .010 * s, .014 * s), 0x7a4a9e, 0, .183 * s, .040 * s);
    } else if (value === '#e8862a') { // Tiny Traffic Cone
      add(new THREE.CylinderGeometry(.022 * s, .065 * s, .13 * s, 8), 0xe8862a, 0, .065 * s);
      add(new THREE.CylinderGeometry(.075 * s, .075 * s, .012 * s, 8), 0x2b2b30, 0, .006 * s);
      add(new THREE.CylinderGeometry(.049 * s, .052 * s, .015 * s, 8), 0xf2f0e8, 0, .057 * s);
      add(new THREE.CylinderGeometry(.037 * s, .041 * s, .014 * s, 8), 0xf2f0e8, 0, .092 * s);
    } else { // Dashboard Monk
      add(new THREE.CylinderGeometry(.05 * s, .065 * s, .035 * s, 8), 0x7c3f22, 0, .018 * s);
      add(new THREE.CylinderGeometry(.035 * s, .05 * s, .055 * s, 8), 0xe8c84a, 0, .06 * s);
      add(new THREE.BoxGeometry(.07 * s, .012 * s, .018 * s), 0xd39e32, 0, .072 * s, .036 * s);
      add(new THREE.SphereGeometry(.035 * s, 8, 6), 0xc98c58, 0, .112 * s);
      add(new THREE.SphereGeometry(.006 * s, 5, 4), 0x17171c, -.012 * s, .114 * s, .032 * s);
      add(new THREE.SphereGeometry(.006 * s, 5, 4), 0x17171c, .012 * s, .114 * s, .032 * s);
      add(new THREE.CylinderGeometry(.045 * s, .045 * s, .012 * s, 8), 0x7c3f22, 0, .147 * s);
      add(new THREE.ConeGeometry(.018 * s, .035 * s, 7), 0x7c3f22, 0, .170 * s);
    }
    return g;
  }

  setDashboardItems(values: (string | null)[]) {
    const version = ++this.dashboardLoadVersion;
    if (this.ornament) { this.cockpit.remove(this.ornament); this.ornament = null; }
    const rail = new THREE.Group();
    const dashboard = this.dashboardMounts(this.cockpit);
    values.slice(0, 6).forEach((value, i) => {
      if (!value) return;
      const asset = this.dashboardAsset(value);
      if (!asset) return;
      void this.cosmeticModel(asset.id, asset.size).then((item) => {
        if (version !== this.dashboardLoadVersion || this.ornament !== rail) return;
        // Dashboard top is y=.97; normalized items originate at their exact
        // lowest vertex, so every prop physically meets the six-slot rail.
        item.position.set(dashboard.xs[i], dashboard.y, dashboard.z);
        rail.add(item);
      }).catch((error) => console.error(`Unable to load cosmetic ${asset.id}`, error));
    });
    this.cockpit.add(rail);
    this.ornament = rail;
  }

  private addRearViewMirror(parent: THREE.Group, x: number, y: number, z: number, facing = 1, scale = 1) {
    const mirror = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.055), this.mat(0x202026));
    stem.name = 'mirror-stem';
    stem.position.y = 0.12;
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.055), this.mat(0x101014));
    shell.name = 'mirror-shell';
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.455, 0.105),
      new THREE.MeshBasicMaterial({ color: 0xa9c0c8, side: THREE.DoubleSide }));
    glass.name = 'mirror-glass';
    glass.position.z = 0.029 * facing;
    mirror.rotation.x = -0.08;
    mirror.scale.setScalar(scale);
    mirror.add(stem, shell, glass);
    mirror.userData.facing = facing;
    const danglerAnchor = new THREE.Group();
    danglerAnchor.name = 'dangler-anchor';
    // Shell bottom is y=-.08. Following the glass sign puts the attachment on
    // the driver-facing side in both oppositely oriented vehicle scenes.
    danglerAnchor.position.set(0, -0.078, 0.06 * facing);
    mirror.add(danglerAnchor);
    mirror.position.set(x, y, z);
    parent.add(mirror);
    return mirror;
  }

  private makeDangler(style: string): THREE.Group {
    const g = new THREE.Group();
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.28, 5), this.mat(0x202026));
    cord.position.y = -0.14; g.add(cord);
    const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z = 0) => {
      const m = new THREE.Mesh(geometry, this.mat(color));
      m.position.set(x, y, z); g.add(m); return m;
    };
    if (style === 'dice') {
      const dice = new THREE.Group();
      const left = this.makeFuzzyDice(0.72);
      const right = this.makeFuzzyDice(0.72);
      left.position.set(-0.075, -0.32, 0);
      right.position.set(0.075, -0.32, 0);
      dice.add(left, right);
      g.add(dice);
    } else if (style === 'beads') {
      const colors = [0xe84a4a, 0xe8c84a, 0x4ae08a, 0x4a8ae0, 0xb04ae0];
      for (let i = 0; i < 7; i++) add(new THREE.SphereGeometry(0.040, 7, 5), colors[i % colors.length], 0, -0.31 - i * 0.055);
    } else if (style === 'yinyang') {
      // A front-facing medallion reads as yin-yang from the driver's seat;
      // the previous hemispheres looked like a white bowl from the side.
      const r = 0.12;
      const disk = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.018, 20),
        new THREE.MeshBasicMaterial({ color: 0xf2f0e8, side: THREE.DoubleSide }));
      disk.rotation.x = Math.PI / 2; disk.position.set(0, -0.39, 0.012); g.add(disk);
      const black = new THREE.Mesh(new THREE.CircleGeometry(r * .995, 20, Math.PI, Math.PI),
        new THREE.MeshBasicMaterial({ color: 0x16161a, side: THREE.DoubleSide }));
      black.position.set(0, -0.39, 0.024); g.add(black);
      add(new THREE.SphereGeometry(0.022, 7, 5), 0x16161a, 0, -0.45, 0.032);
      add(new THREE.SphereGeometry(0.022, 7, 5), 0xf2f0e8, 0, -0.33, 0.032);
    } else if (style === 'fire') {
      add(new THREE.SphereGeometry(0.085, 10, 7), 0xff5a18, 0, -0.38);
      const flame = add(new THREE.ConeGeometry(0.075, 0.19, 7), 0xffc21c, 0, -0.22);
      flame.rotation.z = 0.14;
      const lick = add(new THREE.ConeGeometry(0.040, 0.12, 6), 0xff8a18, -0.045, -0.20, 0.01);
      lick.rotation.z = -0.25;
      const inner = add(new THREE.ConeGeometry(0.032, 0.10, 6), 0xfff28a, 0.018, -0.15, 0.02);
      inner.rotation.z = -0.10;
    } else if (style === 'censored') {
      // Pink novelty silhouette with a deliberately oversized censor bar.
      add(new THREE.CylinderGeometry(0.040, 0.052, 0.18, 8), 0xf06aa7, 0, -0.37, 0);
      add(new THREE.SphereGeometry(0.070, 8, 6), 0xf06aa7, -0.075, -0.46);
      add(new THREE.SphereGeometry(0.070, 8, 6), 0xf06aa7, 0.075, -0.46);
      add(new THREE.BoxGeometry(0.25, 0.075, 0.14), 0x202026, 0, -0.34, 0.075);
      add(new THREE.BoxGeometry(0.20, 0.018, 0.012), 0x8b315d, 0, -0.30, 0.15);
    } else if (style === 'testing_coals') {
      // Recreate the accepted first-generation Comfy render: two rough,
      // magenta coals stacked vertically with a loose dark loop emerging
      // between them. The procedural texture is deterministic and remains
      // readable after the game's low-resolution cosmetic pass.
      const texSize = 32;
      const pixels = new Uint8Array(texSize * texSize * 4);
      let noiseSeed = 0x51a7c0;
      for (let i = 0; i < texSize * texSize; i++) {
        noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
        const grain = (noiseSeed >>> 24) / 255;
        const dark = grain < 0.34;
        const highlight = grain > 0.88;
        pixels[i * 4] = dark ? 54 : highlight ? 235 : 183 + Math.round(grain * 28);
        pixels[i * 4 + 1] = dark ? 25 : highlight ? 87 : 24 + Math.round(grain * 22);
        pixels[i * 4 + 2] = dark ? 48 : highlight ? 151 : 91 + Math.round(grain * 31);
        pixels[i * 4 + 3] = 255;
      }
      const coalTexture = new THREE.DataTexture(pixels, texSize, texSize, THREE.RGBAFormat);
      coalTexture.wrapS = coalTexture.wrapT = THREE.RepeatWrapping;
      coalTexture.repeat.set(2.2, 1.8);
      coalTexture.magFilter = THREE.NearestFilter;
      coalTexture.minFilter = THREE.NearestFilter;
      coalTexture.generateMipmaps = false;
      coalTexture.needsUpdate = true;
      const coalMaterial = new THREE.MeshLambertMaterial({
        map: coalTexture,
        color: 0xf06aa7,
        flatShading: true,
      });
      psxify(coalMaterial, this.cosmeticRes);
      const coalGeometry = (phase: number) => {
        const geometry = new THREE.IcosahedronGeometry(1, 2);
        const positions = geometry.getAttribute('position');
        const vertex = new THREE.Vector3();
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i);
          const wobble = 1
            + 0.055 * Math.sin(vertex.x * 11.3 + vertex.y * 7.1 + phase)
            + 0.035 * Math.sin(vertex.z * 15.7 - vertex.x * 5.3 + phase * 1.7);
          vertex.multiplyScalar(wobble);
          positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        positions.needsUpdate = true;
        geometry.computeVertexNormals();
        return geometry;
      };
      const topCoal = new THREE.Mesh(coalGeometry(0.7), coalMaterial);
      topCoal.name = 'Testing Coal Top';
      topCoal.scale.set(0.125, 0.145, 0.115);
      topCoal.position.set(0.018, -0.36, 0);
      topCoal.rotation.set(0.10, -0.18, -0.10);
      g.add(topCoal);
      const lowerCoal = new THREE.Mesh(coalGeometry(2.4), coalMaterial.clone());
      lowerCoal.name = 'Testing Coal Bottom';
      lowerCoal.scale.set(0.108, 0.122, 0.105);
      lowerCoal.position.set(0.026, -0.605, 0.002);
      lowerCoal.rotation.set(-0.14, 0.20, 0.12);
      g.add(lowerCoal);
      const looseLoop = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.065, -0.43, 0.018),
        new THREE.Vector3(-0.15, -0.50, 0.020),
        new THREE.Vector3(-0.27, -0.545, 0.022),
        new THREE.Vector3(-0.31, -0.59, 0.020),
        new THREE.Vector3(-0.25, -0.62, 0.018),
        new THREE.Vector3(-0.17, -0.58, 0.018),
        new THREE.Vector3(-0.07, -0.555, 0.016),
      ]);
      const loopMesh = new THREE.Mesh(
        new THREE.TubeGeometry(looseLoop, 18, 0.011, 5, false),
        this.mat(0x424047),
      );
      loopMesh.name = 'Testing Coals Loose Loop';
      g.add(loopMesh);
      const join = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.10, 5),
        this.mat(0x424047),
      );
      join.name = 'Testing Coals Short Join';
      join.position.set(-0.052, -0.505, 0.016);
      join.rotation.z = -0.12;
      g.add(join);
    } else {
      // Explosion goop: an irregular splat cluster with several hanging drips,
      // matching the blobs left on defeated opponent cars.
      add(new THREE.SphereGeometry(0.12, 9, 7), 0x75d13b, -0.045, -0.35);
      add(new THREE.SphereGeometry(0.095, 8, 6), 0x67bf32, 0.070, -0.37);
      add(new THREE.SphereGeometry(0.075, 8, 6), 0x4a9e28, -0.11, -0.40);
      add(new THREE.ConeGeometry(0.034, 0.16, 6), 0x4a9e28, -0.05, -0.53);
      add(new THREE.ConeGeometry(0.027, 0.13, 6), 0x67bf32, 0.08, -0.51);
      add(new THREE.ConeGeometry(0.022, 0.10, 6), 0x75d13b, 0.15, -0.48);
    }
    // One shared scale keeps every mirror accessory readable without letting
    // the flame/goop variants dominate the windshield view.
    g.scale.setScalar(0.65);
    return g;
  }

  setDangler(style?: string) {
    const version = ++this.danglerLoadVersion;
    if (this.dangler) { this.dangler.parent?.remove(this.dangler); this.dangler = null; }
    if (!style) return;
    const asset = this.danglerAsset(style);
    if (!asset) return;
    void this.cosmeticModel(asset, this.danglerTargetMax(style), true).then((item) => {
      if (version !== this.danglerLoadVersion) return;
      const mirror = this.cockpitMirror;
      if (!mirror) throw new Error('Tap rear-view mirror is unavailable');
      this.dangler = this.mountDangler(mirror, item, style);
    }).catch((error) => console.error(`Unable to load cosmetic ${asset}`, error));
  }

  setSky(key?: string) {
    const sky = SKIES[key ?? 'day'] ?? SKIES.day;
    const u = (this.skyMesh.material as THREE.ShaderMaterial).uniforms;
    u.top.value.setHex(sky.top);
    u.bottom.value.setHex(sky.bottom);
    (this.scene.fog as THREE.Fog).color.setHex(sky.fog);
    this.hemi.color.setHex(sky.ambient);
    this.sun.intensity = sky.sun;
    const noir = key === 'noir';
    this.compositeMaterial.uniforms.uNoir.value = noir ? 1 : 0;
    document.body.classList.toggle('film-noir', noir);
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
    // later by the character-art pipeline, keyed by def.spriteSlot.
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

    // All shipped drivers use one real sprite per character. Apply the anger
    // tint in-material instead of probing nonexistent _a0.._a4 files on every
    // tier change (those 404s were especially noisy in the Android WebView).
    const applyCustom = (sprite: THREE.Sprite) => {
      loadCustomSprite(slot, (tex) => {
        if (this.spriteSlot !== slot || sprite !== this.sprite) return;
        const m = sprite.material as THREE.SpriteMaterial;
        m.map = tex;
        m.color.setHex([0xffffff, 0xffd8cc, 0xffb4a0, 0xff8a70, 0xff5a44][a]);
        m.needsUpdate = true;
        this.spriteHasCustom = true;
      });
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
      add(new THREE.BoxGeometry(0.34, 0.14, 0.08), hl, -0.6, noseY, long / 2 + 0.08);
      add(new THREE.BoxGeometry(0.34, 0.14, 0.08), hl, 0.6, noseY, long / 2 + 0.08);
      add(new THREE.BoxGeometry(0.34, 0.12, 0.08), tl, -0.6, tailY, -long / 2 - 0.08);
      add(new THREE.BoxGeometry(0.34, 0.12, 0.08), tl, 0.6, tailY, -long / 2 - 0.08);
    };
    // The cabin is deliberately open so the driver reads through the glass, but
    // the hood, trunk/tailgate, and bumpers are real exterior panels. Keep
    // them when a streamed fleet mesh replaces the procedural shell too.
    const exterior = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = add(geo, m, x, y, z);
      mesh.userData.keep = true;
      return mesh;
    };
    const bumpers = (frontY: number, rearY: number) => {
      const metal = this.mat(0x60656e);
      const highlight = this.mat(0x969aa2);
      const darkMetal = this.mat(0x353941);
      const makeEnd = (z: number, facing: number, y: number) => {
        exterior(new THREE.BoxGeometry(2.12, 0.12, 0.16), metal, 0, y, z);
        exterior(new THREE.BoxGeometry(1.84, 0.035, 0.18), highlight, 0, y + 0.055, z + facing * 0.01);
        // Two vertical overriders and darker rubber corner caps make this read
        // as a physical bumper rather than another body-colored light strip.
        exterior(new THREE.BoxGeometry(0.08, 0.18, 0.20), darkMetal, -0.76, y + 0.025, z + facing * 0.02);
        exterior(new THREE.BoxGeometry(0.08, 0.18, 0.20), darkMetal, 0.76, y + 0.025, z + facing * 0.02);
        exterior(new THREE.BoxGeometry(0.10, 0.12, 0.19), darkMetal, -1.06, y, z);
        exterior(new THREE.BoxGeometry(0.10, 0.12, 0.19), darkMetal, 1.06, y, z);
      };
      makeEnd(long / 2 + 0.14, 1, frontY);
      makeEnd(-long / 2 - 0.14, -1, rearY);
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
      const dashboard = add(new THREE.BoxGeometry(1.66, 0.16, 0.26), dashM,
        0, wy - 0.16, cab.z + 0.52);
      dashboard.name = 'dashboard-surface';
      // steering wheel: a proper ring the driver faces (tilted back toward
      // him), with spokes, mounted in front of the driver against the dash.
      const wheel = this.makeSteeringWheel();
      wheel.name = 'steering-wheel';
      wheel.position.set(0.45, wy - 0.1, cab.z + 0.28);
      // recline the wheel back and up so its face points toward the driver
      // (who sits above/behind it), like a real steering column — the camera,
      // slightly above, then sees it as a foreshortened ring, not facing out.
      wheel.rotation.x = -1.95;
      g.add(wheel);
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
      bumpers(0.46, 0.46);
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
      bumpers(0.5, 0.5);
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
    const roof = P([[roofSpan[0], gls[1][1]], [roofSpan[0], gls[1][1] + 0.1], [roofSpan[1], gls[1][1] + 0.1], [roofSpan[1], gls[1][1]]], 1.84, body); // roof (kept)
    roof.name = 'roof-surface';
    add(new THREE.BoxGeometry(2.02, 0.14, long * 0.96), trim, 0, 0.3, 0);

    // Close the body ahead of and behind the greenhouse. These panels give
    // every silhouette a hood and trunk (or hatch/tailgate) without covering
    // the seats and driver in the middle of the car.
    const rearTop = low[1];
    const rearGlass = gls[0];
    const rearLen = Math.max(0.12, rearGlass[0] - rearTop[0]);
    exterior(new THREE.BoxGeometry(1.74, 0.12, rearLen), body, 0,
      (rearTop[1] + rearGlass[1]) / 2 + 0.01, (rearTop[0] + rearGlass[0]) / 2);
    const frontGlass = gls[gls.length - 1];
    const frontTop = low[low.length - 2];
    const hoodLen = Math.max(0.12, frontTop[0] - frontGlass[0]);
    exterior(new THREE.BoxGeometry(1.74, 0.12, hoodLen), body, 0,
      (frontGlass[1] + frontTop[1]) / 2 + 0.01, (frontGlass[0] + frontTop[0]) / 2);
    // Seal the previously hollow nose and tail. These are body-colour end walls,
    // not replacement bumpers; lamps sit just outside them and remain visible.
    const shellBottom = Math.min(low[0][1], low[low.length - 1][1]);
    const rearWallHeight = Math.max(0.12, rearTop[1] - shellBottom);
    const frontWallHeight = Math.max(0.12, frontTop[1] - shellBottom);
    exterior(new THREE.BoxGeometry(1.9, rearWallHeight, 0.14), body, 0,
      shellBottom + rearWallHeight / 2, -long / 2);
    exterior(new THREE.BoxGeometry(1.9, frontWallHeight, 0.14), body, 0,
      shellBottom + frontWallHeight / 2, long / 2);
    bumpers(s === 'wedge' ? 0.42 : 0.5, s === 'wedge' ? 0.42 : 0.5);
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
  private garageTargetYaw = 0.8;
  private garageTargetPitch = 0.3;
  private garageDragYaw = 0.8;
  private garageDragPitch = 0.3;
  private garageFP = false;
  private fpYaw = 0;          // first-person head yaw (0 = windshield)
  private fpPitch = -0.08;    // slight natural downward gaze at the dash
  private fpTargetYaw = 0;
  private fpTargetPitch = -0.08;
  private fpDragYaw = 0;
  private fpDragPitch = -0.08;
  private fpZoom = 1;         // first-person zoom (FOV scale)
  private garageDist = 5.6;   // third-person orbit radius
  private garageLaptop: THREE.Object3D | null = null; // tap it to open the shop
  onGarageShop?: () => void;  // fired when the garage laptop is tapped
  private garageDecal: THREE.Mesh | null = null;
  private garageOrn: THREE.Group | null = null;
  private garageDangler: THREE.Group | null = null;
  private garageMirror: THREE.Group | null = null;
  private garageRoofSign: THREE.Object3D | null = null;
  private garageHornVisual: THREE.Object3D | null = null;
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
    // Main Tap FPV is the left seat; Garage FPV and its wheel must match.
    const garageWheel = this.garageCar.getObjectByName('steering-wheel');
    if (garageWheel) garageWheel.position.x = 0.45;
    // interior kit so first-person has a real driver's seat view
    // Sedan roof spans z=-.66..46 at y=1.46. Keep the mirror just behind that
    // front edge, with its scaled stem meeting the roof and no exterior overlap.
    // A rear-view mirror belongs on the vehicle centerline, independently of
    // the left-hand driver's seating position.
    this.garageMirror = this.addRearViewMirror(this.garageCar, 0, 1.37, 0.36, -1, 1);
    this.garageCar.position.copy(GO);
    this.scene.add(this.garageCar);
    // NOTE: the procedural car is the customizable one — cosmetics (paint,
    // decal, ornament, goop) apply to it. It remains the only car mesh.
  }

  enterGarage() {
    if (!this.garageBuilt) this.buildGarage();
    this.garageMode = true;
    this.garageFP = false;
  }

  exitGarage() { this.garageMode = false; }

  /** swipe: third-person orbits the car; first-person looks around the cabin */
  beginGarageSwipe() {
    if (this.garageFP) {
      this.fpDragYaw = this.fpTargetYaw;
      this.fpDragPitch = this.fpTargetPitch;
    } else {
      this.garageDragYaw = this.garageTargetYaw;
      this.garageDragPitch = this.garageTargetPitch;
    }
  }

  garageSwipe(totalDx: number, totalDy: number) {
    const s = this.lookSensitivity;
    if (this.garageFP) {
      // The garage car/camera basis is mirrored relative to the street
      // cockpit. Android projection QA therefore requires the opposite yaw
      // sign here for rendered dashboard content to follow the finger.
      this.fpTargetYaw = this.fpDragYaw + totalDx * 0.0065 * s;
      this.fpTargetPitch = Math.min(0.75, Math.max(-0.75, this.fpDragPitch + totalDy * 0.0052 * s));
    } else {
      // Orbiting a subject reverses the apparent screen motion compared with
      // turning a first-person camera. Negate the orbit angle so the car and
      // garage follow the finger exactly like the Tap view does.
      this.garageTargetYaw = this.garageDragYaw - totalDx * 0.0065 * s;
      this.garageTargetPitch = Math.min(0.9, Math.max(0.06, this.garageDragPitch - totalDy * 0.0052 * s));
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
    if (this.garageFP) {
      this.fpYaw = this.fpTargetYaw = this.fpDragYaw = 0;
      this.fpPitch = this.fpTargetPitch = this.fpDragPitch = -0.08;
    } // face the windshield
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

  setGarageCosmetics(decal?: string, dashboardItems: (string | null)[] = [], goop?: string, dangler?: string, roof?: string, horn?: string) {
    if (!this.garageBuilt || !this.garageCar) return;
    const version = ++this.garageLoadVersion;
    if (this.garageDecal) { this.garageCar.remove(this.garageDecal); this.garageDecal = null; }
    if (decal) {
      const tex = canvasTex(256, (g, s) => {
        g.clearRect(0, 0, s, s);
        // Fill the square texture vertically before mapping it onto a wide,
        // shallow windshield plane. A 32px glyph occupied only 1/8 of the
        // texture and collapsed into broken scanline fragments in PSX mode.
        g.font = 'bold 112px monospace';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = '#ffffff';
        g.strokeStyle = '#000000';
        g.lineWidth = 12;
        g.strokeText(decal, s / 2, s / 2, s - 20);
        g.fillText(decal, s / 2, s / 2, s - 20);
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.18),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide,
          depthTest: false, depthWrite: false }));
      // Driver-centred and lifted a hair in front of the windshield. The old
      // sloped plane intersected the low-poly glass/roof, shredding the text.
      m.position.set(-0.45, 1.16, 0.755);
      m.rotation.y = Math.PI; // face the driver; the plane's back side mirrors text
      m.renderOrder = 4;
      this.garageCar.add(m);
      this.garageDecal = m;
    }
    if (this.garageOrn) { this.garageCar.remove(this.garageOrn); this.garageOrn = null; }
    const rail = new THREE.Group();
    const dashboard = this.dashboardMounts(this.garageCar);
    dashboardItems.slice(0, 6).forEach((value, i) => {
      if (!value) return;
      const asset = this.dashboardAsset(value);
      if (!asset) return;
      void this.cosmeticModel(asset.id, asset.size).then((item) => {
        if (version !== this.garageLoadVersion || this.garageOrn !== rail) return;
        // Same six physical mounts as the sedan interior: the exact lowest
        // model vertex rests on the dashboard surface at y=.895.
        // Garage faces the opposite direction from Tap FPV. Reverse the
        // physical X lookup so slot numbers keep the same left-to-right order
        // on screen in both views.
        item.position.set(dashboard.xs[5 - i], dashboard.y, dashboard.z);
        rail.add(item);
      }).catch((error) => console.error(`Unable to load cosmetic ${asset.id}`, error));
    });
    this.garageCar.add(rail);
    this.garageOrn = rail;
    if (this.garageGoopTop) this.garageGoopTop.color.set(goop ?? '#f2f0e8');
    if (this.garageDangler) { this.garageDangler.parent?.remove(this.garageDangler); this.garageDangler = null; }
    if (dangler) {
      const asset = this.danglerAsset(dangler);
      if (asset) void this.cosmeticModel(asset, this.danglerTargetMax(dangler), true).then((item) => {
        if (version !== this.garageLoadVersion) return;
        const mirror = this.garageMirror;
        if (!mirror) throw new Error('Garage rear-view mirror is unavailable');
        this.garageDangler = this.mountDangler(mirror, item, dangler);
      }).catch((error) => console.error(`Unable to load cosmetic ${asset}`, error));
    }
    if (this.garageRoofSign) { this.garageCar.remove(this.garageRoofSign); this.garageRoofSign = null; }
    if (roof === 'taxi') {
      void this.cosmeticModel('roof_taxi', 1.04).then((sign) => {
        if (version !== this.garageLoadVersion) return;
        // The sedan greenhouse peaks at y=1.46 and its roof extrusion is
        // exactly 0.10 high. cosmeticModel normalizes the sign's lowest
        // vertex to y=0, so 1.56 makes both surfaces flush without overlap.
        const roof = this.garageCar!.getObjectByName('roof-surface');
        if (!(roof instanceof THREE.Mesh))
          throw new Error('Garage roof surface is unavailable');
        roof.geometry.computeBoundingBox();
        if (!roof.geometry.boundingBox)
          throw new Error('Garage roof has no geometry bounds');
        const roofTop = roof.position.y
          + roof.geometry.boundingBox.max.y * roof.scale.y;
        sign.position.set(0, roofTop, 0.08);
        this.garageCar!.add(sign);
        this.garageRoofSign = sign;
      }).catch((error) => console.error('Unable to load cosmetic roof_taxi', error));
    }
    if (this.garageHornVisual) { this.garageCar.remove(this.garageHornVisual); this.garageHornVisual = null; }
    const hornAsset = horn === 'violin' ? 'horn_sad' : horn === 'airhorn' ? 'horn_air' : null;
    if (hornAsset) {
      void this.cosmeticModel(hornAsset, horn === 'violin' ? 0.46 : 0.44).then((item) => {
        if (version !== this.garageLoadVersion) return;
        // Passenger-side accessory tray is slightly higher than the six-slot
        // dashboard rail. The former .895 mount buried the entire horn below
        // the dash when viewed from the driver's seat.
        this.mountDashboardAccessory(
          this.garageCar!,
          item,
          dashboard,
          dashboard.xs[0],
          // Garage FPV views the dashboard from the opposite Z side. Rotate
          // both models so the violin strings/bridge and horn face remain
          // player-facing there; Tap uses its own scene-specific orientation.
          Math.PI,
        );
        this.garageHornVisual = item;
      }).catch((error) => console.error(`Unable to load cosmetic ${hornAsset}`, error));
    }
  }

  /** Taps count only while the player's view is aimed at the rival's face. */
  isMakingEyeContact(): boolean {
    if (this.garageMode || this.driving) return false;
    const face = new THREE.Vector3(
      this.opponentAnchor.position.x - 0.45,
      this.spritePos.y + 0.05,
      this.opponentAnchor.position.z - this.spritePos.z,
    );
    const toFace = face.sub(this.camera.position).normalize();
    const view = new THREE.Vector3();
    this.camera.getWorldDirection(view);
    return view.dot(toFace) >= 0.9;
  }

  /** Screen-space center of the exact face point used by the eye-contact gate. */
  eyeContactScreenPoint(): { x: number; y: number } | null {
    const point = new THREE.Vector3(
      this.opponentAnchor.position.x - 0.45,
      this.spritePos.y + 0.05,
      this.opponentAnchor.position.z - this.spritePos.z,
    ).project(this.camera);
    if (![point.x, point.y, point.z].every(Number.isFinite) || point.z < -1 || point.z > 1)
      return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-point.y * 0.5 + 0.5) * rect.height,
    };
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
  private renderPsx(camera: THREE.Camera) {
    camera.layers.set(0);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, camera);

    camera.layers.set(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.cosmeticRT);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, camera);

    camera.layers.set(0);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compScene, this.compCam);
  }

  render(dt: number) {
    this.time += dt;
    this.pulse = Math.max(0, this.pulse - dt * 3.2);

    // garage view: orbit or driver's-seat camera, same PSX pipeline
    if (this.garageMode) {
      const GO = GameScene.GO;
      const ease = 1 - Math.exp(-dt * 30);
      const easeAngle = (value: number, target: number) =>
        value + Math.atan2(Math.sin(target - value), Math.cos(target - value)) * ease;
      if (this.garageFP) {
        this.fpYaw = easeAngle(this.fpYaw, this.fpTargetYaw);
        this.fpPitch += (this.fpTargetPitch - this.fpPitch) * ease;
        // driver's seat with free look: swipe to look around the cabin
        this.garageCam.fov = (62 * this.fovScale) / this.fpZoom;
        this.garageCam.updateProjectionMatrix();
        // Wheel center is z=.38 in the sedan. z=-.30 puts the driver's eye
        // exactly .68 units behind it, matching Tap FPV's wheel distance.
        const eye = new THREE.Vector3(GO.x + 0.45, GO.y + 1.25, GO.z - 0.30);
        this.garageCam.position.copy(eye);
        this.garageCam.lookAt(
          eye.x + Math.sin(this.fpYaw) * Math.cos(this.fpPitch),
          eye.y + Math.sin(this.fpPitch),
          eye.z + Math.cos(this.fpYaw) * Math.cos(this.fpPitch),
        );
      } else {
        this.garageYaw = easeAngle(this.garageYaw, this.garageTargetYaw);
        this.garagePitch += (this.garageTargetPitch - this.garagePitch) * ease;
        const garageFov = 62 * this.fovScale;
        if (this.garageCam.fov !== garageFov) { this.garageCam.fov = garageFov; this.garageCam.updateProjectionMatrix(); }
        const r = this.garageDist;
        this.garageCam.position.set(
          GO.x + Math.sin(this.garageYaw) * Math.cos(this.garagePitch) * r,
          GO.y + 0.6 + Math.sin(this.garagePitch) * r,
          GO.z + Math.cos(this.garageYaw) * Math.cos(this.garagePitch) * r,
        );
        this.garageCam.lookAt(GO.x, GO.y + 0.85, GO.z);
      }
      this.renderPsx(this.garageCam);
      return;
    }

    // opponent shake: tier amplitude + per-tap pulse kick
    const a = this.reducedMotion ? 0 : this.shakeAmp * (1 + this.pulse * 2.5);
    const t = this.time;
    this.opponentGroup.position.x = Math.sin(t * 31) * a;
    this.opponentGroup.position.y = Math.abs(Math.sin(t * 47)) * a * 0.8;
    this.opponentGroup.position.z = Math.cos(t * 23) * a * 0.6;
    this.opponentGroup.rotation.z = Math.sin(t * 39) * a * 0.35;
    this.opponentGroup.rotation.x = Math.cos(t * 27) * a * 0.2;

    // subtle idle sway on the player cam (engine running)
    this.camera.position.y = 1.25 + (this.reducedMotion ? 0 : Math.sin(t * 2.1) * 0.008);

    // head turn: smoothly swing between the opponent's window and the road.
    // Eye contact aims at the DRIVER'S actual head height (buses, cube cars
    // and low wedges all differ), not a fixed line.
    if (this.freeLook) {
      // The gesture target is already absolute; only the camera quaternion is
      // eased below. Keeping one smoothing stage prevents a sluggish double lag.
      this.lookYaw = this.lookTargetYaw;
      this.lookPitch = this.lookTargetPitch;
    }
    const gazeTarget = this.freeLook
      ? new THREE.Vector3(
        this.camera.position.x + Math.sin(this.lookYaw) * Math.cos(this.lookPitch),
        this.camera.position.y + Math.sin(this.lookPitch),
        this.camera.position.z - Math.cos(this.lookYaw) * Math.cos(this.lookPitch),
      )
      : this.gaze === 'opponent'
        ? new THREE.Vector3(this.opponentAnchor.position.x - 0.45, this.spritePos.y + 0.05, this.opponentAnchor.position.z - this.spritePos.z)
        : new THREE.Vector3(this.camera.position.x, 1.15, this.camera.position.z - 30);
    this.gazeHelper.position.copy(this.camera.position);
    this.gazeHelper.lookAt(gazeTarget);
    // During a user drag the view must track the finger immediately; retain
    // the eased head-turn only for autonomous eye contact/road framing.
    if (this.freeLook) this.camera.quaternion.slerp(this.gazeHelper.quaternion, Math.min(1, dt * 28));
    else this.camera.quaternion.slerp(this.gazeHelper.quaternion, Math.min(1, dt * 3.2));

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

    this.renderPsx(this.camera);
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
    this.camera.fov = 2 * Math.atan((h / 2) / Math.max(1, dist)) * (180 / Math.PI) * this.fovScale;
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
    this.cosmeticRT.setSize(Math.max(1, Math.ceil(rw / 2)), PSX_H / 2);
    this.psxRes.set(rw, PSX_H);
    this.cosmeticRes.set(Math.max(1, Math.ceil(rw / 2)), PSX_H / 2);
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
  hairStyle?: 'flat' | 'mohawk' | 'afro' | 'spiky' | 'long' | 'buzz' | 'bald' | 'bob' | 'slick';
  eyes?: string;                       // iris color (default warm brown)
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

// High-detail painterly driver portrait. Drawn at 96px with organic shapes and
// layered light/shadow, then crushed by the PS1 pipeline — reads as a real face
// through the windshield instead of a flat blocky sprite. Identity comes from
// DRIVER_LOOKS (skin/hair/hat/eyes/accessories) so every name looks like itself.
function makeDriverSprite(slot: string, anger = 0): THREE.Sprite {
  const L = lookFor(slot);
  const a = Math.max(0, Math.min(4, anger));
  const skin = lerpHex(L.skin, '#d82818', (a / 4) * 0.75);
  const dark = (c: string, t: number) => lerpHex(c, '#000000', t);
  const lite = (c: string, t: number) => lerpHex(c, '#ffffff', t);
  const hairC = L.hair ?? '#2a2018';
  const eyeC = L.eyes ?? '#4a3320';
  const hs = L.hairStyle ?? 'flat';
  const bald = hs === 'bald' || (!L.hair && !L.hat);

  const S = 96;
  const tex = canvasTex(S, (g) => {
    g.clearRect(0, 0, S, S);
    g.lineJoin = 'round';
    const ell = (cx: number, cy: number, rx: number, ry: number) => {
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
    };
    const CX = 48, CY = 44, RX = 22, RY = 26;   // head ellipse
    const clipHead = () => { g.beginPath(); g.ellipse(CX, CY, RX, RY, 0, 0, Math.PI * 2); g.clip(); };

    if (L.glow) {                                             // radiant aura
      const gr = g.createRadialGradient(CX, CY, 6, CX, CY, 46);
      gr.addColorStop(0, 'rgba(255,246,190,0.55)'); gr.addColorStop(1, 'rgba(255,246,190,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }

    // ---- shoulders / shirt (behind everything) ----
    g.fillStyle = dark(L.shirt, 0.12);
    g.beginPath();
    g.moveTo(8, 96); g.lineTo(20, 74); g.quadraticCurveTo(48, 66, 76, 74); g.lineTo(88, 96);
    g.closePath(); g.fill();
    g.fillStyle = lite(L.shirt, 0.14);                        // shoulder highlight
    g.beginPath(); g.moveTo(20, 74); g.quadraticCurveTo(34, 70, 46, 72); g.lineTo(40, 96); g.lineTo(16, 96); g.closePath(); g.fill();
    g.fillStyle = L.shirt;                                    // collar
    g.beginPath(); g.moveTo(34, 72); g.lineTo(48, 84); g.lineTo(62, 72); g.quadraticCurveTo(48, 70, 34, 72); g.closePath(); g.fill();

    // ---- neck ----
    g.fillStyle = dark(skin, 0.1); g.fillRect(38, 60, 20, 16);
    g.fillStyle = dark(skin, 0.32);                           // jaw shadow on neck
    g.beginPath(); g.ellipse(48, 62, 15, 6, 0, 0, Math.PI * 2); g.fill();

    // ---- ears ----
    if (bald || hs !== 'afro') {
      g.fillStyle = skin; ell(26, 46, 4, 6); ell(70, 46, 4, 6);
      g.fillStyle = dark(skin, 0.28); ell(27, 47, 2, 3); ell(69, 47, 2, 3);
    }

    // ---- head base + modelled shading ----
    g.fillStyle = skin; ell(CX, CY, RX, RY);
    g.save(); clipHead();
    g.fillStyle = dark(skin, 0.16); ell(CX + 11, CY + 4, 16, 25);        // right/core shadow
    g.fillStyle = dark(skin, 0.24); ell(CX, CY + 20, 18, 12);            // under-jaw shadow
    g.fillStyle = lite(skin, 0.18); ell(CX - 8, CY - 8, 11, 14);         // forehead/cheek highlight
    g.fillStyle = lerpHex(skin, '#d8563a', 0.25 + a * 0.12);             // cheek warmth (flushes w/ anger)
    ell(CX - 9, CY + 6, 5, 4); ell(CX + 10, CY + 6, 5, 4);
    g.restore();
    if (L.facePaint) { g.fillStyle = L.facePaint; g.save(); clipHead(); g.fillRect(0, 0, S, S); g.restore(); }

    const eyeY = CY - 2, eL = CX - 9, eR = CX + 9;

    // ---- back hair (behind head, for volume styles) ----
    if (!L.hat && (hs === 'long' || hs === 'afro' || hs === 'bob')) {
      g.fillStyle = dark(hairC, 0.15);
      if (hs === 'afro') ell(CX, CY - 8, 26, 22);
      else { g.beginPath(); g.moveTo(24, 22); g.quadraticCurveTo(16, 60, 24, 78); g.lineTo(72, 78); g.quadraticCurveTo(80, 60, 72, 22); g.closePath(); g.fill(); }
    }

    // ---- eyes ----
    const openBase = a >= 4 ? 2.4 : a >= 3 ? 3.0 : a >= 2 ? 3.8 : 4.6;
    const drawEye = (ex: number) => {
      g.fillStyle = dark(skin, 0.22); ell(ex, eyeY, 6.2, 4.4);           // socket
      g.fillStyle = '#f3efe6'; ell(ex, eyeY, 5.4, openBase);            // sclera
      g.fillStyle = a >= 3 ? '#f0c8b0' : '#f3efe6';
      g.fillStyle = eyeC; ell(ex + 1, eyeY, 2.9, Math.min(2.9, openBase)); // iris (glances toward player)
      g.fillStyle = a >= 3 ? '#3a0808' : '#141414'; ell(ex + 1, eyeY, 1.5, Math.min(1.5, openBase)); // pupil
      g.fillStyle = '#ffffff'; ell(ex + 2.1, eyeY - 1, 0.9, 0.9);        // catchlight
      g.fillStyle = dark(skin, 0.3);                                     // upper lid line
      g.fillRect(ex - 5, eyeY - openBase - 0.5, 10, 1.2);
    };
    if (L.visor) {
      g.fillStyle = dark('#101018', 0); g.save(); clipHead(); g.fillStyle = '#12141c';
      g.fillRect(CX - 18, eyeY - 6, 36, 12); g.restore();
      const gl = a >= 3 ? '#ff6a3a' : '#4ae0c0';
      g.fillStyle = gl; g.fillRect(CX - 16, eyeY - 3, 32, 4);
      g.fillStyle = lite(gl, 0.5); g.fillRect(CX - 16, eyeY - 3, 10, 2);
    } else if (L.shades) {
      g.fillStyle = '#0c0c10'; g.beginPath();
      g.ellipse(eL, eyeY, 7, 5, 0, 0, Math.PI * 2); g.ellipse(eR, eyeY, 7, 5, 0, 0, Math.PI * 2); g.fill();
      g.fillRect(CX - 3, eyeY - 1, 6, 2);                                // bridge
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(eL - 4, eyeY - 3, 4, 2); g.fillRect(eR - 4, eyeY - 3, 4, 2);
      if (a >= 3) { g.fillStyle = '#e02020'; ell(eL, eyeY, 2, 1.5); ell(eR, eyeY, 2, 1.5); }
    } else if (L.eyepatch) {
      drawEye(eR);
      g.fillStyle = '#0d0d0d'; ell(eL, eyeY, 6.5, 5.5);
      g.strokeStyle = '#0d0d0d'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(eL - 8, eyeY - 7); g.lineTo(eR + 8, eyeY + 6); g.stroke();
    } else { drawEye(eL); drawEye(eR); }

    // ---- brows (angle into a V with anger) ----
    if (!L.visor) {
      g.strokeStyle = dark(hairC, 0.1); g.lineWidth = 2.6; g.lineCap = 'round';
      const drop = a * 2.2;
      g.beginPath(); g.moveTo(eL - 6, eyeY - 7 + (a > 0 ? -1 : 0)); g.lineTo(eL + 6, eyeY - 6.5 + drop * 0.5); g.stroke();
      g.beginPath(); g.moveTo(eR + 6, eyeY - 7 + (a > 0 ? -1 : 0)); g.lineTo(eR - 6, eyeY - 6.5 + drop * 0.5); g.stroke();
    }

    // ---- nose ----
    g.fillStyle = dark(skin, 0.16);
    g.beginPath(); g.moveTo(CX - 2, eyeY + 2); g.lineTo(CX - 4, eyeY + 12); g.lineTo(CX + 4, eyeY + 12); g.closePath(); g.fill();
    g.fillStyle = lite(skin, 0.16); g.fillRect(CX - 1, eyeY + 1, 2, 10);  // bridge highlight
    g.fillStyle = dark(skin, 0.34); ell(CX - 3, eyeY + 12, 1.3, 1); ell(CX + 3, eyeY + 12, 1.3, 1); // nostrils

    // ---- facial hair (under mouth) ----
    if (L.beard) {
      g.fillStyle = dark(hairC, 0.05); g.save(); clipHead();
      g.beginPath(); g.moveTo(CX - 17, eyeY + 6); g.quadraticCurveTo(CX, CY + RY + 4, CX + 17, eyeY + 6);
      g.quadraticCurveTo(CX, eyeY + 20, CX - 17, eyeY + 6); g.fill(); g.restore();
    }
    if (L.mustache && !L.mask && !L.bandana) {
      g.fillStyle = dark(hairC, 0.05);
      g.beginPath(); g.moveTo(CX - 9, eyeY + 15); g.quadraticCurveTo(CX, eyeY + 20, CX + 9, eyeY + 15);
      g.quadraticCurveTo(CX, eyeY + 17, CX - 9, eyeY + 15); g.fill();
    }

    // ---- mouth ----
    const my = eyeY + 20;
    if (L.mask || L.bandana) {
      g.fillStyle = L.bandana ? '#9a4234' : (L.hatColor ?? '#20232c');
      g.save(); clipHead();
      g.beginPath(); g.moveTo(CX - 18, eyeY + 4); g.lineTo(CX - 15, CY + RY); g.lineTo(CX + 15, CY + RY); g.lineTo(CX + 18, eyeY + 4);
      g.quadraticCurveTo(CX, eyeY + 12, CX - 18, eyeY + 4); g.fill(); g.restore();
      if (L.bandana) { g.fillStyle = '#742c22'; for (let x = -12; x <= 12; x += 6) ell(CX + x, my, 1.2, 1.2); }
    } else if (a < 3) {
      g.strokeStyle = dark(skin, 0.45); g.lineWidth = 2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(CX - 7 - a, my); g.quadraticCurveTo(CX, my + 1 + a, CX + 7 + a, my); g.stroke();
    } else {
      g.fillStyle = '#3a1414';                                           // open snarl
      g.beginPath(); g.ellipse(CX, my + 1, 9, 5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f0ece0'; g.fillRect(CX - 8, my - 2, 16, 3);        // top teeth
      g.fillStyle = '#2a0e0e'; for (let x = -6; x <= 6; x += 3) g.fillRect(CX + x, my - 2, 1, 3);
    }
    if (L.stubble) {
      g.save(); clipHead(); g.fillStyle = 'rgba(30,22,14,0.4)';
      g.beginPath(); g.moveTo(CX - 16, eyeY + 8); g.quadraticCurveTo(CX, CY + RY + 2, CX + 16, eyeY + 8);
      g.quadraticCurveTo(CX, eyeY + 16, CX - 16, eyeY + 8); g.fill(); g.restore();
    }

    // ---- hair (front) ----
    if (!L.hat && !bald) {
      g.fillStyle = hairC;
      const cap = () => { g.beginPath(); g.ellipse(CX, CY - 12, RX + 1, 16, 0, Math.PI, Math.PI * 2); g.fill(); };
      if (hs === 'flat' || hs === 'slick' || hs === 'bob') {
        cap();
        g.fillRect(CX - RX, CY - 14, 6, hs === 'bob' ? 30 : 16);        // side sweep
        g.fillRect(CX + RX - 5, CY - 14, 5, hs === 'bob' ? 30 : 12);
        if (hs === 'slick') { g.fillStyle = lite(hairC, 0.25); g.fillRect(CX - 12, CY - 20, 20, 3); }
      } else if (hs === 'buzz') {
        g.globalAlpha = 0.9; cap(); g.globalAlpha = 1;
      } else if (hs === 'mohawk') {
        g.beginPath(); g.moveTo(CX - 4, CY - 26); g.lineTo(CX + 4, CY - 26); g.lineTo(CX + 5, CY - 6); g.lineTo(CX - 5, CY - 6); g.closePath(); g.fill();
      } else if (hs === 'afro') {
        ell(CX, CY - 14, RX + 4, 16);
      } else if (hs === 'spiky') {
        cap();
        for (let x = CX - 16; x <= CX + 16; x += 7) { g.beginPath(); g.moveTo(x, CY - 22); g.lineTo(x + 4, CY - 30); g.lineTo(x + 7, CY - 22); g.closePath(); g.fill(); }
      } else if (hs === 'long') {
        cap(); g.fillRect(CX - RX - 1, CY - 16, 6, 40); g.fillRect(CX + RX - 5, CY - 16, 6, 40);
      }
      g.fillStyle = lite(hairC, 0.28);                                   // hair sheen
      g.fillRect(CX - 14, CY - 24, 14, 2);
    }

    // ---- hats ----
    const hc = L.hatColor ?? '#2e2e36';
    if (L.hat === 'cap') {
      g.fillStyle = hc; g.beginPath(); g.ellipse(CX, CY - 14, RX, 12, 0, Math.PI, Math.PI * 2); g.fill();
      g.fillRect(CX - RX, CY - 14, 2 * RX, 4);
      g.fillStyle = dark(hc, 0.2); g.beginPath(); g.ellipse(CX + 14, CY - 10, 14, 4, 0, 0, Math.PI); g.fill(); // brim
    } else if (L.hat === 'beanie') {
      g.fillStyle = hc; g.beginPath(); g.ellipse(CX, CY - 12, RX + 1, 15, 0, Math.PI, Math.PI * 2); g.fill();
      g.fillStyle = lite(hc, 0.12); g.fillRect(CX - RX - 1, CY - 12, 2 * RX + 2, 4);                          // fold
    } else if (L.hat === 'cowboy') {
      g.fillStyle = hc; g.beginPath(); g.ellipse(CX, CY - 8, RX + 12, 6, 0, 0, Math.PI * 2); g.fill();        // brim
      g.beginPath(); g.ellipse(CX, CY - 16, 15, 12, 0, Math.PI, Math.PI * 2); g.fill();                       // crown
      g.fillStyle = dark(hc, 0.25); g.fillRect(CX - 15, CY - 12, 30, 3);
    } else if (L.hat === 'helmet') {
      g.fillStyle = hc; g.beginPath(); g.ellipse(CX, CY - 6, RX + 2, RY - 4, 0, Math.PI, Math.PI * 2); g.fill();
      g.fillStyle = lite(hc, 0.2); ell(CX - 8, CY - 16, 6, 5);
    } else if (L.hat === 'chef') {
      g.fillStyle = hc; g.fillRect(CX - 16, CY - 14, 32, 8);
      ell(CX - 10, CY - 20, 9, 9); ell(CX + 10, CY - 20, 9, 9); ell(CX, CY - 24, 11, 11);
    } else if (L.hat === 'wizard') {
      g.fillStyle = hc; g.beginPath(); g.moveTo(CX, CY - 40); g.lineTo(CX + 18, CY - 8); g.lineTo(CX - 18, CY - 8); g.closePath(); g.fill();
      g.fillStyle = lite(hc, 0.2); g.fillRect(CX - 18, CY - 10, 36, 3);
    } else if (L.hat === 'crown') {
      g.fillStyle = hc; g.beginPath(); g.moveTo(CX - 16, CY - 10); g.lineTo(CX - 16, CY - 20); g.lineTo(CX - 8, CY - 14);
      g.lineTo(CX, CY - 22); g.lineTo(CX + 8, CY - 14); g.lineTo(CX + 16, CY - 20); g.lineTo(CX + 16, CY - 10); g.closePath(); g.fill();
    } else if (L.hat === 'horns') {
      g.fillStyle = hc; g.beginPath(); g.moveTo(CX - 14, CY - 12); g.quadraticCurveTo(CX - 26, CY - 24, CX - 20, CY - 30); g.quadraticCurveTo(CX - 14, CY - 20, CX - 8, CY - 16); g.fill();
      g.beginPath(); g.moveTo(CX + 14, CY - 12); g.quadraticCurveTo(CX + 26, CY - 24, CX + 20, CY - 30); g.quadraticCurveTo(CX + 14, CY - 20, CX + 8, CY - 16); g.fill();
    } else if (L.hat === 'halo') {
      g.strokeStyle = hc; g.lineWidth = 3; g.beginPath(); g.ellipse(CX, CY - 28, 14, 5, 0, 0, Math.PI * 2); g.stroke();
    }
    if (L.headphones) {
      g.strokeStyle = '#1a1a1e'; g.lineWidth = 3; g.beginPath(); g.ellipse(CX, CY - 10, RX + 2, RY - 6, 0, Math.PI, Math.PI * 2); g.stroke();
      g.fillStyle = '#1a1a1e'; g.fillRect(CX - RX - 4, CY - 8, 6, 12); g.fillRect(CX + RX - 2, CY - 8, 6, 12);
    }

    if (a === 4) {                                            // forehead vein
      g.strokeStyle = '#8e1010'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(CX - 8, CY - 16); g.lineTo(CX - 6, CY - 12); g.lineTo(CX - 9, CY - 9); g.stroke();
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
// caches the result. Final hand-made art drops into that
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

// dev-only: expose the face renderer + looks so a contact sheet can be built
// from the console for visual QA (never shipped in prod builds).
if (import.meta.env.DEV) {
  (window as any).__faces = { make: makeDriverSprite, looks: DRIVER_LOOKS };
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
