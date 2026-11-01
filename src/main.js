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
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
const { sun, obstacles, chairs } = createWorld(scene);
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
window.demo = { generator, character, player }; // コンソールから状態を見る用

// ---- VRM 読み込み ----
async function loadVRM(url) {
  try {
    await character.loadVRM(url);
  } catch (e) {
    console.error(e);
    alert(`VRM の読み込みに失敗しました: ${e.message}`);
  }
}
if (params.get('vrm')) loadVRM(params.get('vrm'));
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
let camYaw = 0, camPitch = 0.35;
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
  camTarget.lerp(_v.set(p.x, 1.1 * size, p.z), 1 - Math.exp(-dt * 8));
  const dist = 4.5 * size;
  camera.position.set(
    camTarget.x - Math.sin(camYaw) * Math.cos(camPitch) * dist,
    camTarget.y + Math.sin(camPitch) * dist,
    camTarget.z - Math.cos(camYaw) * Math.cos(camPitch) * dist,
  );
  camera.lookAt(camTarget);
  sun.position.set(p.x + 6, 12, p.z + 4);
  sun.target.position.copy(p);
}
const _v = new THREE.Vector3();

// ---- 制御信号（生成を投げる瞬間の入力から作る） ----
let modeLabel = '待機';
function getControl() {
  const yaw = input.moveYaw(camYaw);
  const moving = yaw !== null;
  const speed = moving ? (input.walk ? 1 : 2) : 0;
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
    : moving ? (input.walk ? '歩き' : 'ダッシュ') : '待機';
  return {
    moving, yaw, turn, speed, crouch: input.crouch, vault, g1Scale: character.g1Scale,
    style: STYLES[input.style][0], styleName: STYLES[input.style][1],
    interact: input.takeInteract(), chair: nearestChair(),
  };
}

// 座れる距離（2.5m 以内）にある一番近い椅子の位置と正面の向き
function nearestChair() {
  let best = null, bestDist = 2.5 * (character.hipsHeight / 0.95);
  for (const c of chairs) {
    const d = c.position.distanceTo(character.root.position);
    if (d < bestDist) { bestDist = d; best = { pos: [c.position.x, 0, c.position.z], yaw: c.userData.yaw }; }
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
let hudTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  // 椅子はキャラクターの体格に合わせて拡大縮小する（座面 0.4m は SOMA の人体の寸法）
  for (const c of chairs) c.scale.setScalar(generator.scale ?? 1);
  if (generator.drivesCharacter) {
    generator.update(dt, getControl(), character, probeForSoma);
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
