import * as THREE from 'three';
import { Character } from './character.js';
import { Input } from './input.js';
import { createWorld, probeObstacle } from './world.js';
import { MotionPlayer } from './motion/player.js';
import { ProceduralGenerator } from './motion/proceduralGenerator.js';

// ?gen=onnx で ONNX/WebGPU 版、?vrm=URL で VRM を読み込む
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
const { sun, obstacles } = createWorld(scene);
const character = new Character(scene);
const input = new Input();

const hud = document.getElementById('hud');
const statEl = document.getElementById('stat');
input.onToggleHud = () => hud.classList.toggle('hidden');

// ---- 生成器 ----
let generator = new ProceduralGenerator();
if (params.get('gen') === 'onnx') {
  try {
    const { OnnxMotionGenerator } = await import('./motion/onnxGenerator.js');
    const g = new OnnxMotionGenerator();
    await g.init();
    generator = g;
  } catch (e) {
    console.error(e);
    statEl.textContent = `ONNX 初期化失敗、ダミーで起動: ${e.message}`;
  }
}
const player = new MotionPlayer(generator);

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
  camTarget.lerp(_v.set(p.x, 1.1, p.z), 1 - Math.exp(-dt * 8));
  const dist = 4.5;
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
  if (moving && !input.crouch && Math.abs(turn) < 0.4 && !player.hasQueuedTag('vault')) {
    const hit = probeObstacle(obstacles, character.root.position, character.yaw);
    if (hit) {
      const dist = hit.dist - player.queuedForward;
      if (dist > 0.2 && dist < 1.6 && hit.height < 1.2) vault = { ...hit, dist };
    }
  }
  modeLabel = vault ? '飛び越え' : input.crouch ? (moving ? 'しゃがみ歩き' : 'しゃがみ')
    : moving ? (input.walk ? '歩き' : 'ダッシュ') : '待機';
  return { turn, speed, crouch: input.crouch, vault };
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// 飛び越えずに障害物へめり込むのを防ぐ（簡易）
const lastSafe = new THREE.Vector3();
function resolveCollision() {
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
  player.update(dt, getControl, character);
  resolveCollision();
  character.update(dt);
  updateCamera(dt);
  renderer.render(scene, camera);

  if ((hudTimer += dt) > 0.15) {
    hudTimer = 0;
    const s = player.stats;
    const tag = player.currentTag === 'vault' ? '飛び越え' : modeLabel;
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
