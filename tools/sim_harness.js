// ブラウザのコンソールで読み込む計測用の道具（ペインが隠れていても動くよう、描画ループを止めて 1/30 秒刻みで進める）。
//   （?scene=boxes で開いてから）const h = await import('/tools/sim_harness.js'); await h.setup();
//   await h.jump(0)   // 0 番の箱へ走って飛び越え、箱の範囲内での最小すき間を返す
//   await h.sit()     // 一番近い椅子に座って立つ
// 推論中も、前回の推論時間ぶんだけフレームを進める（実時間で動かしたときと同じ遅れ）。
let g, ch, boxes, chairs, probe, pending = null;

export async function setup() {
  window.requestAnimationFrame = () => 0;
  ({ generator: g, character: ch } = window.demo);
  const scene = ch.root.parent;
  boxes = scene.children.filter((o) => o.userData.height);
  chairs = scene.children.filter((o) => o.userData.yaw !== undefined);
  const { probeObstacle } = await import('/src/world.js');
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  probe = (here, c) => {
    if (Math.abs(wrap(c.yaw - ch.yaw)) > 0.5) return null;
    const hit = probeObstacle(boxes, ch.root.position, c.yaw);
    if (!hit || hit.dist < 0.9 || hit.dist > 2.6 || hit.height > 1.2) return null;
    return { ...hit, yaw: c.yaw };
  };
  const request = g.request.bind(g);
  g.request = (...a) => (pending = request(...a));
  const start = g.startSequence.bind(g);
  g.startSequence = (steps, ...a) => { window.__variant = g.jumps.findIndex((j) => j.steps === steps); return start(steps, ...a); };
  return { boxes: boxes.length, chairs: chairs.length };
}

export const B = (n) => ch.bones[n].getWorldPosition(new ch.root.position.constructor());

export async function sim(seconds, control = {}, each) {
  let wait = 0;
  for (let t = 0; t < seconds; t += 1 / 30) {
    g.update(1 / 30, { moving: false, yaw: 0, speed: 0, crouch: false, style: null, interact: false, chair: null, ...control }, ch, probe);
    control.interact = false;
    if (pending && wait === 0) wait = Math.max(1, Math.ceil(((g.stats.lastMs || 330) / 1000) * 30));
    if (pending && --wait <= 0) { await pending; pending = null; wait = 0; }
    ch.update(1 / 30); // VRM の正規化ボーン → 実ボーン
    ch.root.updateMatrixWorld(true);
    if (!Number.isFinite(ch.root.position.x)) throw new Error(`NaN（${g.label}）`);
    each?.(t);
  }
}

// 位置 (x, z)・向き yaw へ瞬間移動して待機させる
export async function place(x, z, yaw) {
  if (pending) { await pending; pending = null; }
  g.scale = ch.hipsHeight / g.restHips; // 描画ループが一度も回っていないと未設定
  g.teleport(x, z, yaw);
  await sim(0.6);
}

export async function jump(i) {
  const b = boxes[i], r = b.rotation.y, P = b.geometry.parameters, inv = new ch.root.position.constructor();
  await place(b.position.x - Math.sin(r) * 3.5, b.position.z - Math.cos(r) * 3.5, r);
  let clear = 9, who = '', label = '';
  await sim(4, { moving: true, yaw: r, speed: 2 }, () => {
    if (g.label.startsWith('飛')) label = g.label;
    for (const f of ['leftFoot', 'rightFoot', 'hips', 'leftLowerLeg', 'rightLowerLeg', 'leftToes', 'rightToes']) {
      if (!ch.bones[f]) continue;
      const p = B(f);
      inv.copy(p); b.worldToLocal(inv);
      if (Math.abs(inv.x) < P.width / 2 && Math.abs(inv.z) < P.depth / 2 && p.y - b.userData.height < clear) { clear = p.y - b.userData.height; who = f; }
    }
  });
  const end = ch.root.position.clone(); b.worldToLocal(end);
  return `箱${i}（高さ ${b.userData.height}m・奥行き ${P.depth}m）${label || '飛び越えなし'} jump#${window.__variant} 最小すき間 ${clear.toFixed(3)}m（${who}） 通過=${end.z > 0}`;
}

export async function sit(i = 0) {
  const c = chairs[i], y = c.userData.yaw, log = [];
  await place(c.position.x + Math.sin(y) * 1.5, c.position.z + Math.cos(y) * 1.5, y + Math.PI);
  const snap = (tag) => {
    const o = ch.root.position.clone().sub(c.position);
    log.push(`${tag} ${g.label} 腰 ${B('hips').y.toFixed(2)}m 椅子から (${o.x.toFixed(2)}, ${o.z.toFixed(2)}) 向き ${ch.yaw.toFixed(2)}（椅子 ${y.toFixed(2)}）`);
  };
  const chair = { pos: [c.position.x, 0, c.position.z], yaw: y };
  await sim(0.1, { interact: true, chair });
  for (let k = 0; k < 4; k++) { await sim(1, { chair }); snap(`${k + 1}s`); }
  await sim(0.1, { interact: true, chair });
  for (let k = 0; k < 3; k++) { await sim(1, { chair }); snap(`立つ ${k + 1}s`); }
  return log;
}
