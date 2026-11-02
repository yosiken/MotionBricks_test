// オフィスのシーン（D:/project/3d_office_scene を tools/setup_office.py で models/office/ にコピーしたもの）。
// 読み込み・マテリアルの差し替え・照明・小物の配置は 3d_office_scene の src/main.js と src/props.js と同じ。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as tex from './officeTextures.js';

const BASE = './models/office';

export async function createOffice(scene, renderer) {
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene.background = new THREE.Color('#cfdcea');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  // 窓の外の景色 (Poly Haven HDRI)。読み込めるまでは単色の空
  new RGBELoader().load(`${BASE}/assets/polyhaven/hdri/modern_buildings_2_2k.hdr`, (t) => {
    t.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = t;
    scene.backgroundIntensity = 0.8;
    scene.backgroundRotation.set(0, Math.PI * 0.5, 0);
  });

  scene.add(new THREE.HemisphereLight('#f4f6ff', '#6b6458', 0.9));
  // 窓 (北側 = -z) から入る天空光
  const sky = new THREE.DirectionalLight('#e6efff', 2.2);
  sky.position.set(-6, 12, -22);
  sky.castShadow = true;
  sky.shadow.mapSize.set(4096, 4096);
  Object.assign(sky.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
  sky.shadow.bias = -0.0004;
  sky.shadow.normalBias = 0.02;
  sky.shadow.radius = 3;
  scene.add(sky, sky.target);

  // ---- ambientCG の PBR テクスチャ。UV は 1 単位 = 1m なので repeat = 1 / 実寸
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const texLoader = new THREE.TextureLoader();
  const withAniso = (t) => { t.anisotropy = anisotropy; return t; };
  function acg(id, map, sizeX, sizeY = sizeX, srgb = false) {
    const t = texLoader.load(`${BASE}/assets/ambientcg/${id}/${id}_1K-JPG_${map}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / sizeX, 1 / sizeY);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return withAniso(t);
  }
  function surface(m, id, size, { normal = 1, roughness = true } = {}) {
    const [sx, sy] = Array.isArray(size) ? size : [size, size];
    m.normalMap = acg(id, 'NormalGL', sx, sy);
    m.normalScale.set(normal, normal);
    if (roughness) {
      m.roughnessMap = acg(id, 'Roughness', sx, sy);
      m.roughness = 1;
    }
  }
  const metal = (m) => surface(m, 'PaintedMetal004', 1, { normal: 0.3, roughness: false });
  const fabric = (size, normal) => (m) => surface(m, 'Fabric028', size, { normal });
  const overrides = {
    M_Carpet: (m) => { m.map = withAniso(tex.carpet()); m.color.set('#ffffff'); surface(m, 'Carpet016', 0.5, { normal: 0.8, roughness: false }); m.roughness = 0.95; },
    M_Ceiling: (m) => { m.map = withAniso(tex.ceiling()); m.color.set('#ffffff'); },
    M_Wall: (m) => { m.map = tex.wall(); m.color.set('#ffffff'); surface(m, 'PaintedPlaster017', [2, 1], { normal: 0.25, roughness: false }); m.roughness = 0.85; },
    M_Steel: metal, M_SteelLight: metal, M_Cabinet: metal, M_Door: metal,
    M_ChairFabric: fabric(0.3, 0.7), M_ChairBlack: fabric(0.3, 0.7), M_Partition: fabric(0.4, 0.5), M_Sofa: fabric(0.3, 0.7),
    M_LightPanel: (m) => {
      const t = acg('OfficeCeiling004', 'Color', 3.6, 3.6, true);
      t.offset.set(1 / 12, 1 / 18);
      m.map = t;
      m.emissiveMap = t;
      m.emissive.set('#ffffff');
      m.emissiveIntensity = 2.2;
    },
    M_Screen: (m) => { m.emissiveMap = tex.screen(); m.map = m.emissiveMap; m.emissive.set('#ffffff'); m.emissiveIntensity = 0.9; m.color.set('#ffffff'); },
  };
  const glassLike = { M_Glass: [0.12, 0.05], M_Frosted: [0.7, 0.4], M_WaterBottle: [0.55, 0.1] };

  const chairData = await fetch(`${BASE}/chairs.json`).then((r) => r.json());
  const [gltf, chairModel] = await Promise.all([
    new GLTFLoader().loadAsync(`${BASE}/office.glb`),
    chairData.model && new GLTFLoader().loadAsync(`${BASE}/${chairData.model}`),
  ]);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const colliders = [], lightSpots = [], propMarkers = [], toRemove = [];
  root.traverse((o) => {
    if (o.name.startsWith('COL_')) { colliders.push(new THREE.Box3().setFromObject(o)); toRemove.push(o); return; }
    if (o.name.startsWith('LIGHT_')) { lightSpots.push(o.getWorldPosition(new THREE.Vector3())); return; }
    if (o.name.startsWith('PROP_')) { propMarkers.push(o); return; }
    if (o.name.startsWith('Outside')) { o.visible = false; return; }
    if (o.name === 'Chairs' && chairModel) { o.visible = false; return; } // 椅子のモデルに置き換える
    if (!o.isMesh) return;
    const m = o.material;
    o.castShadow = o.receiveShadow = true;
    if (glassLike[m.name]) {
      const [opacity, roughness] = glassLike[m.name];
      o.material = new THREE.MeshPhysicalMaterial({
        name: m.name, color: m.color, transparent: true, opacity, roughness, metalness: 0,
        depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.5,
      });
      o.castShadow = false;
      return;
    }
    if (m.name === 'M_LightPanel') o.castShadow = false;
    overrides[m.name]?.(m);
  });
  toRemove.forEach((o) => o.removeFromParent());
  scene.add(root);
  splitDeskIslands(colliders);

  // 天井パネル位置を 6m 四方ごとにまとめて点光源を置く
  const groups = new Map();
  for (const p of lightSpots) {
    const key = `${Math.floor(p.x / 6)}:${Math.floor(p.z / 6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const pts of groups.values()) {
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const light = new THREE.PointLight('#fff6ea', 4 * pts.length, 11, 1.6);
    light.position.set(c.x, 2.45, c.z);
    scene.add(light);
  }
  placeProps(propMarkers, scene); // 待たずに先へ進む

  if (chairModel) placeChairs(chairModel.scene, chairData.chairs, scene);

  // 椅子：座った腰は座面の中心より少し前（SOMA の sit では約 7cm）。座ると椅子の当たり判定に入るので、座っている間は判定しない
  const { seat, seatForward } = chairData;
  const chairs = chairData.chairs.map(({ pos, yaw }) => {
    const c = new THREE.Object3D();
    const ahead = seatForward + 0.07;
    c.position.set(pos[0] + Math.sin(yaw) * ahead, 0, pos[2] + Math.cos(yaw) * ahead);
    c.userData = { yaw, seat };
    return c;
  });
  return { sun: sky, obstacles: [], chairs, colliders, spawn: { x: -1.55, z: 7.4, yaw: Math.PI } };
}

// 椅子のモデルを全部の椅子の位置に置く。メッシュごとに InstancedMesh にまとめる（55 脚 × 4 メッシュを 4 回の描画で）
function placeChairs(model, list, parent) {
  model.updateMatrixWorld(true);
  const place = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  model.traverse((o) => {
    if (!o.isMesh) return;
    const inst = new THREE.InstancedMesh(o.geometry, o.material, list.length);
    list.forEach(({ pos, yaw }, i) => {
      place.compose(new THREE.Vector3(...pos), q.setFromAxisAngle(up, yaw), one);
      inst.setMatrixAt(i, place.multiply(o.matrixWorld));
    });
    inst.castShadow = inst.receiveShadow = true;
    inst.computeBoundingSphere();
    parent.add(inst);
  });
}

// Blender の Empty「PROP_<key>__<n>」を Poly Haven のモデルに置き換える（3d_office_scene の src/props.js と同じ）
const SPECS = {
  pachira_a: { file: 'pachira_aquatica_01', pick: /_a$/ },
  pachira_b: { file: 'pachira_aquatica_01', pick: /_b$/ },
  pachira_c: { file: 'pachira_aquatica_01', pick: /_c$/ },
  pachira_d: { file: 'pachira_aquatica_01', pick: /_d$/ },
  plant1: { file: 'potted_plant_01' },
  plant2: { file: 'potted_plant_02' },
  stationery: { file: 'stationery_supplies', shadow: false },
  note_a4: { file: 'office_notepads', pick: /a4_stack$/, shadow: false },
  note_sticky: { file: 'office_notepads', pick: /sticky_stack$/, shadow: false },
  note_yellow: { file: 'office_notepads', pick: /yellow_pad$/, shadow: false },
  clock: { file: 'wall_clock', ground: false, center: false, shadow: false },
  shelves: { file: 'steel_frame_shelves_01', scale: 0.1 },
  box: { file: 'cardboard_box_01' },
  barchair: { file: 'bar_chair_round_01' },
  sofa: { file: 'sofa_02' },
};

function makeTemplate(gltfScene, spec) {
  const inner = new THREE.Group();
  for (const node of gltfScene.children) {
    if (!spec.pick || spec.pick.test(node.name)) inner.add(node.clone(true));
  }
  inner.scale.setScalar(spec.scale ?? 1);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const c = box.getCenter(new THREE.Vector3());
  if (spec.center !== false) inner.position.set(-c.x, 0, -c.z);
  if (spec.ground !== false) inner.position.y = -box.min.y;
  inner.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = spec.shadow !== false;
      o.receiveShadow = true;
    }
  });
  const root = new THREE.Group();
  root.add(inner);
  return root;
}

async function placeProps(markers, parent) {
  const loader = new GLTFLoader();
  const files = new Map();
  const templates = new Map();
  const keyOf = (m) => m.name.match(/^PROP_(.+)__\d+$/)?.[1];
  for (const m of markers) {
    const spec = SPECS[keyOf(m)];
    if (spec && !files.has(spec.file)) files.set(spec.file, loader.loadAsync(`${BASE}/assets/polyhaven/${spec.file}/${spec.file}_1k.gltf`));
  }
  for (const m of markers) {
    const key = keyOf(m), spec = SPECS[key];
    if (!spec) continue;
    if (!templates.has(key)) templates.set(key, makeTemplate((await files.get(spec.file)).scene, spec));
    const obj = templates.get(key).clone(true);
    m.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
    parent.add(obj);
  }
}

// XZ 平面で 円 vs AABB の押し出し（3d_office_scene の player.js と同じ）。押し出した量を返す。
// 中心が入っている箱は、円が完全に出るまで無視する（立ち上がった直後は椅子と机の判定が重なった中にいるので、
// そこから歩いて出られるように）。ignored は呼び出し側が持ち続ける Set
export function pushOut(p, boxes, radius, ignored = new Set(), base = 0) {
  const x0 = p.x, z0 = p.z;
  const dist2 = (b) => {
    const dx = p.x - THREE.MathUtils.clamp(p.x, b.min.x, b.max.x), dz = p.z - THREE.MathUtils.clamp(p.z, b.min.z, b.max.z);
    return dx * dx + dz * dz;
  };
  for (const b of ignored) if (dist2(b) >= radius * radius) ignored.delete(b);
  for (const b of boxes) if (dist2(b) === 0) ignored.add(b);
  // base：立っている面の高さ。それより低い箱（乗っている机など）は判定しない
  const active = boxes.filter((b) => b.max.y >= base + 0.05 && b.min.y <= base + 1.6 && !ignored.has(b));
  for (let iter = 0; iter < 3; iter++) {
    for (const b of active) {
      const cx = THREE.MathUtils.clamp(p.x, b.min.x, b.max.x);
      const cz = THREE.MathUtils.clamp(p.z, b.min.z, b.max.z);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      p.x += (dx / d) * (radius - d);
      p.z += (dz / d) * (radius - d);
    }
  }
  return [p.x - x0, p.z - z0];
}

// pos から yaw 方向に、当たり判定の箱までの距離（far まで）。base は立っている面の高さ
const ray = new THREE.Ray(), hitPoint = new THREE.Vector3();
export function freeDistance(boxes, pos, yaw, far, base = 0) {
  ray.origin.set(pos.x, base + 0.3, pos.z);
  ray.direction.set(Math.sin(yaw), 0, Math.cos(yaw));
  let best = far;
  for (const b of boxes) {
    if (b.max.y < base + 0.05 || b.min.y > base + 1.6 || b.containsPoint(ray.origin)) continue;
    if (ray.intersectBox(b, hitPoint)) best = Math.min(best, hitPoint.distanceTo(ray.origin));
  }
  return best;
}

// 乗れる面：上面が CLIMB_TOP 以下で、0.5m 四方より広い箱（机・会議テーブル）。(x, z) の真下にある面の高さ（無ければ床の 0）
const CLIMB_TOP = 0.8;
export function groundAt(boxes, x, z) {
  let top = 0;
  for (const b of boxes) {
    if (b.max.y > CLIMB_TOP || b.max.y <= top || b.max.x - b.min.x < 0.5 || b.max.z - b.min.z < 0.5) continue;
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) top = b.max.y;
  }
  return top;
}

// 島型の対面デスク（幅 1.4m、高さ 1.1m）の判定は中央のパネルまで含む 1 つの箱なので、
// 左右の天板（0.725m）と中央のパネル（1.1m）に分け、天板には乗れるようにする（build_office.py の desk_island）
function splitDeskIslands(boxes) {
  for (const b of [...boxes]) {
    const w = b.max.x - b.min.x, d = b.max.z - b.min.z;
    if (Math.abs(b.max.y - 1.1) > 0.01 || Math.abs(Math.min(w, d) - 1.4) > 0.01) continue;
    const alongX = w < d; // 短い向き（幅 1.4m）が x
    const c = alongX ? (b.min.x + b.max.x) / 2 : (b.min.z + b.max.z) / 2;
    const part = (lo, hi, top) => {
      const nb = b.clone();
      nb.max.y = top;
      if (alongX) { nb.min.x = lo; nb.max.x = hi; } else { nb.min.z = lo; nb.max.z = hi; }
      return nb;
    };
    const [lo, hi] = alongX ? [b.min.x, b.max.x] : [b.min.z, b.max.z];
    boxes.splice(boxes.indexOf(b), 1, part(lo, c, 0.725), part(c, hi, 0.725), part(c - 0.02, c + 0.02, 1.1));
  }
}
