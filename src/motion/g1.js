// Unitree G1 (29DoF) の MuJoCo qpos → VRM 正規化ボーンへのリターゲット。
//
// qpos[36] = [root pos (x,y,z), root quat (w,x,y,z), 29 関節角]
// MuJoCo 座標は Z-up / X-forward / Y-left。three.js（VRM）は Y-up / Z-forward / X-left。
//   three.x = mj.y, three.y = mj.z, three.z = mj.x
//
// 方針：G1 の各リンクのワールド回転を順運動学で求め、「ゼロ姿勢からの差分」を VRM のボーンに載せる。
//   G1 のゼロ姿勢は「脚まっすぐ・上腕は下ろす・肘から先は前向き」なので、腕だけ VRM の T ポーズとの差を補正する。
import * as THREE from 'three';

export const G1_PELVIS_HEIGHT = 0.793; // ゼロ姿勢での骨盤の高さ（g1_29dof.xml）

// [リンク名, 親, ボディ quat (w,x,y,z) | null, 回転軸, qpos の関節インデックス(0..28)]
// GR00T-WholeBodyControl/motionbricks/assets/skeletons/g1/g1_29dof.xml から抜き出したもの
const LINKS = [
  ['left_hip_pitch', 'pelvis', null, [0, 1, 0], 0],
  ['left_hip_roll', 'left_hip_pitch', [0.996179, 0, -0.0873386, 0], [1, 0, 0], 1],
  ['left_hip_yaw', 'left_hip_roll', null, [0, 0, 1], 2],
  ['left_knee', 'left_hip_yaw', [0.996179, 0, 0.0873386, 0], [0, 1, 0], 3],
  ['left_ankle_pitch', 'left_knee', null, [0, 1, 0], 4],
  ['left_ankle_roll', 'left_ankle_pitch', null, [1, 0, 0], 5],
  ['right_hip_pitch', 'pelvis', null, [0, 1, 0], 6],
  ['right_hip_roll', 'right_hip_pitch', [0.996179, 0, -0.0873386, 0], [1, 0, 0], 7],
  ['right_hip_yaw', 'right_hip_roll', null, [0, 0, 1], 8],
  ['right_knee', 'right_hip_yaw', [0.996179, 0, 0.0873386, 0], [0, 1, 0], 9],
  ['right_ankle_pitch', 'right_knee', null, [0, 1, 0], 10],
  ['right_ankle_roll', 'right_ankle_pitch', null, [1, 0, 0], 11],
  ['waist_yaw', 'pelvis', null, [0, 0, 1], 12],
  ['waist_roll', 'waist_yaw', null, [1, 0, 0], 13],
  ['torso', 'waist_roll', null, [0, 1, 0], 14],
  ['left_shoulder_pitch', 'torso', [0.990264, 0.139201, 1.38722e-05, -9.86868e-05], [0, 1, 0], 15],
  ['left_shoulder_roll', 'left_shoulder_pitch', [0.990268, -0.139172, 0, 0], [1, 0, 0], 16],
  ['left_shoulder_yaw', 'left_shoulder_roll', null, [0, 0, 1], 17],
  ['left_elbow', 'left_shoulder_yaw', null, [0, 1, 0], 18],
  ['left_wrist_roll', 'left_elbow', null, [1, 0, 0], 19],
  ['left_wrist_pitch', 'left_wrist_roll', null, [0, 1, 0], 20],
  ['left_wrist_yaw', 'left_wrist_pitch', null, [0, 0, 1], 21],
  ['right_shoulder_pitch', 'torso', [0.990264, -0.139201, 1.38722e-05, 9.86868e-05], [0, 1, 0], 22],
  ['right_shoulder_roll', 'right_shoulder_pitch', [0.990268, 0.139172, 0, 0], [1, 0, 0], 23],
  ['right_shoulder_yaw', 'right_shoulder_roll', null, [0, 0, 1], 24],
  ['right_elbow', 'right_shoulder_yaw', null, [0, 1, 0], 25],
  ['right_wrist_roll', 'right_elbow', null, [1, 0, 0], 26],
  ['right_wrist_pitch', 'right_wrist_roll', null, [0, 1, 0], 27],
  ['right_wrist_yaw', 'right_wrist_pitch', null, [0, 0, 1], 28],
];

// VRM ボーン ← G1 リンク（VRM の親の順に並べる）
const H = Math.PI / 2;
const BONE_MAP = [
  // [VRM ボーン, VRM の親, G1 リンク, T ポーズ補正（three 座標のオイラー角 XYZ）]
  ['hips', null, 'pelvis', [0, 0, 0]],
  ['spine', 'hips', 'waist_roll', [0, 0, 0]],
  ['chest', 'spine', 'torso', [0, 0, 0]],
  ['neck', 'chest', 'torso', [0, 0, 0]],
  ['head', 'neck', 'torso', [0, 0, 0]],
  ['leftUpperLeg', 'hips', 'left_hip_yaw', [0, 0, 0]],
  ['leftLowerLeg', 'leftUpperLeg', 'left_knee', [0, 0, 0]],
  ['leftFoot', 'leftLowerLeg', 'left_ankle_roll', [0, 0, 0]],
  ['rightUpperLeg', 'hips', 'right_hip_yaw', [0, 0, 0]],
  ['rightLowerLeg', 'rightUpperLeg', 'right_knee', [0, 0, 0]],
  ['rightFoot', 'rightLowerLeg', 'right_ankle_roll', [0, 0, 0]],
  // 腕：G1 のゼロ姿勢は「上腕は下ろす・肘から先は前向き（90° 曲げ）」。
  // VRM の T ポーズ（左腕は +X、右腕は -X）をそこへ向ける補正をかける。
  ['leftUpperArm', 'chest', 'left_shoulder_yaw', [0, 0, -H]],   // +X → 下
  ['leftLowerArm', 'leftUpperArm', 'left_elbow', [0, -H, 0]],   // +X → 前
  ['leftHand', 'leftLowerArm', 'left_wrist_yaw', [0, -H, 0]],
  ['rightUpperArm', 'chest', 'right_shoulder_yaw', [0, 0, H]],  // -X → 下
  ['rightLowerArm', 'rightUpperArm', 'right_elbow', [0, H, 0]], // -X → 前
  ['rightHand', 'rightLowerArm', 'right_wrist_yaw', [0, H, 0]],
];

// MuJoCo → three の基底変換（巡回置換なので純粋な回転）
const P = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1),
);
const P_INV = P.clone().invert();

const linkDefs = LINKS.map(([name, parent, quat, axis, index]) => ({
  name, parent, index,
  body: quat ? new THREE.Quaternion(quat[1], quat[2], quat[3], quat[0]) : new THREE.Quaternion(),
  axis: new THREE.Vector3(...axis),
}));

const _hinge = new THREE.Quaternion();

// 各リンクのワールド回転（MuJoCo 座標）
function forwardKinematics(rootQuat, joints) {
  const world = { pelvis: rootQuat.clone() };
  for (const l of linkDefs) {
    _hinge.setFromAxisAngle(l.axis, joints ? joints[l.index] : 0);
    world[l.name] = world[l.parent].clone().multiply(l.body).multiply(_hinge);
  }
  return world;
}

// ゼロ姿勢のワールド回転の逆（three 座標）
const restInv = {};
{
  const rest = forwardKinematics(new THREE.Quaternion(), null);
  for (const [name, q] of Object.entries(rest)) restInv[name] = toThree(q).invert();
}
const correction = Object.fromEntries(BONE_MAP.map(([bone, , , e]) => [
  bone, new THREE.Quaternion().setFromEuler(new THREE.Euler(...e)),
]));

function toThree(q) {
  return P.clone().multiply(q).multiply(P_INV);
}

const _fwd = new THREE.Vector3();
const _yawInv = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * qpos[36] → MuJoCo 非依存のフレーム
 * @returns {{ root: {x, y, z, yaw}, bones: {[vrmBone]: [x,y,z,w]} }}
 *   root はメートル（G1 スケール）、three 座標。yaw は +Z を 0 とした向き。
 */
export function qposToFrame(qpos) {
  const rootQuat = new THREE.Quaternion(qpos[4], qpos[5], qpos[6], qpos[3]);
  const joints = qpos.subarray ? qpos.subarray(7) : qpos.slice(7);
  const world = forwardKinematics(rootQuat, joints);

  // VRM ボーンのワールド回転 = (G1 リンクのゼロ姿勢からの差分) × T ポーズ補正
  const vrmWorld = {};
  for (const [bone, , link] of BONE_MAP) {
    vrmWorld[bone] = toThree(world[link]).multiply(restInv[link]).multiply(correction[bone]);
  }

  // 骨盤の向きから yaw を取り出し、キャラクター全体の向きにする
  _fwd.set(0, 0, 1).applyQuaternion(vrmWorld.hips);
  const yaw = Math.atan2(_fwd.x, _fwd.z);
  _yawInv.setFromAxisAngle(_up, -yaw);

  const bones = {};
  for (const [bone, parent] of BONE_MAP) {
    const local = parent
      ? vrmWorld[parent].clone().invert().multiply(vrmWorld[bone])
      : _yawInv.clone().multiply(vrmWorld[bone]);
    bones[bone] = local.toArray();
  }

  return {
    root: { x: qpos[1], y: qpos[2], z: qpos[0], yaw },
    bones,
  };
}

// 立ち姿勢（初期コンテキスト）：原点、yaw=0、関節はすべて 0
export function standingQpos(x = 0, y = 0, yaw = 0) {
  const q = new Float32Array(36);
  q[0] = x; q[1] = y; q[2] = G1_PELVIS_HEIGHT;
  q[3] = Math.cos(yaw / 2); q[6] = Math.sin(yaw / 2); // Z 軸まわり
  return q;
}
