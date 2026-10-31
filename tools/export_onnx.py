"""MotionBricks のモデルを ONNX に書き出す雛形。

※ クラス名・ロード方法・入力形状は MotionBricks リポジトリ
   (GR00T-WholeBodyControl/motionbricks) の実装を読んで TODO 部分を埋めること。
   ここで決めた入出力名を src/motion/onnxGenerator.js と揃える。

使い方:
    python tools/export_onnx.py --ckpt path/to/checkpoint --out models/
"""
import argparse
from pathlib import Path

import torch


class GeneratorWrapper(torch.nn.Module):
    """(cond, tokens) -> 次トークンの logits。サンプリングループは JS 側で回す。"""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, cond, tokens):
        # TODO: MotionBricks の生成部の forward に合わせる
        logits = self.model.generator(cond=cond, tokens=tokens)
        return logits[:, -1]  # 最後の位置だけ返す


class DecoderWrapper(torch.nn.Module):
    """tokens -> (rotations [T, J, 4], root [T, 3])"""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, tokens):
        # TODO: デコーダの出力を「関節ローカル回転（クォータニオン）」と
        #       「1 フレームあたりの (前進量, 旋回量, 高さ)」に変換して返す
        motion = self.model.decoder(tokens)
        return motion["rotations"], motion["root"]


def load_model(ckpt):
    # TODO: リポジトリのロード関数を使う
    raise NotImplementedError("MotionBricks のモデル読み込み処理を書く")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", default="models")
    ap.add_argument("--cond-dim", type=int, default=8)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = load_model(args.ckpt).eval()

    cond = torch.zeros(1, args.cond_dim)
    tokens = torch.zeros(1, 8, dtype=torch.long)
    with torch.no_grad():
        torch.onnx.export(
            GeneratorWrapper(model), (cond, tokens), out / "generator.onnx",
            input_names=["cond", "tokens"], output_names=["logits"],
            dynamic_axes={"tokens": {1: "seq"}}, opset_version=args.opset,
        )
        torch.onnx.export(
            DecoderWrapper(model), (tokens,), out / "decoder.onnx",
            input_names=["tokens"], output_names=["rotations", "root"],
            dynamic_axes={"tokens": {1: "seq"}, "rotations": {0: "frames"}, "root": {0: "frames"}},
            opset_version=args.opset,
        )
    print("exported to", out)
    # 次に onnxruntime (Python) で PyTorch と出力が一致するか確認すること


if __name__ == "__main__":
    main()
