// キーボード入力 → カメラ基準の移動方向と状態フラグ。
const MOVE_KEYS = {
  ArrowUp: [0, 1], KeyW: [0, 1],
  ArrowDown: [0, -1], KeyS: [0, -1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.crouch = false;
    this.onToggleHud = null;
    addEventListener('keydown', (e) => {
      if (e.code in MOVE_KEYS) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'KeyC') this.crouch = !this.crouch;
      if (e.code === 'KeyH') this.onToggleHud?.();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  get walk() {
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
