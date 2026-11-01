# MotionBricks ライブデモ（雛形）

ブラウザでキー操作に合わせてモーションを生成し、VRM キャラクターを動かすデモの雛形です。

- 既定では **MotionBricks の SOMA（人体）モデル** を WebGPU で動かします。待機・歩き・走り・しゃがみ・飛び越え・歩き方のスタイル・椅子に座るのすべてをモデルが生成します（[手順](#motionbricks-soma-を動かす手順)）。
- 既定のシーンはオフィス（別リポジトリ `3d_office_scene` のアセット）で、キャラクターはスタッフ（`office_lady`）です（[手順](#オフィスのシーン)）。`?scene=boxes` で箱と椅子だけのシーンになります。
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
| 矢印 / WASD | 歩き（カメラ基準） |
| Shift + 移動 | ダッシュ |
| C | しゃがむ／立つ |
| V | 歩き方を切り替え（通常 → スキップ → ヴォーグ → 脇腹を押さえる → 足を引きずる → ゾンビ → 戦闘ステップ） |
| E | 椅子の近く（2.5m 以内）で座る。座っているときは立つ（移動キーでも立つ） |
| H | 表示を隠す |
| マウスドラッグ | カメラ回転 |

箱に向かって走ると、自動で飛び越えます。SOMA では、公式のスマートプリミティブ（`jump_0_5m` / `jump_0_75m`）と同じく、箱を基準に「入口 → 踏み切り → 着地」の目標姿勢を置き、間をモデルが生成します。箱は公式に合わせて、高さ 0.5m の台（奥行き 0.7m 以下）と高さ 0.75m の塀（奥行き 0.3m）です。モデルは障害物を見ていないので、奥行きのある箱では足が箱に入ります。

- 歩き方のスタイルは `locomotion_style_variations_bs1_linear` と同じ目標姿勢を、歩きと同じく 1 秒先に置きます。
- 椅子は `sit` と同じく「座る手前 → 着座」で座り、座っている間は着座の姿勢を目標にし続け（公式は座りのループを再生）、「立ち上がり」で立ちます。椅子の座面は 0.4m で、キャラクターの体格に合わせて拡大縮小します。プランナー（G1）には飛び越えが無いので、踏み切りから着地までは G1 の関節角を手続き的に作って差し込みます（`plannerGenerator.js` の `vaultQpos`）。

## オフィスのシーン

`D:/project/3d_office_scene`（Blender で組んだ日本のオフィス、24m × 18m）を読み込みます。アセットが大きい（約 50MB）ので、Git には入れず `models/office/` にコピーします（`.gitignore` 済み）。

```bash
blender -b --python tools/setup_office.py -- D:/project/3d_office_scene
blender -b --python tools/blend_to_vrm.py -- D:/project/3d_office_scene/blender/office_lady.fbx models/office_lady.vrm
```

- 1 つ目で `office.glb`・Poly Haven と ambientCG のアセット（CC0）をコピーし、椅子 55 脚の位置と向きを `chairs.json` に書き出します。椅子は 1 つのメッシュにまとめられているので、`build_office.py` をもう一度（書き出しなしで）走らせて `placed_chair` の呼び出しを記録します（乱数の種が固定なので同じ配置になります）。
- 2 つ目でスタッフ（Mixamo のリグ）を VRM にします。`models/office/` が無いときは箱のシーンで起動します。
- 読み込み・マテリアル・照明・小物の配置は `3d_office_scene` の `src/main.js` と `src/props.js` と同じです（`src/office.js`、`src/officeTextures.js`）。
- 壁と家具は `COL_*` の箱で当たり判定をします。SOMA の動きは位置もモデルが決めるので、押し戻した分は表示位置のずれ（`offset`）として持ちます。進む向きの 0.6m 以内に箱があると進まずにその方を向き、歩き・走りの目標は箱の手前までに縮めます。
- 椅子の座面は 0.52m で、SOMA の `sit`（0.4m × 体格）と高さが違うので、腰が下がった姿勢ほど差の分だけ持ち上げます。立ち上がった直後は椅子と机の判定が重なった中にいるので、中心が入っている箱は出るまで判定しません。
- 飛び越えの箱はオフィスにはありません。

## 構成

```
index.html                          import map（three / three-vrm）と HUD
src/main.js                         ループ、カメラ、入力から制御信号を作る、障害物の検出
src/character.js                    VRM（正規化ボーン）／簡易マネキン
src/input.js                        キー → カメラ基準の方向
src/world.js                        床・障害物・レイキャスト（箱のシーン）
src/office.js                       オフィスの読み込み・椅子・当たり判定（壁・家具の箱）
tools/setup_office.py               3d_office_scene のオフィスを models/office/ にコピーし、椅子の位置を書き出す
src/motion/player.js                フレーム列の再生と先読み生成
src/motion/soma.js                  MotionBricks SOMA の入出力（エンコード・デコード・端点補正）
src/motion/somaGenerator.js         SOMA の再生・目標姿勢の配置・飛び越え・VRM への変換
tools/build_soma_assets.py          公式サンプルモーションから目標姿勢を切り出す
tools/sim_harness.js                ブラウザのコンソールで飛び越え・椅子を計測する道具
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

Tripo で自動リグを付けたもの（`bone_0`〜`bone_51`）と Mixamo のリグ（`mixamorig:Hips` など）は、次のコマンドでボーンの割り当てと T ポーズ化をして書き出せます（元の `.blend` は保存しません）。Mixamo の FBX を読み込んだままで、レスト姿勢が寝ていてアニメーションの 1 フレーム目で起き上がるものは、その姿勢をレスト姿勢として焼き込みます。

```bash
blender -b キャラクター.blend --python tools/blend_to_vrm.py -- models/キャラクター.vrm
blender -b --python tools/blend_to_vrm.py -- キャラクター.fbx models/キャラクター.vrm
```

SOMA の動きは関節の回転で当てたあと、足首を SOMA の足首（体格で換算）の位置に 2 関節の IK で置きます。脚の付け根の間隔が SOMA より狭いキャラクター（`office_lady` は 0.14m、SOMA は 0.23m）でも、歩くときに左右の足が交差しません。走りは SOMA でも足首がほぼ一直線に並ぶので、左右の間隔が 0.09m × 体格より狭いときは両足を外へ広げます。

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
