# MotionBricks ライブデモ（雛形）

ブラウザでキー操作に合わせてモーションを生成し、VRM キャラクターを動かすデモの雛形です。

- 最初は **手続き的なダミー生成器** で動きます（モデル不要）。
- `?gen=planner` で、MotionBricks のプランナー（`planner_sonic.onnx`）を WebGPU で動かします。
- `?gen=g1test` で、モデル無しに「G1 ロボットの関節角 → VRM」の変換を確かめられます。

MotionBricks の仕組みと調べた内容は [docs/motionbricks-notes.md](docs/motionbricks-notes.md) にまとめています。

## 起動

```bash
cd motionbricks-demo
python3 -m http.server 8000
```

http://localhost:8000 を開きます。

- `.vrm` ファイルを画面にドラッグ＆ドロップすると、マネキンが VRM に差し替わります。
- `?vrm=./models/your.vrm` を付けると、起動時に VRM を読み込みます。
- `?gen=planner` を付けると、`models/planner_sonic.onnx` を WebGPU で読み込みます（`?model=URL` で場所を変更可）。
- `?gen=g1test` を付けると、数式で作った G1 の関節角をリターゲットして表示します。

## 操作

| キー | 動作 |
| --- | --- |
| 矢印 / WASD | ダッシュ（カメラ基準） |
| Shift + 移動 | 歩き |
| C | しゃがむ／立つ |
| H | 表示を隠す |
| マウスドラッグ | カメラ回転 |

箱に向かって走ると、自動で飛び越えます（ダミー生成器のみ。MotionBricks の公開版に飛び越えは無いため）。

## 構成

```
index.html                          import map（three / three-vrm）と HUD
src/main.js                         ループ、カメラ、入力から制御信号を作る、障害物の検出
src/character.js                    VRM（正規化ボーン）／簡易マネキン
src/input.js                        キー → カメラ基準の方向
src/world.js                        床・障害物・レイキャスト
src/motion/player.js                フレーム列の再生と先読み生成
src/motion/proceduralGenerator.js   ダミー生成器
src/motion/plannerGenerator.js      MotionBricks プランナー（ONNX / WebGPU）
src/motion/g1.js                    G1 の qpos → VRM ボーンのリターゲット
src/motion/g1TestGenerator.js       リターゲット確認用のテスト生成器
docs/motionbricks-notes.md          MotionBricks の調査メモ
```

### 生成器のインターフェース

```js
generate(control) -> Promise<{ frames, tokens }>
// control: { moving, yaw, turn, speed(0..2), crouch, vault: {dist, height, depth} | null }
// frame:   { dForward, dYaw, height, tag?, bones }   相対移動（ダミー生成器）
//      or: { root: {x, y, z, yaw}, tag?, bones }      絶対座標（G1 系。G1 のメートル単位）
```

`MotionPlayer` は、再生待ちのフレームが `lookahead`（既定は 8 フレーム）を下回ると次の生成を投げます。
生成器は、自分が最後に作ったフレームの続きとして次の区間を作ります。

## MotionBricks のプランナーを動かす手順

1. 手元の PC で GR00T-WholeBodyControl を clone し、プランナーをダウンロードする。

   ```bash
   git clone https://github.com/NVlabs/GR00T-WholeBodyControl.git
   cd GR00T-WholeBodyControl
   pip install huggingface_hub
   python download_from_hf.py
   ```

2. ダウンロードされた `planner_sonic.onnx` をこのリポジトリの `models/` にコピーする。
   `.onnx.data` などの外部重みファイルが一緒にあれば、それもコピーし、URL に `&modelData=./models/<ファイル名>` を付ける。
3. `python3 -m http.server 8000` で起動し、http://localhost:8000/?gen=planner を開く。WebGPU 対応ブラウザ（Chrome / Edge）が必要です。
4. コンソールに入出力名が表示されます。読み込みや推論で失敗した場合は、ダミー生成器で起動します。

うまく動かない場合は、まず `?gen=g1test` でリターゲットが正しく見えるかを確認してください。

重みは NVIDIA Open Model License です。ONNX を public リポジトリに置かないでください（`.gitignore` で除外済み）。
