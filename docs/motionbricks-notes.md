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

- **飛び越え**：公開されている mode に jump / vault はありません。プロジェクトページの「ベンチを飛び越える」は smart object で、配布物には含まれていません。`specific_target_positions` で障害物の向こうを目標にする方法は試していません。
- **ファイルサイズ**：pose model だけで約 2 億パラメータあります。planner_sonic.onnx のサイズと、外部データファイル（`.onnx.data`）に分かれているかは未確認です。WebGPU のバッファ上限に当たる可能性があります。
- **ライセンス**：重みは NVIDIA Open Model License です。public リポジトリに ONNX を置かないでください（`.gitignore` 済み）。
