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

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

// planner_sonic の mode 番号（docs/source/references/planner_onnx.md）
export const MODE = {
  idle: 0, slowWalk: 1, walk: 2, run: 3, squat: 4, kneelTwoLeg: 5, kneelOneLeg: 6,
  lyingFacedown: 7, handCrawling: 8, idleBoxing: 9, walkBoxing: 10, happy: 17, stealth: 18,
  injured: 19, careful: 20, objectCarrying: 21, crouch: 22, happyDance: 23, zombie: 24,
  point: 25, scared: 26,
};

const MIN_TOKENS = 6, MAX_TOKENS = 16;

export class PlannerGenerator {
  name = 'MotionBricks planner (ONNX / WebGPU)';

  // dataUrl: 重みが外部ファイル（planner_sonic.onnx.data など）に分かれている場合だけ指定する
  constructor({ modelUrl = './models/planner_sonic.onnx', dataUrl = null, take = 10 } = {}) {
    this.modelUrl = modelUrl;
    this.dataUrl = dataUrl;
    this.take = take;  // 1 回の生成で再生キューに足すフレーム数（短いほど操作への反応が速い）
    this.context = Array.from({ length: 4 }, () => standingQpos());
  }

  async init() {
    if (!navigator.gpu) throw new Error('このブラウザは WebGPU に対応していません');
    this.ort = await import(ORT_URL);
    this.ort.env.wasm.wasmPaths = ORT_WASM;
    this.session = await this.ort.InferenceSession.create(this.modelUrl, {
      executionProviders: ['webgpu'],
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
    // TODO: 公開されている mode に「飛び越え」は無い。specific_target_* で障害物の向こうを
    //       目標にする方法は未検証なので、今は vault を無視する。

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

    const frames = [];
    const end = Math.min(numFrames, 4 + this.take);
    for (let f = 4; f < end; f++) {
      const q = qpos.slice(f * 36, (f + 1) * 36);
      frames.push({ ...qposToFrame(q), qpos: q });
    }
    // 次の文脈 = 今回キューに足した末尾 4 フレーム
    this.context = frames.slice(-4).map((f) => f.qpos);
    return { frames, tokens: numFrames / 4 };
  }
}
