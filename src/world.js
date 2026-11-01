// 床・障害物と、進行方向の障害物検出。
import * as THREE from 'three';

export function createWorld(scene) {
  scene.background = new THREE.Color(0x111820);
  scene.fog = new THREE.Fog(0x111820, 18, 55);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2027, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 12, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20 });
  scene.add(sun, sun.target);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x1b232c, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(200, 200, 0x2c3a48, 0x222c36);
  grid.position.y = 0.001;
  scene.add(grid);

  const obstacles = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0x7fa3ad, roughness: 0.7 });
  // [x, z, 幅, 高さ, 奥行き, 回転]。公式の飛び越えに合わせて、0.5m は奥行き 0.7m 以下の台（jump_0_5m は 0.7m 角）、
  // 0.75m は奥行き 0.3m の塀（jump_0_75m は幅 2m・奥行き 0.3m）
  const layout = [
    [0, 6, 3, 0.5, 0.6, 0], [5, 2, 2, 0.75, 0.3, 0.3], [-6, 4, 4, 0.5, 0.4, 1.2],
    [-3, -6, 2, 0.75, 0.3, 0.5], [7, -5, 3, 0.5, 0.5, -0.8], [0, -12, 6, 0.75, 0.3, 0],
    [11, 8, 1.2, 0.5, 0.7, 0], [-10, -2, 2.5, 0.75, 0.3, 0],
  ];
  for (const [x, z, w, h, d, r] of layout) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    box.position.set(x, h / 2, z);
    box.rotation.y = r;
    box.castShadow = box.receiveShadow = true;
    box.userData.height = h;
    scene.add(box);
    obstacles.push(box);
  }

  // 椅子（公式の sit と同じく座面の高さ 0.4m）。[x, z, 正面の向き]
  const chairs = [];
  const wood = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.6 });
  for (const [x, z, yaw] of [[2.5, -2, -Math.PI / 2], [-4, 9, Math.PI]]) {
    const chair = new THREE.Group();
    const part = (w, h, d, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
      m.position.set(px, py, pz);
      m.castShadow = m.receiveShadow = true;
      chair.add(m);
    };
    part(0.46, 0.05, 0.44, 0, 0.375, -0.06);          // 座面（上面 0.4m）。座った腰の少し後ろが中心
    part(0.46, 0.5, 0.04, 0, 0.65, -0.27);            // 背もたれ
    for (const [lx, lz] of [[-0.2, 0.13], [0.2, 0.13], [-0.2, -0.25], [0.2, -0.25]]) part(0.04, 0.35, 0.04, lx, 0.175, lz);
    chair.position.set(x, 0, z);
    chair.rotation.y = yaw;
    chair.userData.yaw = yaw;
    scene.add(chair);
    chairs.push(chair);
  }
  return { sun, obstacles, chairs };
}

const raycaster = new THREE.Raycaster();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();
const back = new THREE.Vector3();

// 位置 pos から yaw 方向に障害物を探す。見つかれば { dist, height, depth }。
export function probeObstacle(obstacles, pos, yaw, far = 5) {
  dir.set(Math.sin(yaw), 0, Math.cos(yaw));
  origin.copy(pos).setY(0.25);
  raycaster.set(origin, dir);
  raycaster.far = far;
  const hit = raycaster.intersectObjects(obstacles, false)[0];
  if (!hit) return null;

  // 奥行き：障害物の向こう側から逆向きにレイを撃って出口を求める
  back.copy(dir).multiplyScalar(-1);
  raycaster.set(origin.clone().addScaledVector(dir, hit.distance + 4), back);
  raycaster.far = 4;
  const exit = raycaster.intersectObject(hit.object, false)[0];
  const depth = exit ? 4 - exit.distance : 0.6;
  return { dist: hit.distance, height: hit.object.userData.height, depth };
}
