// MotionBricks の代わりに使うダミー生成器（手続き的な歩行・走行・しゃがみ・飛び越え）。
// MotionPlayer / キャラクター / 入力まわりを先に完成させるための差し替え用。
// ONNX 版（onnxGenerator.js）と同じ generate(control) インターフェースを持つ。
//
// control:
//   { turn: 目標方向との角度差[rad], speed: 0=停止 1=歩き 2=ダッシュ, crouch: bool,
//     vault: { dist, height, depth } | null }
import * as THREE from 'three';

const FPS = 30;
const CHUNK = 12;          // 1 回の生成で作るフレーム数（0.4 秒）
const TURN_RATE = 6;       // rad/s

export class ProceduralGenerator {
  name = '手続き的ダミー';
  supportsVault = true;

  constructor() {
    // 自己回帰の「文脈」に相当する状態。最後に生成したフレームの続きから作る。
    this.ctx = { phase: 0, speed: 0, crouch: 0, stride: 1 };
  }

  async generate(control) {
    const frames = control.vault && this.ctx.crouch < 0.5
      ? this.vault(control.vault)
      : this.locomotion(control);
    return { frames, tokens: 0 };
  }

  locomotion({ turn, speed, crouch }) {
    const c = this.ctx;
    const dt = 1 / FPS;
    // 同じループにならないよう、区間ごとに歩幅とテンポを少し揺らす
    c.stride = THREE.MathUtils.lerp(c.stride, 0.9 + Math.random() * 0.2, 0.5);
    const targetSpeed = crouch ? Math.min(speed, 1) * 0.6 : speed;
    let remaining = turn;
    const frames = [];

    for (let i = 0; i < CHUNK; i++) {
      c.speed += (targetSpeed - c.speed) * Math.min(1, dt * 5);
      c.crouch += ((crouch ? 1 : 0) - c.crouch) * Math.min(1, dt * 6);
      const s = c.speed;
      const cadence = (0.9 + 0.55 * s) * c.stride;
      c.phase = (c.phase + 2 * Math.PI * cadence * dt * (s > 0.02 ? 1 : 0)) % (Math.PI * 2);

      const dYaw = THREE.MathUtils.clamp(remaining, -TURN_RATE * dt, TURN_RATE * dt) * Math.min(1, 0.3 + s);
      remaining -= dYaw;
      const v = s <= 1 ? 1.4 * s : 1.4 + 2.4 * (s - 1);
      frames.push({
        dForward: v * dt,
        dYaw,
        height: -0.32 * c.crouch - 0.04 * Math.min(s, 2) * Math.abs(Math.cos(c.phase)),
        bones: gaitPose(c.phase, s, c.crouch, dYaw / dt),
      });
    }
    return frames;
  }

  vault({ dist, height, depth }) {
    const c = this.ctx;
    const dt = 1 / FPS;
    const frames = [];
    // 踏み切りまでの助走 → 跳躍 → 着地
    const approach = Math.max(0, dist - 0.5);
    const runV = Math.max(1.4, 1.4 + 2.4 * (c.speed - 1));
    const nApproach = Math.round((approach / runV) * FPS);
    for (let i = 0; i < nApproach; i++) {
      c.phase = (c.phase + 2 * Math.PI * (0.9 + 0.55 * c.speed) * dt) % (Math.PI * 2);
      frames.push({ dForward: runV * dt, dYaw: 0, height: 0, tag: 'vault', bones: gaitPose(c.phase, c.speed, 0, 0) });
    }
    const air = 0.5 + depth + 0.7;              // 障害物を越えて着地するまでの水平距離
    const T = 0.45 + 0.35 * height + 0.1 * depth;
    const n = Math.round(T * FPS);
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      const arc = Math.sin(Math.PI * t);
      frames.push({
        dForward: (air / n),
        dYaw: 0,
        height: Math.max(0.25, height - 0.05) * arc, // 足を畳むぶん本体はそこまで上げなくてよい
        tag: 'vault',
        bones: vaultPose(arc),
      });
    }
    // 着地の沈み込み
    for (let i = 0; i < 6; i++) {
      const k = Math.sin(Math.PI * (i + 1) / 7);
      c.phase = (c.phase + 2 * Math.PI * (0.9 + 0.55 * c.speed) * dt) % (Math.PI * 2);
      frames.push({ dForward: runV * 0.7 * dt, dYaw: 0, height: -0.15 * k, tag: 'land', bones: gaitPose(c.phase, c.speed, 0.4 * k, 0) });
    }
    return frames;
  }
}

// ---- 姿勢（VRM 正規化ボーン、+Z 正面のローカル回転） ----
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
function q(x, y, z, order = 'XYZ') {
  return _q.setFromEuler(_e.set(x, y, z, order)).toArray();
}

function gaitPose(phase, s, crouch, yawRate) {
  const amp = 0.38 * Math.min(s, 1) + 0.22 * Math.max(0, s - 1);
  const sl = Math.sin(phase), sr = Math.sin(phase + Math.PI);
  const kneeL = amp * 1.6 * Math.max(0, -Math.cos(phase)) + amp * 0.3;
  const kneeR = amp * 1.6 * Math.max(0, Math.cos(phase)) + amp * 0.3;
  const lean = 0.06 * s + 0.35 * crouch;
  const bank = THREE.MathUtils.clamp(-yawRate * 0.04 * s, -0.25, 0.25);
  const armDown = 1.25 - 0.1 * s;
  const elbow = 0.25 + 0.45 * Math.min(s, 2) / 2;

  return {
    hips: q(0, 0.12 * amp * sl, bank),
    spine: q(lean * 0.6, -0.1 * amp * sl, 0),
    chest: q(lean * 0.4, -0.15 * amp * sl, 0),
    neck: q(-lean * 0.5, 0, 0),
    head: q(-lean * 0.3, 0, -bank * 0.5),
    leftUpperLeg: q(-amp * sl - 1.0 * crouch, 0, 0),
    leftLowerLeg: q(kneeL + 1.8 * crouch, 0, 0),
    leftFoot: q(-0.2 * kneeL - 0.8 * crouch + 0.2 * amp * sl, 0, 0),
    rightUpperLeg: q(-amp * sr - 1.0 * crouch, 0, 0),
    rightLowerLeg: q(kneeR + 1.8 * crouch, 0, 0),
    rightFoot: q(-0.2 * kneeR - 0.8 * crouch + 0.2 * amp * sr, 0, 0),
    // 腕：まず Z 回転で下ろし、X 回転で前後に振る（足と逆位相）
    leftUpperArm: q(amp * 0.9 * sl, 0, -armDown, 'XYZ'),
    leftLowerArm: q(0, -elbow, 0),
    rightUpperArm: q(amp * 0.9 * sr, 0, armDown, 'XYZ'),
    rightLowerArm: q(0, elbow, 0),
  };
}

function vaultPose(a) {
  return {
    hips: q(0, 0, 0),
    spine: q(0.25 * a, 0, 0),
    chest: q(0.2 * a, 0, 0),
    neck: q(-0.2 * a, 0, 0),
    head: q(-0.2 * a, 0, 0),
    leftUpperLeg: q(-1.3 * a, 0, 0.15 * a),
    leftLowerLeg: q(2.0 * a, 0, 0),
    leftFoot: q(-0.3 * a, 0, 0),
    rightUpperLeg: q(-1.0 * a - 0.2, 0, -0.15 * a),
    rightLowerLeg: q(1.6 * a + 0.2, 0, 0),
    rightFoot: q(-0.2 * a, 0, 0),
    leftUpperArm: q(-1.2 * a, 0, -1.25 + 0.6 * a),
    leftLowerArm: q(0, -0.4, 0),
    rightUpperArm: q(-1.2 * a, 0, 1.25 - 0.6 * a),
    rightLowerArm: q(0, 0.4, 0),
  };
}
