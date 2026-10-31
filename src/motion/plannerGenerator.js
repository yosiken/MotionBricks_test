// GEAR-SONIC の「Kinematic Planner」ONNX（MotionBricks を一つにまとめたもの）を
// onnxruntime-web (WebGPU) で動かす生成器。
//
// モデル: Hugging Face nvidia/GEAR-SONIC の planner/target_vel/V2/planner_sonic.onnx
// 入出力仕様: GR00T-WholeBodyControl/docs/source/references/planner_onnx.md
//
// 仕組み:
//   直近 4 フレームの G1 qpos（文脈）と、行きたい方向・モード（歩き/走り/しゃがみ…）を渡すと、
//   モデル内部で「1 秒先の目標姿勢」をクリップ集から選び、その間を 24〜64 フレーム（6〜16 トークン）で埋める。
//   出力の先頭 4 フレームは文脈と同じ位置（ブレンド済み）なので、5 フレーム目以降を使う。
import { qposToFrame, standingQpos } from './g1.js';

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

// planner_sonic の mode 番号（docs/source/references/planner_onnx.md）
export const MODE = {
  idle: 0, slowWalk: 1, walk: 2, run: 3, squat: 4, kneelTwoLeg: 5, kneelOneLeg: 6,
  lyingFacedown: 7, handCrawling: 8, idleBoxing: 9, walkBoxing: 10, happy: 17, stealth: 18,
  injured: 19, careful: 20, objectCarrying: 21, crouch: 22, happyDance: 23, zombie: 24,
  point: 25, scared: 26,
};

const MIN_TOKENS = 6, MAX_TOKENS = 16;
const NEEDED_STORAGE_BUFFERS = 10;

export class PlannerGenerator {
  name = 'MotionBricks planner (ONNX / WebGPU)';
  supportsVault = true; // 飛び越えはモデルに無いので、G1 の qpos を手続き的に作って差し込む

  // dataUrl: 重みが外部ファイル（planner_sonic.onnx.data など）に分かれている場合だけ指定する
  constructor({ modelUrl = './models/planner_sonic.onnx', dataUrl = null, take = 10 } = {}) {
    this.modelUrl = modelUrl;
    this.dataUrl = dataUrl;
    this.take = take;  // 1 回の生成で再生キューに足すフレーム数（短いほど操作への反応が速い）
    this.context = Array.from({ length: 4 }, () => standingQpos());
  }

  // ep: 'webgpu' | 'wasm'。省略時は WebGPU があれば webgpu、無ければ wasm（CPU、遅い）
  async init(ep = null) {
    const adapter = ep !== 'wasm' && (await navigator.gpu?.requestAdapter());
    // このモデルには入力 9 個の Concat・出力 9 個の Split があり、1 シェーダで 10 個のストレージバッファを使う。
    // WebGPU の既定上限は 8 なので、アダプタが許す上限まで引き上げたデバイスを onnxruntime に渡す。
    if (adapter && adapter.limits.maxStorageBuffersPerShaderStage < NEEDED_STORAGE_BUFFERS) {
      console.warn(`GPU のストレージバッファ上限が ${adapter.limits.maxStorageBuffersPerShaderStage} しかないので WASM で動かします`);
    }
    ep ??= adapter && adapter.limits.maxStorageBuffersPerShaderStage >= NEEDED_STORAGE_BUFFERS ? 'webgpu' : 'wasm';
    if (ep === 'wasm') this.name = 'MotionBricks planner (ONNX / WASM・CPU)';
    this.ort = await import(ORT_URL);
    this.ort.env.wasm.wasmPaths = ORT_WASM;
    if (ep === 'webgpu') {
      if (!adapter) throw new Error('このブラウザは WebGPU に対応していません');
      const requiredLimits = {};
      for (const k in adapter.limits) if (typeof adapter.limits[k] === 'number') requiredLimits[k] = adapter.limits[k];
      const requiredFeatures = ['shader-f16', 'timestamp-query', 'subgroups'].filter((f) => adapter.features.has(f));
      this.ort.env.webgpu.device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
    }
    this.session = await this.ort.InferenceSession.create(this.modelUrl, {
      executionProviders: [ep],
      graphOptimizationLevel: 'all',
      ...(this.dataUrl && {
        externalData: [{ path: this.dataUrl.split('/').pop().split('?')[0], data: this.dataUrl }],
      }),
    });
    console.log('planner inputs', this.session.inputNames, 'outputs', this.session.outputNames);
  }

  // control: { moving, yaw（目標の向き。three 座標で +Z が 0）, speed: 0/1/2, crouch, vault }
  async generate(control) {
    const { Tensor } = this.ort;
    const last = this.context[3];
    const currentYaw = 2 * Math.atan2(last[6], last[3]); // 直立前提で Z 軸まわりの角度

    // three の yaw → MuJoCo の方向ベクトル（X 前 / Y 左）
    const yaw = control.moving ? control.yaw : currentYaw;
    const dir = [Math.cos(yaw), Math.sin(yaw), 0];
    const move = control.moving ? dir : [0, 0, 0];

    let mode = MODE.idle, height = -1;
    if (control.crouch) {
      if (control.moving) mode = MODE.crouch;
      else { mode = MODE.squat; height = 0.55; }
    } else if (control.moving) {
      mode = control.speed >= 2 ? MODE.run : MODE.walk;
    }
    // 公開されている mode に「飛び越え」は無いので、vault のときは助走だけプランナーに作らせ、
    // 踏み切り以降は vaultQpos() で G1 の qpos を直接作る（着地の末尾 4 フレームが次の文脈になる）。

    const ctx = new Float32Array(4 * 36);
    this.context.forEach((q, i) => ctx.set(q, i * 36));

    const feeds = {
      context_mujoco_qpos: new Tensor('float32', ctx, [1, 4, 36]),
      target_vel: new Tensor('float32', new Float32Array([-1]), [1]),
      mode: new Tensor('int64', new BigInt64Array([BigInt(mode)]), [1]),
      movement_direction: new Tensor('float32', new Float32Array(move), [1, 3]),
      facing_direction: new Tensor('float32', new Float32Array(dir), [1, 3]),
      height: new Tensor('float32', new Float32Array([height]), [1]),
      random_seed: new Tensor('int64', new BigInt64Array([BigInt((Math.random() * 10000) | 0)]), [1]),
      has_specific_target: new Tensor('int64', new BigInt64Array([0n]), [1, 1]),
      specific_target_positions: new Tensor('float32', new Float32Array(12), [1, 4, 3]),
      specific_target_headings: new Tensor('float32', new Float32Array(4), [1, 4]),
      allowed_pred_num_tokens: new Tensor('int64',
        new BigInt64Array(MAX_TOKENS - MIN_TOKENS + 1).fill(1n), [1, MAX_TOKENS - MIN_TOKENS + 1]),
    };
    // モデルのバージョン違いに備えて、実際にある入力だけ渡す
    for (const name of Object.keys(feeds)) if (!this.session.inputNames.includes(name)) delete feeds[name];

    const out = await this.session.run(feeds);
    const qpos = out.mujoco_qpos.data;
    const numFrames = Number(out.num_pred_frames.data[0]);

    let end = Math.min(numFrames, 4 + this.take);
    let vault = null;
    if (control.vault) {
      // 障害物の大きさはワールド単位なので G1 のメートルに直す
      const s = control.g1Scale ?? 1;
      const v = { yaw: control.vault.yaw, height: control.vault.height / s, depth: control.vault.depth / s };
      const takeoff = control.vault.dist / s - TAKEOFF;
      const dx = Math.cos(v.yaw), dy = Math.sin(v.yaw);
      // 助走：プランナーの出力のうち、踏み切り位置に届くまでのフレームを使う
      for (let f = 4; f < numFrames; f++) {
        const progress = (qpos[f * 36] - last[0]) * dx + (qpos[f * 36 + 1] - last[1]) * dy;
        if (progress >= takeoff) { end = f; vault = v; break; }
      }
    }

    const frames = [];
    for (let f = 4; f < end; f++) {
      const q = qpos.slice(f * 36, (f + 1) * 36);
      frames.push({ ...qposToFrame(q), qpos: q });
    }
    if (vault) {
      const base = frames.at(-1)?.qpos ?? last;
      for (const { q, tag } of vaultQpos(base, vault)) frames.push({ ...qposToFrame(q), qpos: q, tag });
    }
    // 次の文脈 = 今回キューに足した末尾 4 フレーム
    this.context = frames.slice(-4).map((f) => f.qpos);
    return { frames, tokens: numFrames / 4 };
  }
}

// ---- 飛び越え（G1 の qpos を直接作る） ----
const TAKEOFF = 0.45; // 障害物の手前何 m で踏み切るか（G1 のメートル）

// 空中で畳む姿勢（関節インデックス → 角度）。G1 は股関節ピッチが負で脚が前、膝は正で曲がる。
const TUCK = {
  0: -1.4, 3: 2.0, 4: -0.4,   // 左脚（前に抱える）
  6: -1.1, 9: 1.7, 10: -0.3,  // 右脚
  14: 0.3,                    // 上体を前に倒す
  15: -0.9, 22: -0.9,         // 腕を前に出す
};
// 着地で沈み込む量（最大値）
const LAND = { 0: -0.5, 3: 0.9, 4: -0.4, 6: -0.5, 9: 0.9, 10: -0.4, 14: 0.15 };

// base（踏み切りの qpos）から、放物線で障害物を越えて着地するまでのフレーム列を作る
function vaultQpos(base, { yaw, height, depth }) {
  const out = [];
  const dx = Math.cos(yaw), dy = Math.sin(yaw);
  const z0 = base[2];
  const air = TAKEOFF + depth + 0.6;           // 踏み切りから着地までの水平距離
  const n = Math.round((0.45 + 0.35 * height + 0.1 * depth) * 30);
  const peak = Math.max(z0 + 0.1, height + 0.45); // 脚を畳めば、足先は骨盤の約 0.35m 下
  const jumpQuat = new Float32Array(4);

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const arc = Math.sin(Math.PI * t);
    const q = base.slice();
    q[0] = base[0] + dx * air * t;
    q[1] = base[1] + dy * air * t;
    q[2] = z0 + (peak - z0) * arc;
    // 向きは踏み切りの yaw に揃え、空中では少し前傾する
    yawPitchQuat(yaw, 0.25 * arc, jumpQuat);
    nlerpQuat(base, 3, jumpQuat, Math.min(1, arc * 3), q);
    const w = Math.pow(arc, 0.7);
    for (const [j, a] of Object.entries(TUCK)) q[7 + +j] = base[7 + +j] * (1 - w) + a * w;
    out.push({ q, tag: 'vault' });
  }

  // 着地：前に進みながら膝を曲げて沈み込み、元の姿勢に戻る
  const landEnd = out.at(-1).q;
  const step = (air / n) * 0.6;
  for (let i = 1; i <= 8; i++) {
    const k = Math.sin((Math.PI * i) / 9);
    const q = landEnd.slice();
    q[0] = landEnd[0] + dx * step * i;
    q[1] = landEnd[1] + dy * step * i;
    q[2] = z0 - 0.12 * k;
    for (const [j, a] of Object.entries(LAND)) q[7 + +j] = base[7 + +j] + a * k;
    out.push({ q, tag: 'land' });
  }
  return out;
}

// MuJoCo の (w, x, y, z)：Z 軸まわりに yaw、そのあと機体の Y 軸まわりに pitch（正で前傾）
function yawPitchQuat(yaw, pitch, out) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  out[0] = cy * cp; out[1] = -sy * sp; out[2] = cy * sp; out[3] = sy * cp;
  return out;
}

// q[off..off+4] と b を t で補間して q に書き込む（正規化つき線形補間）
function nlerpQuat(a, off, b, t, q) {
  const sign = a[off] * b[0] + a[off + 1] * b[1] + a[off + 2] * b[2] + a[off + 3] * b[3] < 0 ? -1 : 1;
  let len = 0;
  for (let i = 0; i < 4; i++) {
    q[off + i] = a[off + i] * (1 - t) + sign * b[i] * t;
    len += q[off + i] ** 2;
  }
  len = Math.sqrt(len);
  for (let i = 0; i < 4; i++) q[off + i] /= len;
}
