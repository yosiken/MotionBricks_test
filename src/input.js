// キーボード入力 → カメラ基準の移動方向と状態フラグ。
const MOVE_KEYS = {
  ArrowUp: [0, 1], KeyW: [0, 1],
  ArrowDown: [0, -1], KeyS: [0, -1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

// 歩き方（公式の locomotion_style_variations）。[soma_assets.json の名前, 表示名]
export const STYLES = [
  [null, '通常'], ['Skipping', 'スキップ'], ['Vogue', 'ヴォーグ'], ['Injured Torso', '脇腹を押さえる'],
  ['Injured Leg', '足を引きずる'], ['Zombie', 'ゾンビ'], ['Combat', '戦闘ステップ'],
];

export class Input {
  constructor() {
    this.down = new Set();
    this.crouch = false;
    this.style = 0;          // 歩き方（STYLES の番号、0 は通常）
    this.interact = false;   // E が押された（読んだら戻す）
    this.onToggleHud = null;
    addEventListener('keydown', (e) => {
      if (e.code in MOVE_KEYS) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'KeyC') this.crouch = !this.crouch;
      if (e.code === 'KeyH') this.onToggleHud?.();
      if (e.code === 'KeyV') this.style = (this.style + 1) % STYLES.length;
      if (e.code === 'KeyE') this.interact = true;
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  takeInteract() {
    const v = this.interact;
    this.interact = false;
    return v;
  }

  get run() {
    return this.down.has('ShiftLeft') || this.down.has('ShiftRight');
  }

  // カメラの水平向き camYaw を基準にしたワールド方向。入力なしなら null。
  // 戻り値の yaw は「+Z を 0 とした向き」（キャラクターの yaw と同じ定義）。
  moveYaw(camYaw) {
    let x = 0, y = 0;
    for (const code of this.down) {
      const m = MOVE_KEYS[code];
      if (m) { x += m[0]; y += m[1]; }
    }
    if (x === 0 && y === 0) return null;
    // カメラの前方は camYaw 方向、右は camYaw - 90°
    return camYaw + Math.atan2(-x, y);
  }
}
