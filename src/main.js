import * as THREE from 'three';
import { Character } from './character.js';
import { Input, STYLES } from './input.js';
import { createWorld, probeObstacle } from './world.js';
import { MotionPlayer } from './motion/player.js';
import { ProceduralGenerator } from './motion/proceduralGenerator.js';

// 既定は MotionBricks の SOMA モデル（models/mmm_v6_soma_fp16.onnx と models/soma_assets.json）。
// ?gen=dummy で手続き的ダミー、?gen=planner で GEAR-SONIC のプランナー（G1）、?gen=g1test で G1 リターゲットのテスト、
// ?model=URL で ONNX、?modelData=URL でその外部重みファイル、?vrm=URL で VRM を指定する
// ?ep=webgpu|wasm で推論の実行先を固定する（省略時は WebGPU が無ければ WASM）
// ?scene=boxes で箱と椅子だけのシーン（既定はオフィス。models/office/ が無ければ箱のシーン）
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
let world = null;
if (params.get('scene') !== 'boxes') {
  try {
    const { createOffice } = await import('./office.js');
    world = await createOffice(scene, renderer);
  } catch (e) {
    console.warn('オフィスを読み込めないので、箱のシーンにします（tools/setup_office.py で models/office/ を作る）', e);
  }
}
world ??= createWorld(scene);
const { sun, obstacles, chairs, colliders = [], spawn } = world;
const { pushOut, freeDistance, groundAt } = colliders.length ? await import('./office.js') : {};
const character = new Character(scene);
const input = new Input();

const hud = document.getElementById('hud');
const statEl = document.getElementById('stat');
input.onToggleHud = () => hud.classList.toggle('hidden');

// ---- 生成器 ----
let generator = new ProceduralGenerator();
const gen = params.get('gen') ?? 'soma';
if (gen === 'soma') {
  try {
    const { SomaGenerator } = await import('./motion/somaGenerator.js');
    statEl.textContent = 'MotionBricks（SOMA）を読み込み中…';
    const g = new SomaGenerator(params.get('model') ? { modelUrl: params.get('model') } : {});
    await g.init(params.get('ep'));
    generator = g;
  } catch (e) {
    console.error(e);
    alert(`MotionBricks の初期化に失敗したので、ダミーで起動します: ${e.message}`);
  }
} else if (gen === 'planner' || gen === 'onnx') {
  try {
    const { PlannerGenerator } = await import('./motion/plannerGenerator.js');
    statEl.textContent = 'プランナーの ONNX を読み込み中…';
    const g = new PlannerGenerator({
      modelUrl: params.get('model') ?? './models/planner_sonic.onnx',
      dataUrl: params.get('modelData'),
    });
    await g.init(params.get('ep'));
    generator = g;
  } catch (e) {
    console.error(e);
    alert(`プランナーの初期化に失敗したので、ダミーで起動します: ${e.message}`);
  }
} else if (gen === 'g1test') {
  const { G1TestGenerator } = await import('./motion/g1TestGenerator.js');
  generator = new G1TestGenerator();
}
const player = new MotionPlayer(generator);
let camYaw = 0, camPitch = 0.35;
if (spawn) {
  generator.teleport?.(spawn.x, spawn.z, spawn.yaw);
  character.root.position.set(spawn.x, 0, spawn.z);
  character.yaw = camYaw = spawn.yaw;
}
window.demo = { generator, character, player, world }; // コンソールから状態を見る用

// ---- VRM 読み込み ----
async function loadVRM(url) {
  try {
    await character.loadVRM(url);
  } catch (e) {
    console.error(e);
    alert(`VRM の読み込みに失敗しました: ${e.message}`);
  }
}
// オフィスでは、スタッフ（tools/blend_to_vrm.py で 3d_office_scene の office_lady.fbx から作る）を既定にする
const vrmUrl = params.get('vrm') ?? (spawn ? './models/office_lady.vrm' : null);
if (vrmUrl) loadVRM(vrmUrl);
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) {
    const url = URL.createObjectURL(file);
    loadVRM(url).finally(() => URL.revokeObjectURL(url));
  }
});

// ---- カメラ（ドラッグで回転する三人称カメラ） ----
let dragging = false;
renderer.domElement.addEventListener('pointerdown', () => { dragging = true; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camYaw -= e.movementX * 0.005;
  camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.004, 0.05, 1.2);
});
const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const p = character.root.position;
  // 注視点と距離はキャラクターの体格（腰の高さ）に合わせる。マネキン（0.95m）で高さ 1.1m・距離 4.5m
  const size = character.hipsHeight / 0.95;
  // 机の上に立っているときは、その高さだけ上げる
  camTarget.lerp(_v.set(p.x, (colliders.length ? 1.2 : 1.1) * size + (generator.height ?? 0), p.z), 1 - Math.exp(-dt * 8));
  const back = _dir.set(-Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), -Math.cos(camYaw) * Math.cos(camPitch));
  let dist = (colliders.length ? 3.6 : 4.5) * size;
  // 室内では、壁や家具にめり込まないよう注視点から後ろへレイを飛ばして縮める
  _ray.set(camTarget, back);
  for (const b of colliders) if (b.max.y > 1 && _ray.intersectBox(b, _hit)) dist = Math.min(dist, Math.max(0.4, _hit.distanceTo(camTarget) - 0.15));
  camDist = dist < camDist ? dist : THREE.MathUtils.lerp(camDist, dist, 1 - Math.exp(-dt * 4));
  camera.position.copy(camTarget).addScaledVector(back, camDist);
  if (colliders.length) camera.position.y = Math.min(camera.position.y, 2.55); // 天井 2.7m
  camera.lookAt(camTarget);
  if (!colliders.length) { // 屋外は影の範囲がキャラクターについて行く
    sun.position.set(p.x + 6, 12, p.z + 4);
    sun.target.position.copy(p);
  }
}
const _dir = new THREE.Vector3(), _ray = new THREE.Ray(), _hit = new THREE.Vector3();
let camDist = 4.5;
const _v = new THREE.Vector3();

// ---- 制御信号（生成を投げる瞬間の入力から作る） ----
let modeLabel = '待機';
function getControl() {
  const yaw = input.moveYaw(camYaw);
  const moving = yaw !== null;
  const speed = moving ? (input.run ? 2 : 1) : 0; // 基本は歩き、Shift でダッシュ
  const turn = moving ? wrapAngle(yaw - character.yaw) : 0;

  let vault = null;
  if (generator.supportsVault && moving && !input.crouch && Math.abs(turn) < 0.4 && !player.hasQueuedTag('vault')) {
    const hit = probeObstacle(obstacles, character.root.position, character.yaw);
    if (hit) {
      const dist = hit.dist - player.queuedForward;
      if (dist > 0.2 && dist < 1.6 && hit.height < 1.2) vault = { ...hit, dist, yaw: character.yaw };
    }
  }
  modeLabel = vault ? '飛び越え' : input.crouch ? (moving ? 'しゃがみ歩き' : 'しゃがみ')
    : moving ? (input.run ? 'ダッシュ' : '歩き') : '待機';
  return {
    moving, yaw, turn, speed, crouch: input.crouch, vault, g1Scale: character.g1Scale,
    style: STYLES[input.style][0], styleName: STYLES[input.style][1],
    interact: input.takeInteract(), chair: nearestChair(),
    free: colliders.length ? (y) => freeDistance(colliders, character.root.position, y, 3, generator.height ?? 0) : null,
    ground: colliders.length ? (x, z) => groundAt(colliders, x, z) : null,
  };
}

// 座れる距離（2.5m 以内）にある一番近い椅子の位置と正面の向き
function nearestChair() {
  let best = null, bestDist = 2.5 * (character.hipsHeight / 0.95);
  for (const c of chairs) {
    const d = c.position.distanceTo(character.root.position);
    if (d < bestDist) { bestDist = d; best = { pos: [c.position.x, 0, c.position.z], yaw: c.userData.yaw, seat: c.userData.seat }; }
  }
  return best;
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// SOMA 用：進む向きの先に飛び越えられる箱があれば、その距離・高さ・奥行き（ワールド単位）を返す
function probeForSoma(here, control) {
  if (Math.abs(wrapAngle(control.yaw - character.yaw)) > 0.5) return null;
  const hit = probeObstacle(obstacles, character.root.position, control.yaw);
  if (!hit || hit.dist < 0.9 || hit.dist > 2.6 || hit.height > 1.2) return null;
  return { ...hit, yaw: control.yaw };
}

// 飛び越えずに障害物へめり込むのを防ぐ（簡易）
const lastSafe = new THREE.Vector3();
function resolveCollision() {
  if (player.cur?.root) return; // G1 系は位置をモデルが決めるので押し戻さない（障害物は素通りする）
  const tag = player.currentTag;
  if (tag === 'vault' || tag === 'land') return;
  const hit = probeObstacle(obstacles, character.root.position, character.yaw, 0.3);
  if (hit && hit.height > 0) character.root.position.copy(lastSafe);
  else lastSafe.copy(character.root.position);
}

// ---- メインループ ----
const clock = new THREE.Clock();
const ignoredBoxes = new Set(); // 中にいる当たり判定の箱（立ち上がった直後の椅子と机）
let hudTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  // 椅子はキャラクターの体格に合わせて拡大縮小する（座面 0.4m は SOMA の人体の寸法）
  // オフィスの椅子（seat あり）は動かせないので、座面の高さの違いは生成器が腰を持ち上げて合わせる
  for (const c of chairs) if (!c.userData.seat) c.scale.setScalar(generator.scale ?? 1);
  if (generator.drivesCharacter) {
    generator.update(dt, getControl(), character, probeForSoma);
    // 壁・家具から押し戻す（座る・立つの途中と座っている間は椅子に入るので判定しない）
    if (colliders.length && !generator.seq && !generator.seated) {
      const [dx, dz] = pushOut(character.root.position, colliders, 0.25 * (character.hipsHeight / 0.95), ignoredBoxes, generator.height ?? 0);
      generator.offset.x += dx;
      generator.offset.z += dz;
    }
  } else {
    player.update(dt, getControl, character);
    resolveCollision();
  }
  character.update(dt);
  updateCamera(dt);
  renderer.render(scene, camera);

  if ((hudTimer += dt) > 0.15) {
    hudTimer = 0;
    const s = generator.drivesCharacter ? generator.stats : player.stats;
    const tag = generator.drivesCharacter ? generator.label : player.currentTag === 'vault' ? '飛び越え' : modeLabel;
    statEl.textContent = s.error
      ? `生成エラー: ${s.error}`
      : `今：${tag}　生成 ${s.lastMs.toFixed(0)} ms（${s.tokens}トークン）　回数 ${s.count}　[${generator.name}]`;
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
