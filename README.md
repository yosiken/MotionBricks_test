# MotionBricks ライブデモ（雛形）

ブラウザでキー操作に合わせてモーションを生成し、VRM キャラクターを動かすデモの雛形です。

- 最初は **手続き的なダミー生成器** で動きます（モデル不要）。
- MotionBricks を ONNX に書き出したら `?gen=onnx` で WebGPU 推論に切り替えます。

## 起動

```bash
cd motionbricks-demo
python3 -m http.server 8000
```

http://localhost:8000 を開きます。

- `.vrm` ファイルを画面にドラッグ＆ドロップすると、マネキンが VRM に差し替わります。
- `?vrm=./models/your.vrm` を付けると、起動時に VRM を読み込みます。
- `?gen=onnx` を付けると、`models/generator.onnx` と `models/decoder.onnx` を WebGPU で読み込みます。

## 操作

| キー | 動作 |
| --- | --- |
| 矢印 / WASD | ダッシュ（カメラ基準） |
| Shift + 移動 | 歩き |
| C | しゃがむ／立つ |
| H | 表示を隠す |
| マウスドラッグ | カメラ回転 |

箱に向かって走ると、自動で飛び越えます。

## 構成

```
index.html                     import map（three / three-vrm）と HUD
src/main.js                    ループ、カメラ、入力から制御信号を作る、障害物の検出
src/character.js               VRM（正規化ボーン）／簡易マネキン
src/input.js                   キー → カメラ基準の方向
src/world.js                   床・障害物・レイキャスト
src/motion/player.js           フレーム列の再生と先読み生成
src/motion/proceduralGenerator.js  ダミー生成器
src/motion/onnxGenerator.js    MotionBricks (ONNX / WebGPU) 生成器の雛形
src/motion/retarget.js         出力骨格 → VRM ボーンのリターゲットの雛形
tools/export_onnx.py           PyTorch → ONNX 書き出しの雛形
```

### 生成器のインターフェース

```js
generate(control) -> Promise<{ frames, tokens }>
// control: { turn, speed(0..2), crouch, vault: {dist, height, depth} | null }
// frame:   { dForward, dYaw, height, tag?, bones: { hips: [x,y,z,w], ... } }
```

`MotionPlayer` は、再生待ちのフレームが `lookahead`（既定は 8 フレーム）を下回ると次の生成を投げます。
生成器は、自分が最後に作ったフレームの続きとして次の区間を作ります。

## MotionBricks に差し替える手順

1. MotionBricks（GR00T-WholeBodyControl/motionbricks）を Python で動かし、出力の骨格・関節順・回転表現・座標系を確認する。
2. `tools/export_onnx.py` の TODO を埋めて ONNX を書き出し、`models/` に置く。
3. `src/motion/retarget.js` の `SOURCE_JOINTS` / `JOINT_MAP` / `AXIS` / `REST` を埋める。
4. `src/motion/onnxGenerator.js` の入出力テンソル名・形状・条件ベクトルを、書き出したモデルに合わせる。
   起動時に、コンソールへ入出力名が表示されます。
5. `?gen=onnx` で起動する。

重み（モデルの重みファイル）は NVIDIA Open Model License です。公開する前に条件を確認してください。
