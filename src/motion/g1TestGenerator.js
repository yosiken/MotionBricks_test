// G1 の qpos を数式で作って g1.js のリターゲットを確かめるためのテスト用生成器（?gen=g1test）。
// MotionBricks のモデル無しで「G1 qpos → VRM」の変換が正しく見えるかを確認できる。
// 関節の符号は G1 の慣例：股関節ピッチ負 = 脚が前、膝正 = 曲げ、肩ピッチ負 = 腕が前。
import { qposToFrame, standingQpos, G1_PELVIS_HEIGHT } from './g1.js';

const FPS = 30;
const CHUNK = 12;
const J = 7; // qpos の関節角の開始位置

export class G1TestGenerator {
  name = 'G1 qpos テスト';

  constructor() {
    this.q = standingQpos();
    this.phase = 0;
    this.yaw = 0;
    this.speed = 0;
  }

  async generate({ moving, yaw, speed, crouch }) {
    const dt = 1 / FPS;
    const frames = [];
    for (let i = 0; i < CHUNK; i++) {
      const target = moving ? (speed >= 2 ? 2.5 : 1.2) : 0;
      this.speed += (target - this.speed) * 0.15;
      if (moving) this.yaw += Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw)) * 0.2;
      this.phase += dt * 2 * Math.PI * (0.8 + 0.5 * this.speed) * (this.speed > 0.05 ? 1 : 0);

      const q = standingQpos(
        this.q[0] + Math.cos(this.yaw) * this.speed * dt,
        this.q[1] + Math.sin(this.yaw) * this.speed * dt,
        this.yaw,
      );
      const a = 0.25 * Math.min(this.speed, 2);
      const s = Math.sin(this.phase);
      const c = crouch ? 1 : 0;
      q[2] = G1_PELVIS_HEIGHT - 0.25 * c - 0.02 * a * Math.abs(Math.cos(this.phase));
      // 左脚 0..5、右脚 6..11
      q[J + 0] = -a * s - 0.9 * c;           q[J + 6] = a * s - 0.9 * c;
      q[J + 3] = a * (1 + Math.cos(this.phase)) + 1.6 * c;
      q[J + 9] = a * (1 - Math.cos(this.phase)) + 1.6 * c;
      q[J + 4] = -0.7 * c;                   q[J + 10] = -0.7 * c;
      // 腰 12..14（ピッチで前傾）
      q[J + 14] = 0.1 * a + 0.3 * c;
      // 腕 15..21 / 22..28（肩ピッチ・肘）。G1 の肘は 0 で 90° 曲がっているので、伸ばす方向に少し戻す
      q[J + 15] = a * s;                     q[J + 22] = -a * s;
      q[J + 18] = 0.3;                       q[J + 25] = 0.3;
      this.q = q;
      frames.push(qposToFrame(q));
    }
    return { frames, tokens: 0 };
  }
}
