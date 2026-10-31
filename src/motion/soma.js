// MotionBricks SOMA モデルの入出力（エンコード・デコード・端点補正）。
// NVlabs/motionbricks（Apache 2.0）の motionbricks/model/soma/kernels.py と
// motionbricks/model/generation.py を JavaScript に移したもの。
//
// 座標系は SOMA のモデル空間（Y 上、メートル、+Z が正面）で、three.js / VRM と同じ。
// 姿勢は関節ごとのローカル変換を並べた Float32Array（J * 7：x, y, z, qx, qy, qz, qw）。根（Hips）が先頭。

export const FPS = 30;
export const POSES_PER_TOKEN = 4;
const BOUNDARY = POSES_PER_TOKEN - 1;
const MIN_TOKENS = 6, MAX_TOKENS = 16;
const FEATURES = 366; // 根 5、位置 87、6D 回転 180、速度 90、足の接地 4

// soma_n1.json の joint_names（モデルの関節順）
export const MODEL_JOINTS = [
  'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head', 'Jaw', 'LeftEye', 'RightEye',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandThumbEnd', 'LeftHandMiddleEnd',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandThumbEnd', 'RightHandMiddleEnd',
  'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase', 'RightLeg', 'RightShin', 'RightFoot', 'RightToeBase',
];
const MJ = MODEL_JOINTS.length;

// ---------- 四元数（xyzw の配列）と変換 {p, q} ----------
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qnorm = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
export const qAxisY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qnorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}
// 列ベクトル x, y, z を列に持つ回転行列 → 四元数
function qFromCols(x, y, z) {
  const tr = x[0] + y[1] + z[2];
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s]; }
  else if (x[0] > y[1] && x[0] > z[2]) { const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]); q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (y[1] > z[2]) { const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]); q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]); q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
  return qnorm(q);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export const tmul = (a, b) => ({ p: qrot(a.q, b.p).map((v, i) => v + a.p[i]), q: qmul(a.q, b.q) });
export const tinv = (a) => { const q = qinv(a.q); return { p: qrot(q, a.p).map((v) => -v), q }; };
export const tget = (pose, j) => ({ p: [pose[j * 7], pose[j * 7 + 1], pose[j * 7 + 2]], q: [pose[j * 7 + 3], pose[j * 7 + 4], pose[j * 7 + 5], pose[j * 7 + 6]] });
export function tset(pose, j, t) { pose.set(t.p, j * 7); pose.set(t.q, j * 7 + 3); }
const IDENTITY = { p: [0, 0, 0], q: [0, 0, 0, 1] };
const blendT = (a, b, w) => ({ p: a.p.map((v, i) => v + (b.p[i] - v) * w), q: qslerp(a.q, b.q, w) });

// ---------- 骨格 ----------
export class Skeleton {
  constructor(names, parents, reference) {
    this.names = names;
    this.parents = parents;
    this.J = names.length;
    this.reference = Float32Array.from(reference.flat());
    this.index = (n) => names.indexOf(n);
    this.modelToPose = MODEL_JOINTS.map((n) => this.index(n));
    if (this.modelToPose.includes(-1)) throw new Error('骨格にモデルの関節が足りません');
    // 親がモデルの関節につながっていない関節（指先など）は、デコード時にレスト姿勢のまま
    this.poseToModel = new Int32Array(this.J).fill(-1);
    this.modelToPose.forEach((pj, mj) => {
      const p = parents[pj];
      if (p === -1 || this.poseToModel[p] >= 0) this.poseToModel[pj] = mj;
    });
    this.rightLeg = this.index('RightLeg');
    this.leftLeg = this.index('LeftLeg');
  }

  // 各関節のワールド変換
  world(pose) {
    const out = new Array(this.J);
    for (let j = 0; j < this.J; j++) {
      const l = tget(pose, j), p = this.parents[j];
      out[j] = p < 0 ? l : tmul(out[p], l);
    }
    return out;
  }

  // 学習時と同じ「腰の左右の位置」から求めた向き（+Z が 0）
  heading(world) {
    return headingFromHips(world[this.rightLeg].p, world[this.leftLeg].p);
  }
}

export function headingFromHips(right, left) {
  let a = [right[0] - left[0], 0, right[2] - left[2]];
  const l = Math.hypot(a[0], a[2]);
  if (l <= 1e-6) return 0;
  a = [a[0] / l, 0, a[2] / l];
  const f = cross([0, 1, 0], a);
  return Math.atan2(f[0], f[2]);
}

// ---------- エンコード（compute_guide_alignment_kernel + encode_motionbricks_inputs_kernel） ----------
// context: 4 姿勢、target: 1〜4 姿勢。返り値の align はデコードで使う。
export function encode(sk, context, target, { tokens = [8, 14] } = {}) {
  const nT = target.length;
  const guide = [...context, ...Array.from({ length: 4 }, (_, i) => target[Math.min(i, nT - 1)])].map((p) => sk.world(p));
  const last = guide[3];
  const hips = last[0].p;
  const desired = Math.atan2(1, 0); // heading_alignment (1, 0)：最後の文脈を +X に向ける
  const align = { p: [hips[0], 0, hips[2]], q: qAxisY(sk.heading(last) - desired) };
  const alignQinv = qinv(align.q);
  const aligned = (p) => qrot(alignQinv, sub(p, align.p));

  const grv = new Float32Array(8 * 5), lrv = new Float32Array(8 * 4), lp = new Float32Array(8 * 267);
  for (let f = 0; f < 8; f++) {
    const next = f === 3 ? f : Math.min(f + 1, 7);
    const w = guide[f], wn = guide[next];
    const h = aligned(w[0].p), hn = aligned(wn[0].p);
    const head = headingFromHips(aligned(w[sk.rightLeg].p), aligned(w[sk.leftLeg].p));
    const headN = headingFromHips(aligned(wn[sk.rightLeg].p), aligned(wn[sk.leftLeg].p));
    const dh = Math.atan2(Math.sin(headN - head), Math.cos(headN - head));
    grv.set([h[0], h[1], h[2], Math.cos(head), Math.sin(head)], f * 5);
    lrv.set([dh * FPS, (hn[0] - h[0]) * FPS, (hn[2] - h[2]) * FPS, h[1]], f * 4);
    for (let mj = 0; mj < MJ; mj++) {
      const t = w[sk.modelToPose[mj]];
      if (mj > 0) {
        const c = aligned(t.p);
        lp.set([c[0] - h[0], c[1], c[2] - h[2]], f * 267 + (mj - 1) * 3);
      }
      const q = qmul(alignQinv, t.q);
      lp.set([...qrot(q, [1, 0, 0]), ...qrot(q, [0, 1, 0])], f * 267 + (MJ - 1) * 3 + mj * 6);
    }
  }

  // write_motionbricks_conditions_kernel
  const hasG = new Int32Array(8), hasL = new Int32Array(8), hasP = new Int32Array(8);
  for (let i = 0; i < 8; i++) {
    const v = i < 4 + nT ? 1 : 0;
    hasG[i] = v; hasP[i] = v;
    hasL[i] = i === 3 || i === 4 + nT - 1 ? 0 : v;
  }
  const allowed = new Int32Array(MAX_TOKENS - MIN_TOKENS + 1);
  for (let n = tokens[0]; n <= tokens[1]; n++) allowed[n - MIN_TOKENS] = 1;

  return {
    align,
    inputs: {
      global_root_values: [grv, [1, 8, 5], 'float32'],
      local_root_values: [lrv, [1, 8, 4], 'float32'],
      local_poses: [lp, [1, 8, 267], 'float32'],
      has_global_root_values: [hasG, [1, 8], 'int32'],
      has_local_root_values: [hasL, [1, 8], 'int32'],
      has_local_poses: [hasP, [1, 8], 'int32'],
      allowed_pred_num_tokens: [allowed, [1, 11], 'int32'],
    },
  };
}

// ---------- デコード（decode_motionbricks_output_kernel） ----------
function readRotation(m, base) {
  const x = normalize([m[base], m[base + 1], m[base + 2]]);
  const z = normalize(cross(x, [m[base + 3], m[base + 4], m[base + 5]]));
  return qFromCols(x, cross(z, x), z);
}

export function decode(sk, align, motions, numTokens) {
  const count = Math.max(0, Math.min(numTokens * POSES_PER_TOKEN, 64) - 2 * BOUNDARY);
  const rotOffset = 5 + (MJ - 1) * 3;
  const frames = [];
  for (let f = 0; f < count; f++) {
    const base = (BOUNDARY + f) * FEATURES;
    const pose = new Float32Array(sk.J * 7);
    const rots = MODEL_JOINTS.map((_, mj) => readRotation(motions, base + rotOffset + mj * 6));
    tset(pose, 0, tmul(align, { p: [motions[base], motions[base + 1], motions[base + 2]], q: rots[0] }));
    for (let j = 1; j < sk.J; j++) {
      const mj = sk.poseToModel[j];
      const ref = tget(sk.reference, j);
      if (mj < 0) { tset(pose, j, ref); continue; }
      const parent = rots[sk.poseToModel[sk.parents[j]]];
      tset(pose, j, { p: ref.p, q: qnorm(qmul(qinv(parent), rots[mj])) });
    }
    frames.push(pose);
  }
  return frames;
}

// ---------- 端点補正（compute_endpoint_deltas_kernel + apply_endpoint_deltas_kernel） ----------
// 生成の最初を文脈の最後の姿勢に、最後を目標の最初の姿勢に合わせる。
export function correctEndpoints(sk, frames, lastContext, firstTarget) {
  const n = frames.length;
  if (n < 2) return;
  const start = [], end = [];
  for (let j = 0; j < sk.J; j++) {
    const a = tget(frames[0], j), b = tget(frames[n - 1], j);
    const c = tget(lastContext, j), t = tget(firstTarget, j);
    if (j === 0) {
      // 根はワールド空間の位置のずれと、生成した回転の後ろにかける回転
      start.push({ p: sub(c.p, a.p), q: qnorm(qmul(qinv(qnorm(a.q)), qnorm(c.q))) });
      end.push({ p: sub(t.p, b.p), q: qnorm(qmul(qinv(qnorm(b.q)), qnorm(t.q))) });
    } else {
      start.push(tmul(tinv(a), c));
      end.push(tmul(tinv(b), t));
    }
  }
  for (let f = 0; f < n; f++) {
    const we = f / (n - 1), ws = 1 - we;
    for (let j = 0; j < sk.J; j++) {
      const t = tget(frames[f], j);
      if (j === 0) {
        const q = qnorm(qmul(qmul(t.q, qslerp(IDENTITY.q, start[0].q, ws)), qslerp(IDENTITY.q, end[0].q, we)));
        const p = t.p.map((v, i) => v + start[0].p[i] * ws + end[0].p[i] * we);
        tset(frames[f], 0, { p, q });
      } else {
        const s = tmul(t, blendT(IDENTITY, start[j], ws));
        tset(frames[f], j, tmul(s, blendT(IDENTITY, end[j], we)));
      }
    }
  }
}

// ---------- 姿勢の補間 ----------
export function blendPose(a, b, w, out = new Float32Array(a.length)) {
  for (let j = 0; j < a.length / 7; j++) {
    const o = j * 7;
    for (let i = 0; i < 3; i++) out[o + i] = a[o + i] + (b[o + i] - a[o + i]) * w;
    out.set(qslerp([a[o + 3], a[o + 4], a[o + 5], a[o + 6]], [b[o + 3], b[o + 4], b[o + 5], b[o + 6]], w), o + 3);
  }
  return out;
}

// 30fps のフレーム列を時刻 t で取り出す（範囲外は端のフレーム）
export function samplePose(frames, t) {
  const f = Math.min(Math.max(t * FPS, 0), frames.length - 1);
  const a = Math.floor(f), b = Math.min(a + 1, frames.length - 1);
  return blendPose(frames[a], frames[b], f - a);
}

// 根だけを動かす：根 = (地面の位置 ground, Y 軸まわり yaw) * 根
export function placePoses(poses, ground, yaw) {
  const place = { p: ground, q: qAxisY(yaw) };
  return poses.map((pose) => {
    const out = Float32Array.from(pose);
    tset(out, 0, tmul(place, tget(pose, 0)));
    return out;
  });
}
