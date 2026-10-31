// MotionBricks の出力骨格 → VRM 正規化 Humanoid ボーンへのリターゲット。
//
// ※ 雛形です。関節名・関節順・座標系・レストポーズは、実際のモデル出力を確認して埋めてください。
//   正規化 VRM ボーンは「Tポーズで全ローカル回転が単位、+Y 上、+Z 正面」。
import * as THREE from 'three';

// TODO: モデル出力の関節順（インデックス）に合わせる。以下は SMPL 系スケルトンの例。
export const SOURCE_JOINTS = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2',
  'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot', 'neck',
  'left_collar', 'right_collar', 'head', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
];

// ソース関節名 → VRM ボーン名
export const JOINT_MAP = {
  pelvis: 'hips',
  spine1: 'spine',
  spine3: 'chest',
  neck: 'neck',
  head: 'head',
  left_hip: 'leftUpperLeg',
  left_knee: 'leftLowerLeg',
  left_ankle: 'leftFoot',
  right_hip: 'rightUpperLeg',
  right_knee: 'rightLowerLeg',
  right_ankle: 'rightFoot',
  left_shoulder: 'leftUpperArm',
  left_elbow: 'leftLowerArm',
  right_shoulder: 'rightUpperArm',
  right_elbow: 'rightLowerArm',
};

// ソースの座標系 → VRM（+Y 上 / +Z 正面）への変換。
// 例：ソースが Z-up・+Y 正面なら X 軸まわりに -90°。
// TODO: 実際の出力を見て決める。
const AXIS = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
const AXIS_INV = AXIS.clone().invert();

// ソースのレストポーズ（例：Aポーズ）と VRM の Tポーズの差。
// q_vrm = AXIS * q_src * AXIS^-1 * REST[bone]
// TODO: ソース骨格のレストポーズに合わせて埋める（A ポーズなら腕に ±約45° の Z 回転など）。
const REST = {};

// 間を飛ばしたソース関節（spine2, collar など）の回転を、対応する VRM ボーンへ畳み込む
// TODO: 必要なら有効にする
const FOLD_INTO = {
  // spine2: 'spine',
  // left_collar: 'leftUpperArm',
  // right_collar: 'rightUpperArm',
};

const _q = new THREE.Quaternion();
const _tmp = new THREE.Quaternion();

/**
 * 1 フレーム分のソース出力を MotionPlayer の Frame に変換する。
 * @param {Float32Array} rotations 関節数×4（ローカル回転クォータニオン xyzw）
 * @param {{ dForward:number, dYaw:number, height:number }} root ルート移動（キャラクターローカル）
 */
export function retargetFrame(rotations, root) {
  const bones = {};
  const folded = {};
  SOURCE_JOINTS.forEach((joint, i) => {
    _q.fromArray(rotations, i * 4);
    _q.premultiply(AXIS).multiply(AXIS_INV);
    const vrm = JOINT_MAP[joint];
    if (vrm) {
      if (REST[vrm]) _q.multiply(REST[vrm]);
      bones[vrm] = _q.toArray();
    } else if (FOLD_INTO[joint]) {
      folded[FOLD_INTO[joint]] = _q.clone();
    }
  });
  for (const [vrm, q] of Object.entries(folded)) {
    if (bones[vrm]) bones[vrm] = _tmp.copy(q).multiply(_q.fromArray(bones[vrm])).toArray();
  }
  return { ...root, bones };
}
