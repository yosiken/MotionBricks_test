// MotionBricks（SOMA の人体モデル）でキャラクターを動かす。
//
// 公式ランタイム（NVlabs/motionbricks の runtime/motion_player.py と docs/examples/locomotion_loop.py）と同じ流れ:
//   1. 表示した姿勢を履歴に記録し、直近 4 姿勢（30fps 間隔）を文脈にする
//   2. 操作に合わせて目標姿勢（サンプルモーションから切り出した 4 姿勢）を置く
//      歩き・走りは「1 秒先」、待機はその場、飛び越えは箱を基準に入口 → 踏み切り → 着地、
//      椅子は椅子を基準に座る手前 → 着座（座っている間は着座を目標にし続ける）→ 立ち上がり
//   3. モデルが間を埋めた動きを再生し、終わりの少し手前（transition）で次を生成する
// 生成は非同期なので、決まった乗り換え（終わりの少し手前）は、乗り換え時点の 4 姿勢を今の動きから先に取り出して
// 推論を始め、結果はその時点から再生する（推論の遅れで目標の段が切り詰められない）。
// 操作が変わったときなどのすぐの生成は、結果が届いた時点の経過時間だけ先から再生し、古い動きから 0.2 秒でつなぐ。
//
// 目標姿勢は tools/build_soma_assets.py が作る models/soma_assets.json から読む。
import {
  Skeleton, encode, decode, correctEndpoints, samplePose, blendPose, placePoses,
  tget, qmul, qinv, qAxisY, FPS,
} from './soma.js';

const ORT_VERSION = '1.30.0';
const NEEDED_STORAGE_BUFFERS = 10;
const LEAD_SECONDS = 1.0;      // 歩き・走りの目標を何秒先に置くか
const TURN_THRESHOLD = 15;     // 向きがこれ以上変わったら作り直す（度）
const BLEND_SECONDS = 0.2;     // 新しい動きへのつなぎ
const HISTORY = 32;
const MAX_JUMP_HEIGHT = 0.95;  // 飛び越える箱の高さの上限（SOMA の人体の寸法、メートル）

// VRM の正規化ボーン ← SOMA の関節
const VRM_MAP = [
  ['hips', 'Hips'], ['spine', 'Spine1'], ['chest', 'Spine2'], ['upperChest', 'Chest'],
  ['neck', 'Neck1'], ['head', 'Head'],
  ['leftShoulder', 'LeftShoulder'], ['leftUpperArm', 'LeftArm'], ['leftLowerArm', 'LeftForeArm'], ['leftHand', 'LeftHand'],
  ['rightShoulder', 'RightShoulder'], ['rightUpperArm', 'RightArm'], ['rightLowerArm', 'RightForeArm'], ['rightHand', 'RightHand'],
  ['leftUpperLeg', 'LeftLeg'], ['leftLowerLeg', 'LeftShin'], ['leftFoot', 'LeftFoot'], ['leftToes', 'LeftToeBase'],
  ['rightUpperLeg', 'RightLeg'], ['rightLowerLeg', 'RightShin'], ['rightFoot', 'RightFoot'], ['rightToes', 'RightToeBase'],
];

export class SomaGenerator {
  name = 'MotionBricks SOMA (ONNX / WebGPU)';
  drivesCharacter = true; // MotionPlayer を使わず、自分で再生して姿勢を当てる

  constructor({ modelUrl = './models/mmm_v6_soma_fp16.onnx', assetsUrl = './models/soma_assets.json' } = {}) {
    this.modelUrl = modelUrl;
    this.assetsUrl = assetsUrl;
    this.stats = { lastMs: 0, tokens: 0, count: 0, error: null };
    this.label = '待機';
  }

  async init(ep = null) {
    const assets = await fetch(this.assetsUrl).then((r) => {
      if (!r.ok) throw new Error(`${this.assetsUrl} がありません（tools/build_soma_assets.py で作る）`);
      return r.json();
    });
    this.sk = new Skeleton(assets.names, assets.parents, assets.reference);
    const toPoses = (t) => ({ ...t, poses: t.poses.map((p) => Float32Array.from(p.flat())) });
    this.targets = Object.fromEntries(Object.entries(assets.targets).map(([k, v]) => [k, v.map(toPoses)]));
    this.jumps = assets.jumps.map((j) => ({ height: j.height, steps: j.steps.map(toPoses) }));
    this.styles = Object.fromEntries(Object.entries(assets.styles ?? {}).map(([k, t]) => [k, toPoses(t)]));
    this.sit = assets.sit && {
      sit: assets.sit.sit.map(toPoses), seated: toPoses(assets.sit.seated), stand: assets.sit.stand.map(toPoses),
    };
    for (const t of [...Object.values(this.targets).flat(), ...Object.values(this.styles)]) t.speed = targetSpeed(t.poses);
    this.restHips = tget(this.sk.reference, 0).p[1];
    this.restInv = this.sk.world(this.sk.reference).map((t) => qinv(t.q));
    this.vrmMap = VRM_MAP.map(([bone, joint]) => [bone, this.sk.index(joint)]);

    // ---- ONNX Runtime ----
    const adapter = ep !== 'wasm' && (await navigator.gpu?.requestAdapter());
    ep ??= adapter && adapter.limits.maxStorageBuffersPerShaderStage >= NEEDED_STORAGE_BUFFERS ? 'webgpu' : 'wasm';
    if (ep === 'wasm') this.name = 'MotionBricks SOMA (ONNX / WASM・CPU)';
    this.ort = await import(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`);
    this.ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    if (ep === 'webgpu') {
      // 既定のストレージバッファ上限（8）では足りない演算があるので、アダプタの上限で作ったデバイスを渡す
      const requiredLimits = {};
      for (const k in adapter.limits) if (typeof adapter.limits[k] === 'number') requiredLimits[k] = adapter.limits[k];
      const requiredFeatures = ['shader-f16', 'timestamp-query', 'subgroups'].filter((f) => adapter.features.has(f));
      this.ort.env.webgpu.device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
    }
    this.session = await this.ort.InferenceSession.create(this.modelUrl, { executionProviders: [ep], graphOptimizationLevel: 'all' });
    console.log('soma inputs', this.session.inputNames, 'outputs', this.session.outputNames);

    // ---- 再生の状態 ----
    const start = placePoses(this.targets.idle[0].poses, [0, 0, 0], 0)[3];
    this.history = Array.from({ length: HISTORY }, () => start); // 古い順、末尾が最新
    this.historyDt = new Array(HISTORY).fill(1 / FPS);
    this.frames = [start];        // 再生中の動き（30fps）
    this.time = 0;                // その再生時刻
    this.early = 0;               // 終わりの何フレーム前で次へ移るか
    this.fade = null;             // { frames, time, t }：前の動きからのつなぎ
    this.busy = false;
    this.queued = null;           // 乗り換え待ちの生成結果 { frames, at, early }
    this.plan = null;             // 今の目標 { kind, dir, ... }
    this.seq = null;              // 目標列の再生中（飛び越え・座る・立つ）{ steps, index, ground, yaw, then }
    this.seated = null;           // 座っている椅子 { ground, yaw }
    this.wantInteract = false;    // E が押された（生成中でも取りこぼさない）
    this.pose = start;
    this.clock = 0;               // 実時間（秒）
  }

  // ---------- 毎フレーム ----------
  update(dt, control, character, probe) {
    this.clock += dt;
    this.time += dt;
    this.scale = character.hipsHeight / this.restHips;
    if (this.queued && this.time >= this.queued.at) this.switchTo(this.queued.frames, this.time - this.queued.at, this.queued.early);

    let pose = samplePose(this.frames, this.time);
    if (this.fade) {
      this.fade.time += dt;
      this.fade.t += dt / BLEND_SECONDS;
      if (this.fade.t >= 1) this.fade = null;
      else pose = blendPose(samplePose(this.fade.frames, this.fade.time), pose, smooth(this.fade.t));
    }
    this.pose = pose;
    if (dt > 0) { // 時間が進んでいないフレームは記録しない（文脈の補間で 0 除算になる）
      this.history.push(pose); this.history.shift();
      this.historyDt.push(dt); this.historyDt.shift();
    }

    if (control.interact) this.wantInteract = true;
    if (!this.busy && !this.queued) this.maybeGenerate(control, probe);
    this.apply(pose, character);
  }

  get transitionAt() {
    return (this.frames.length - 1 - this.early) / FPS;
  }

  get timeToTransition() {
    return Math.max(0, this.transitionAt - this.time);
  }

  maybeGenerate(control, probe) {
    const world = this.sk.world(this.pose);
    const here = { pos: [world[0].p[0], 0, world[0].p[2]], heading: this.sk.heading(world) };
    const latency = Math.max(1 / 60, (this.stats.lastMs / 1000) * 1.2);
    const due = this.timeToTransition <= latency;
    const at = due && this.transitionAt > this.time ? this.transitionAt : null; // 乗り換えの時刻（今の動きの時刻）

    // 目標列の再生中は、段ごとに次の目標へ進むだけ
    if (this.seq) {
      this.wantInteract = false; // 列の途中の E は無視する
      if (!due) return;
      this.seq.index++;
      if (this.seq.index < this.seq.steps.length) return this.request(this.seqTarget(), at);
      const then = this.seq.then;
      this.seq = null;
      if (then === 'seated') this.seated = { ground: this.seqGround, yaw: this.seqYaw };
    }

    // 椅子：座っている間は着座の姿勢を目標にし続け、E か移動で立ち上がる
    const interact = this.wantInteract;
    this.wantInteract = false;
    if (this.seated) {
      if (interact || control.moving) {
        const { ground, yaw } = this.seated;
        this.seated = null;
        return this.startSequence(this.sit.stand, ground, yaw, '立ち上がり', null);
      }
      if (!due) return;
      this.label = '座っている';
      const t = this.sit.seated;
      return this.request({ poses: placePoses(t.poses, this.seated.ground, this.seated.yaw), early: t.early, tokens: t.tokens }, at);
    }
    if (interact && control.chair && this.sit) {
      const ground = [control.chair.pos[0] / this.scale, 0, control.chair.pos[2] / this.scale];
      return this.startSequence(this.sit.sit, ground, control.chair.yaw, '座る', 'seated');
    }

    // 障害物：走って近づいたら、箱を基準にした飛び越えの目標列を置く
    if (control.moving && !control.crouch && probe) {
      const hit = probe(here, control);
      if (hit && this.startJump(hit, here)) return;
    }

    const style = control.moving && !control.crouch && this.styles[control.style] ? control.style : null;
    const kind = style ? `style:${style}` : control.crouch ? (control.moving ? 'crouchWalk' : 'crouchIdle')
      : control.moving ? (control.speed >= 2 ? 'run' : 'walk') : 'idle';
    const turned = control.moving && this.plan?.dir != null
      && Math.abs(wrap(control.yaw - this.plan.dir)) > (TURN_THRESHOLD * Math.PI) / 180;
    const sameKind = this.plan?.kind === kind && !turned;
    if (!due && sameKind) return;

    const list = style ? [this.styles[style]] : this.targets[kind];
    const target = list[(Math.random() * list.length) | 0];
    const yaw = control.moving ? control.yaw : here.heading;
    const lead = control.moving ? target.speed * LEAD_SECONDS : 0;
    const ground = [here.pos[0] + Math.sin(yaw) * lead, 0, here.pos[2] + Math.cos(yaw) * lead];
    this.plan = { kind, dir: control.moving ? control.yaw : null };
    this.label = style ? control.styleName
      : { idle: '待機', walk: '歩き', run: 'ダッシュ', crouchIdle: 'しゃがみ', crouchWalk: 'しゃがみ歩き' }[kind];
    this.request({ poses: placePoses(target.poses, ground, yaw), early: target.early, tokens: target.tokens }, sameKind ? at : null);
  }

  // 飛び越えを始めたら true。体格で換算した箱が高すぎる（サンプルは 0.5m と 0.82m）ときは false
  startJump(hit, here) {
    const h = hit.height / this.scale;
    if (h > MAX_JUMP_HEIGHT) return false;
    const options = this.jumps.filter((j) => (h < 0.65 ? j.height < 0.65 : j.height >= 0.65));
    const jump = options[(Math.random() * options.length) | 0];
    // 箱の中心（キャラクターの進む線上）に、進む向きでそろえて置く
    const d = (hit.dist + hit.depth / 2) / this.scale;
    const ground = [here.pos[0] + Math.sin(hit.yaw) * d, 0, here.pos[2] + Math.cos(hit.yaw) * d];
    // 入口が今より手前なら飛ばして、踏み切りから始める
    const entry = -jump.steps[0].poses[0][2];
    const label = `飛び越え（箱 ${hit.height.toFixed(2)}m → ${jump.height < 0.65 ? 'jump_0_5m' : 'jump_0_75m'}）`;
    this.startSequence(jump.steps, ground, hit.yaw, label, null, d > entry + 0.3 ? 0 : 1);
    return true;
  }

  // ground / yaw（SOMA の空間）を原点・正面として目標列を置き、1 段目から生成する
  startSequence(steps, ground, yaw, label, then, index = 0) {
    this.seq = { steps, index, ground, yaw, then };
    this.seqGround = ground;
    this.seqYaw = yaw;
    this.plan = null;
    this.label = label;
    this.request(this.seqTarget());
  }

  seqTarget() {
    const s = this.seq.steps[this.seq.index];
    return { poses: placePoses(s.poses, this.seq.ground, this.seq.yaw), early: s.early, tokens: s.tokens };
  }

  // ---------- 生成 ----------
  // at を渡すと、今の動きの時刻 at での 4 姿勢を文脈にし、結果を at から再生する
  async request(target, at = null) {
    this.busy = true;
    const requestedAt = this.clock;
    const context = at != null ? [3, 2, 1, 0].map((k) => samplePose(this.frames, at - k / FPS)) : this.sampleContext();
    const t0 = performance.now();
    try {
      const { align, inputs } = encode(this.sk, context, target.poses, { tokens: target.tokens });
      const feeds = {};
      for (const [name, [data, dims, type]] of Object.entries(inputs)) feeds[name] = new this.ort.Tensor(type, data, dims);
      const out = await this.session.run(feeds);
      const tokens = Number(out.pred_num_tokens.data[0]);
      const frames = decode(this.sk, align, out.pred_global_motions.data, tokens);
      correctEndpoints(this.sk, frames, context[3], target.poses[0]);

      if (at != null && this.time < at) this.queued = { frames, at, early: target.early };
      else if (at != null) this.switchTo(frames, this.time - at, target.early);
      else this.switchTo(frames, this.clock - requestedAt, target.early); // 生成にかかった時間だけ先から
      this.stats = { lastMs: performance.now() - t0, tokens, count: this.stats.count + 1, error: null };
    } catch (e) {
      console.error(e);
      this.stats.error = e.message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  // 新しい動きの time 秒目から再生し、今の姿勢から 0.2 秒でつなぐ
  switchTo(frames, time, early) {
    this.fade = { frames: this.frames, time: this.time, t: 0 };
    this.frames = frames;
    this.time = time;
    this.early = early;
    this.queued = null;
  }

  // 履歴から、最新の姿勢で終わる 30fps 間隔の 4 姿勢を取り出す
  sampleContext() {
    const out = [];
    for (let k = 3; k >= 0; k--) {
      let want = k / FPS, i = HISTORY - 1;
      while (i > 0 && want > this.historyDt[i]) { want -= this.historyDt[i]; i--; }
      const w = i > 0 ? Math.min(want / this.historyDt[i], 1) : 0;
      out.push(i > 0 ? blendPose(this.history[i], this.history[i - 1], w) : this.history[0]);
    }
    return out;
  }

  // ---------- 表示（SOMA → VRM 正規化ボーン） ----------
  apply(pose, character) {
    const world = this.sk.world(pose);
    const s = this.scale;
    const yaw = this.sk.heading(world);
    const yawInv = qAxisY(-yaw);
    // 正規化ボーンのワールド回転 = SOMA の関節のワールド回転 ×（T ポーズでのワールド回転）⁻¹
    const rots = {};
    for (const [bone, j] of this.vrmMap) rots[bone] = qmul(yawInv, qmul(world[j].q, this.restInv[j]));

    character.root.position.x = world[0].p[0] * s;
    character.root.position.z = world[0].p[2] * s;
    character.yaw = yaw;
    character.applyWorldPose(world[0].p[1] * s - character.hipsHeight, rots);
  }
}

function targetSpeed(poses) {
  const a = tget(poses[0], 0).p, b = tget(poses[poses.length - 1], 0).p;
  return (Math.hypot(b[0] - a[0], b[2] - a[2]) * FPS) / (poses.length - 1);
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t) => t * t * (3 - 2 * t);
