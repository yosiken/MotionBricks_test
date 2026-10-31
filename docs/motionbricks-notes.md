# MotionBricks 調査メモ

GR00T-WholeBodyControl（`motionbricks/` と `docs/source/references/planner_onnx.md`）を読んでわかったこと。

## 仕組み：自己回帰ではなく「キーフレーム間の補間」

1 回の生成は次の 3 段階です（`motion_backbone/inference/motion_inference.py`）。

1. **root model**（Transformer、512 次元 × 6 層）
   文脈（直近 4 フレーム）と目標（約 1 秒先の 4 フレーム）から、間を何トークンで埋めるか（6〜16）と、骨盤の軌道を予測します。
2. **pose model**（Transformer、1024 次元 × 16 層）
   姿勢トークンを MaskGIT 風に一括で予測します。デモでは 1 ステップ・argmax です。
3. **VQVAE decoder**
   トークンを関節の位置・回転に戻します。1 トークンは 4 フレーム（30fps）です。

ツイートの「11 トークン」は 44 フレーム ≒ 1.5 秒分を意味します。

## 目標はどこから来るか（smart primitive）

`demo/full_agent.py` の処理は次のとおりです。

- **目標の位置と向き**：キー入力の方向から、臨界減衰ばね（critically damped spring）で 1 秒先の骨盤位置と向きを決めます。
- **目標の姿勢**：モード（idle / walk / run / crouch…）ごとのクリップ集から、乱数で 4 フレームを選びます。
- 0.27 秒ごと（8 フレームごと）に、再生中の位置から作り直します。

## ブラウザで使うなら：planner_sonic.onnx

GEAR-SONIC は、上記の全部（正規化・ばねモデル・クリップ選択・3 モデル・qpos 変換）を 1 つの ONNX にまとめて配布しています。

- 場所：Hugging Face `nvidia/GEAR-SONIC` の `planner/target_vel/V2/planner_sonic.onnx`
- 取得方法：`python download_from_hf.py`（GR00T-WholeBodyControl のルートにあります）
- **PyTorch から自分で書き出す必要はありません。**

| 入力 | 形 | 内容 |
| --- | --- | --- |
| `context_mujoco_qpos` | [1,4,36] | 直近 4 フレームの G1 qpos（ワールド座標、Z-up / X 前） |
| `mode` | [1] int64 | 0 idle, 1 slowWalk, 2 walk, 3 run, 4 squat, 22 crouch … |
| `movement_direction` / `facing_direction` | [1,3] | 進む方向と向く方向（別々に指定できる＝横歩き可能） |
| `target_vel` | [1] | 速さの上書き（-1 ならモードの既定値） |
| `height` | [1] | squat / kneel の腰の高さ（-1 なら無効） |
| `random_seed` ほか 4 つ | | 目標の乱数、ウェイポイント指定、許可するトークン数 |

| 出力 | 内容 |
| --- | --- |
| `mujoco_qpos` [1,N,36] | 先頭 `num_pred_frames` フレームだけが有効。先頭 4 フレームは文脈とブレンド済み |
| `num_pred_frames` | トークン数 × 4 |

## 出力は G1 ロボットの骨格

公開版の骨格は Unitree G1（34 関節、qpos は 29 自由度）だけです。人型 VRM で使うにはリターゲットが必要で、`src/motion/g1.js` で次のように変換しています。

- `g1_29dof.xml` の各リンクの初期回転と関節軸を使い、順運動学でワールド回転を求めます。
- 「ゼロ姿勢からの差分」を VRM の正規化ボーンに載せます。
- G1 のゼロ姿勢は「上腕は下ろす・肘から先は前向き」なので、腕だけ T ポーズとの差を補正します。
- 位置は、骨盤の高さの比（VRM の腰の高さ ÷ 0.793）で拡大縮小します。

## 未対応・未確認

- **飛び越え**：公開されている mode に jump / vault はありません。プロジェクトページの「ベンチを飛び越える」は smart object で、配布物には含まれていません。`specific_target_positions` で障害物の向こうを目標にする方法は試していません。デモでは、プランナーの出力を踏み切り位置で打ち切り、そこから着地までの G1 qpos を手続き的に作って差し込んでいます。着地の末尾 4 フレームが次の文脈になるので、その後はモデルの走りに戻ります。
- **ファイルサイズ**：planner_sonic.onnx（target_vel/V2）は外部データ無しの単一ファイルで 774MB、約 1.85 億パラメータ（fp32）、opset 17 です。最大のテンソルは 12MB なので、WebGPU のバッファ上限には当たりません。

## ブラウザで動かしたときの注意（2026-10-31 に確認）

- **ストレージバッファの上限**：このモデルには入力 9 個の Concat（11 個）と出力 9 個の Split（3 個）があり、1 つのシェーダで 10 個のストレージバッファを使います。WebGPU の既定上限は 8 なので、onnxruntime-web にそのまま渡すと `Invalid ComputePipeline "Concat"` が大量に出て、出力が壊れます（待機なのに 6 トークンになる）。onnxruntime-web 1.30.0 でも同じでした。`plannerGenerator.js` では、アダプタの上限まで引き上げた GPUDevice を `ort.env.webgpu.device` に渡して回避しています。上限が 10 未満の GPU では WASM（CPU）で動かします。
- **速度**（RTX 系 Ampere、Edge ベースのブラウザ）：WebGPU で 1 回 約 210〜240ms、WASM（シングルスレッド）で約 250ms、ネイティブの onnxruntime（CPU）で約 60ms。どれも 330ms（10 フレーム分）を下回ります。初回はシェーダのコンパイルで数十秒かかります。
- **出力の確認**：ネイティブの onnxruntime で同じ入力を流し、待機 16 トークン、歩き 約 1.1m/s、走り 約 2.2m/s、方向転換・しゃがみ（高さ 0.55m）が指示どおりになることと、区間の継ぎ目の関節差がフレーム間の差と同程度（約 0.25rad）で飛びが無いことを確かめました。出力の先頭 4 フレームは文脈とほぼ同じ（最大差 0.05）です。
- **ライセンス**：重みは NVIDIA Open Model License です。public リポジトリに ONNX を置かないでください（`.gitignore` 済み）。

## SOMA（人体）モデルへの切り替え（2026-10-31）

既定の生成器を、公式リポジトリ [NVlabs/motionbricks](https://github.com/NVlabs/motionbricks) の SOMA モデル（`mmm_v6_soma_fp16.onnx`、380MB）に切り替えました。G1 ロボットの関節角を人体に変換する必要がなくなり、飛び越えもモデルが生成します。

- **入出力**：入力は「直近 4 姿勢 + 目標 4 姿勢」を、最後の文脈が +X を向くように整列した特徴量（根の位置・向き・速度、関節の位置、6D 回転）。出力は 24〜64 フレームで、両端 3 フレームを除き、文脈の最後と目標の最初に合うよう端点補正する。`src/motion/soma.js` は公式の `model/soma/kernels.py` を移したもの。
- **目標姿勢**：公式のサンプルモーション（BVH）から、スマートプリミティブと同じ時刻の 4 姿勢を切り出す（`tools/build_soma_assets.py`）。歩き・走りは 1 秒先、待機はその場、飛び越えは箱を基準に入口 → 踏み切り → 着地の 3 段。
- **再生**：表示した姿勢を履歴に残し、そこから文脈を作る。動きの終わりの少し手前で次を生成し、生成にかかった時間だけ先から再生して、前の動きから 0.2 秒でつなぐ。
- **VRM への変換**：SOMA のレスト姿勢は +Z 正面の T ポーズなので、「関節のワールド回転 × レストのワールド回転の逆」をそのまま VRM の正規化ボーンに当てる。
- **確認した値**：Node の onnxruntime（CPU）で 1 回約 150ms、ブラウザの WASM で約 320ms。補正前の端点のずれは文脈側 0.3〜3cm、目標側 0.5〜25cm で、エンコードが学習時の表現と合っている。0.5m の箱では足と箱の隙間 4〜9cm、0.82m の片手飛び越えでは最大 8cm かすめる。
- **ライセンス**：モデルは NVIDIA Open Model Agreement、移植元のコードは Apache 2.0、サンプルモーション（とそこから作る `models/soma_assets.json`）は NVIDIA Sample Data Evaluation License（評価・テスト用）なので Git に含めない。
