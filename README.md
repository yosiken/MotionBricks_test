# MotionBricks ライブデモ（雛形）

ブラウザでキー操作に合わせてモーションを生成し、VRM キャラクターを動かすデモの雛形です。

- 既定では **MotionBricks の SOMA（人体）モデル** を WebGPU で動かします。待機・歩き・走り・しゃがみ・飛び越えのすべてをモデルが生成します（[手順](#motionbricks-soma-を動かす手順)）。
- `?gen=dummy` で、モデル不要の手続き的なダミー生成器で動きます。
- `?gen=planner` で、GEAR-SONIC のプランナー（`planner_sonic.onnx`、G1 ロボット用）を動かします。
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
  WebGPU が使えないときは WASM（CPU）で動かします。`&ep=wasm` / `&ep=webgpu` で固定できます。
- `?gen=g1test` を付けると、数式で作った G1 の関節角をリターゲットして表示します。

## 操作

| キー | 動作 |
| --- | --- |
| 矢印 / WASD | ダッシュ（カメラ基準） |
| Shift + 移動 | 歩き |
| C | しゃがむ／立つ |
| H | 表示を隠す |
| マウスドラッグ | カメラ回転 |

箱に向かって走ると、自動で飛び越えます。SOMA では、公式のスマートプリミティブ（`jump_0_5m` / `jump_0_75m`）と同じく、箱を基準に「入口 → 踏み切り → 着地」の目標姿勢を置き、間をモデルが生成します。プランナー（G1）には飛び越えが無いので、踏み切りから着地までは G1 の関節角を手続き的に作って差し込みます（`plannerGenerator.js` の `vaultQpos`）。

## 構成

```
index.html                          import map（three / three-vrm）と HUD
src/main.js                         ループ、カメラ、入力から制御信号を作る、障害物の検出
src/character.js                    VRM（正規化ボーン）／簡易マネキン
src/input.js                        キー → カメラ基準の方向
src/world.js                        床・障害物・レイキャスト
src/motion/player.js                フレーム列の再生と先読み生成
src/motion/soma.js                  MotionBricks SOMA の入出力（エンコード・デコード・端点補正）
src/motion/somaGenerator.js         SOMA の再生・目標姿勢の配置・飛び越え・VRM への変換
tools/build_soma_assets.py          公式サンプルモーションから目標姿勢を切り出す
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

## MotionBricks SOMA を動かす手順

1. 公式リポジトリ [NVlabs/motionbricks](https://github.com/NVlabs/motionbricks) を、このリポジトリの隣に clone し、必要なファイルを Git LFS で取得する。

   ```bash
   git clone https://github.com/NVlabs/motionbricks.git motionbricks_official
   cd motionbricks_official
   git lfs pull --include="motionbricks/assets/onnx/soma/mmm_v6_soma_fp16.onnx,assets/motions/soma/**,motionbricks/assets/human/**"
   ```

2. ONNX をこのリポジトリの `models/` にコピーし、目標姿勢を作る（`usd-core` は骨格の USD を読むのに使う）。

   ```bash
   copy motionbricks_official\motionbricks\assets\onnx\soma\mmm_v6_soma_fp16.onnx MotionBricks_test\models\
   cd MotionBricks_test
   pip install numpy usd-core
   python tools/build_soma_assets.py --motionbricks ../motionbricks_official
   ```

3. `python -m http.server 8000` で起動し、http://localhost:8000/ を開く。

- モデルは MotionBricks-SOMA-RP-v1（NVIDIA Open Model Agreement）、ランタイムの移植元のコードは Apache 2.0 です。
- `models/soma_assets.json` はサンプルモーション（NVIDIA Sample Data Evaluation License、評価・テスト用）から作るので、Git には含めません（`.gitignore` 済み）。

## Blender のキャラクターを使う

VRM で書き出したものを、画面にドラッグ＆ドロップするか `?vrm=./models/ファイル名.vrm` で読み込みます。T ポーズ・正面 -Y・実寸（1 単位 = 1m）で作り、[VRM Add-on for Blender](https://vrm-addon-for-blender.info) でヒューマノイドのボーンを割り当てて書き出してください。

Tripo で自動リグを付けたもの（`bone_0`〜`bone_51`）は、次のコマンドでボーンの割り当てと T ポーズ化をして書き出せます（元の `.blend` は保存しません）。

```bash
blender -b キャラクター.blend --python tools/tripo_blend_to_vrm.py -- models/キャラクター.vrm
```

カメラと飛び越えの判定はキャラクターの腰の高さに合わせて変わります。小柄なキャラクターほど、飛び越えられる箱は低くなります（人間の寸法で 0.95m まで）。

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
   初回はシェーダのコンパイルで数十秒かかります。コードを更新したあとは Ctrl+F5 で再読み込みしてください（`http.server` はキャッシュを止めないので、古い JS が残ることがあります）。

うまく動かない場合は、まず `?gen=g1test` でリターゲットが正しく見えるかを確認してください。

重みは NVIDIA Open Model License です。ONNX を public リポジトリに置かないでください（`.gitignore` で除外済み）。
