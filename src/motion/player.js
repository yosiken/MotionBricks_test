// 生成されたフレーム列を再生しつつ、残りが少なくなったら次の区間を先読み生成する。
//
// ジェネレータのインターフェース:
//   generator.name: string
//   generator.generate(control) -> Promise<{ frames: Frame[], tokens?: number }>
// Frame:
//   { dForward, dYaw, height, tag?, bones: { [vrmBoneName]: [x, y, z, w] } }
//   dForward / dYaw は 1 フレームあたりのルート移動量（キャラクターのローカル座標、+Z が前）。
//   ジェネレータは自分が最後に生成したフレームを文脈として次の区間を作る（自己回帰）。
import * as THREE from 'three';

export class MotionPlayer {
  constructor(generator, { fps = 30, lookahead = 8 } = {}) {
    this.generator = generator;
    this.fps = fps;
    this.lookahead = lookahead;  // 残りフレームがこれを下回ったら生成を投げる
    this.queue = [];
    this.prev = null;
    this.cur = null;
    this.acc = 0;
    this.busy = false;
    this.stats = { lastMs: 0, tokens: 0, count: 0, error: null };
    this.pose = { height: 0, bones: {} };
  }

  // 先読み中のフレームが進む距離（障害物までの距離補正に使う）
  get queuedForward() {
    let d = this.queue.reduce((s, f) => s + f.dForward, 0);
    if (this.cur) d += this.cur.dForward * (1 - this.acc * this.fps);
    return d;
  }

  hasQueuedTag(tag) {
    return this.cur?.tag === tag || this.queue.some((f) => f.tag === tag);
  }

  get currentTag() {
    return this.cur?.tag ?? null;
  }

  // getControl は生成を投げる瞬間に呼ばれる（その時点の入力が使われる）
  update(dt, getControl, character) {
    if (!this.busy && this.queue.length < this.lookahead) this.request(getControl());

    const frameDt = 1 / this.fps;
    this.acc += dt;
    while (this.acc >= frameDt || !this.cur) {
      const next = this.queue.shift();
      if (!next) { this.acc = Math.min(this.acc, frameDt); break; }
      this.prev = this.cur ?? next;
      this.cur = next;
      if (this.acc >= frameDt) this.acc -= frameDt;
    }
    if (!this.cur) return;

    // ルート移動（表示フレームレートに合わせて按分）
    const k = Math.min(dt * this.fps, 3);
    character.yaw += this.cur.dYaw * k;
    const step = this.cur.dForward * k;
    character.root.position.x += Math.sin(character.yaw) * step;
    character.root.position.z += Math.cos(character.yaw) * step;

    // 前フレームとの補間で姿勢を作る
    const t = Math.min(this.acc * this.fps, 1);
    this.pose.height = THREE.MathUtils.lerp(this.prev.height, this.cur.height, t);
    for (const [name, q] of Object.entries(this.cur.bones)) {
      const out = (this.pose.bones[name] ??= new THREE.Quaternion());
      const a = this.prev.bones[name] ?? q;
      out.fromArray(a).slerp(_q.fromArray(q), t);
    }
    character.applyPose(this.pose);
  }

  async request(control) {
    this.busy = true;
    const t0 = performance.now();
    try {
      const { frames, tokens } = await this.generator.generate(control);
      this.queue.push(...frames);
      this.stats.lastMs = performance.now() - t0;
      this.stats.tokens = tokens ?? 0;
      this.stats.count++;
      this.stats.error = null;
    } catch (e) {
      console.error(e);
      this.stats.error = e.message ?? String(e);
    } finally {
      this.busy = false;
    }
  }
}

const _q = new THREE.Quaternion();
