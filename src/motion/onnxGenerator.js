// MotionBricks を ONNX に書き出したものを onnxruntime-web (WebGPU) で動かす生成器。
//
// ※ 雛形です。入出力テンソル名・形状・制御信号のエンコードは、書き出したモデルに合わせて
//   TODO 部分を埋めてください（tools/export_onnx.py で書き出したときの名前に揃える）。
//
// 想定するモデル構成:
//   generator.onnx : (cond, history_tokens) -> logits（次トークン）  ※自己回帰ループは JS 側
//   decoder.onnx   : (tokens, prev_pose)    -> rotations, root
import { retargetFrame, SOURCE_JOINTS } from './retarget.js';

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

export class OnnxMotionGenerator {
  name = 'MotionBricks (ONNX / WebGPU)';

  constructor({ generatorUrl = './models/generator.onnx', decoderUrl = './models/decoder.onnx', tokensPerChunk = 11 } = {}) {
    this.generatorUrl = generatorUrl;
    this.decoderUrl = decoderUrl;
    this.tokensPerChunk = tokensPerChunk;
    this.history = [];      // 直前の生成トークン（文脈）
    this.prevPose = null;   // デコーダに渡す直前フレーム
  }

  async init() {
    if (!navigator.gpu) throw new Error('このブラウザは WebGPU に対応していません');
    this.ort = await import(ORT_URL);
    this.ort.env.wasm.wasmPaths = ORT_WASM;
    const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' };
    [this.gen, this.dec] = await Promise.all([
      this.ort.InferenceSession.create(this.generatorUrl, opts),
      this.ort.InferenceSession.create(this.decoderUrl, opts),
    ]);
    console.log('generator inputs', this.gen.inputNames, 'outputs', this.gen.outputNames);
    console.log('decoder inputs', this.dec.inputNames, 'outputs', this.dec.outputNames);
  }

  async generate(control) {
    const { Tensor } = this.ort;

    // 1. 制御信号をモデルの条件ベクトルにする
    // TODO: MotionBricks の primitive の仕様（進行方向・速度・姿勢・障害物など）に合わせる
    const cond = new Float32Array([
      Math.sin(control.turn), Math.cos(control.turn),
      control.speed,
      control.crouch ? 1 : 0,
      control.vault ? 1 : 0,
      control.vault?.dist ?? 0,
      control.vault?.height ?? 0,
      control.vault?.depth ?? 0,
    ]);

    // 2. 自己回帰でトークンを生成（KV キャッシュを使う場合はここで持ち回る）
    const tokens = [];
    for (let i = 0; i < this.tokensPerChunk; i++) {
      const ctx = [...this.history, ...tokens];
      const out = await this.gen.run({
        cond: new Tensor('float32', cond, [1, cond.length]),                                // TODO: 名前・形状
        tokens: new Tensor('int64', BigInt64Array.from(ctx, BigInt), [1, ctx.length]),       // TODO
      });
      tokens.push(sample(out.logits.data)); // TODO: 出力名
    }
    this.history = [...this.history, ...tokens].slice(-64); // TODO: 文脈長

    // 3. トークン → 関節回転・ルート移動
    const out = await this.dec.run({
      tokens: new Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]), // TODO
    });
    const rot = out.rotations.data;  // TODO: [T, J, 4] を想定
    const root = out.root.data;      // TODO: [T, 3] = (前進量, 旋回量, 高さ) を想定
    const J = SOURCE_JOINTS.length;
    const T = root.length / 3;

    // 4. VRM へリターゲット
    const frames = [];
    for (let t = 0; t < T; t++) {
      frames.push(retargetFrame(rot.subarray(t * J * 4, (t + 1) * J * 4), {
        dForward: root[t * 3], dYaw: root[t * 3 + 1], height: root[t * 3 + 2],
        tag: control.vault ? 'vault' : undefined,
      }));
    }
    return { frames, tokens: tokens.length };
  }
}

// 温度付きサンプリング（logits は最後の位置のものを想定）
function sample(logits, temperature = 0.8) {
  let max = -Infinity;
  for (const v of logits) max = Math.max(max, v);
  const p = Array.from(logits, (v) => Math.exp((v - max) / temperature));
  let r = Math.random() * p.reduce((a, b) => a + b, 0);
  for (let i = 0; i < p.length; i++) if ((r -= p[i]) <= 0) return i;
  return p.length - 1;
}
