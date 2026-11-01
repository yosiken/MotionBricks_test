// キャラクター（VRM または簡易マネキン）。
// どちらも VRM の正規化 Humanoid ボーン名で姿勢を受け取る。
// 正規化ボーンは「Tポーズで全回転が単位、+Z が正面」という共通座標系。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { G1_PELVIS_HEIGHT } from './motion/g1.js';

// 親が先に来る順（applyWorldPose がこの順で親のワールド回転を使う）
export const BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
];
// VRM Humanoid の親子関係
const PARENT = {
  spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
};
const _parentInv = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _t = new THREE.Vector3();

// ボーンにワールドでの回転 delta を加える（子も一緒に回る）
function rotateWorld(bone, delta) {
  const parent = bone.parent.getWorldQuaternion(_q3);
  const world = parent.clone().multiply(bone.quaternion);
  bone.quaternion.copy(parent.invert().multiply(delta.clone().multiply(world)));
  bone.updateMatrixWorld(true);
}

export class Character {
  constructor(scene) {
    this.root = new THREE.Group();   // 位置と向き（yaw）
    this.body = new THREE.Group();   // 上下動（しゃがみ・ジャンプ）
    this.root.add(this.body);
    scene.add(this.root);
    this.yaw = 0;
    this.bones = {};
    this.vrm = null;
    this.hipsHeight = 0.95; // レストポーズでの腰の高さ（G1 の動きの拡大縮小に使う）
    this.useMannequin();
  }

  get g1Scale() {
    return this.hipsHeight / G1_PELVIS_HEIGHT;
  }

  clearModel() {
    if (this.vrm) {
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.body.clear();
    this.bones = {};
  }

  useMannequin() {
    this.clearModel();
    const { root, bones } = buildMannequin();
    this.body.add(root);
    this.bones = bones;
    this.hipsHeight = 0.95;
  }

  async loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    // three-vrm 3.1 には combineSkeletons が無いので、同じ目的の旧関数を使う
    (VRMUtils.combineSkeletons ?? VRMUtils.removeUnnecessaryJoints)?.call(VRMUtils, gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0 は -Z 向きなので +Z 向きに揃える
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

    this.clearModel();
    this.vrm = vrm;
    this.body.add(vrm.scene);
    for (const name of BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.bones[name] = node;
    }
    vrm.scene.updateMatrixWorld(true);
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    this.hipsHeight = hips ? hips.getWorldPosition(new THREE.Vector3()).y : 0.95;
  }

  // pose: { height, bones: { name: THREE.Quaternion } }
  applyPose(pose) {
    this.body.position.y = pose.height;
    for (const [name, q] of Object.entries(pose.bones)) {
      this.bones[name]?.quaternion.copy(q);
    }
    this.root.rotation.y = this.yaw;
  }

  // 正規化ボーンのワールド回転（キャラクターの向きを除いたもの、[x, y, z, w]）で姿勢を当てる。
  // モデルに無いボーン（upperChest や肩など）の回転は、その子が肩代わりする。
  applyWorldPose(height, worldRotations) {
    const world = {};
    for (const name of BONES) {
      const r = worldRotations[name];
      let parent = PARENT[name];
      while (parent && !(parent in world)) parent = PARENT[parent];
      if (!r) {
        if (parent) world[name] = world[parent];
        continue;
      }
      world[name] = new THREE.Quaternion().fromArray(r);
      const bone = this.bones[name];
      if (!bone) { world[name] = parent ? world[parent] : world[name]; continue; }
      bone.quaternion.copy(world[name]);
      if (parent) bone.quaternion.premultiply(_parentInv.copy(world[parent]).invert());
    }
    this.body.position.y = height;
    this.root.rotation.y = this.yaw;
  }

  // 足首（foot ボーン）をワールドの位置 targets[side]（[x, y, z]）に置く 2 関節の IK。膝の曲がる向きと足の向きは今のまま。
  // 脚の付け根の間隔や脚の長さが動きの元（SOMA）と違うキャラクターでも、足の置き場所が元と同じになる
  reachFeet(targets) {
    this.root.updateMatrixWorld(true);
    for (const side of ['left', 'right']) {
      const upper = this.bones[side + 'UpperLeg'], lower = this.bones[side + 'LowerLeg'], foot = this.bones[side + 'Foot'];
      if (!upper || !lower || !foot || !targets[side]) continue;
      const target = _t.fromArray(targets[side]);
      const footWorld = foot.getWorldQuaternion(_q1);
      const a = upper.getWorldPosition(_a), b = lower.getWorldPosition(_b), c = foot.getWorldPosition(_c);
      const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
      const d = THREE.MathUtils.clamp(a.distanceTo(target), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
      // 1. 膝の角度：付け根〜足首の距離が d になるよう、膝を曲げ伸ばしする（軸は今の曲がりの面の法線）
      const ba = _v1.subVectors(a, b).normalize(), bc = _v2.subVectors(c, b).normalize();
      const axis = _v3.crossVectors(bc, ba);
      if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).applyQuaternion(upper.getWorldQuaternion(_q2)); // 伸びきっているときは膝の左右の軸
      axis.normalize();
      const now = Math.acos(THREE.MathUtils.clamp(ba.dot(bc), -1, 1));
      const want = Math.acos(THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
      rotateWorld(lower, _q2.setFromAxisAngle(axis, now - want));
      // 2. 太もも：付け根→足首の向きを、付け根→目標へ回す
      this.root.updateMatrixWorld(true);
      const from = _v1.subVectors(foot.getWorldPosition(_c), a).normalize(), to = _v2.subVectors(target, a).normalize();
      rotateWorld(upper, _q2.setFromUnitVectors(from, to));
      // 3. 足の向きを元に戻す
      upper.updateMatrixWorld(true);
      foot.quaternion.copy(lower.getWorldQuaternion(_q2).invert().multiply(footWorld));
    }
  }

  update(dt) {
    this.vrm?.update(dt); // 正規化ボーン→実ボーンへの転写と SpringBone
  }
}

// --- VRM が無くても動かせる簡易マネキン（+Z 正面、Tポーズ） ---
function buildMannequin() {
  // [ボーン名, 親, 親からのオフセット, 子方向（メッシュ用）]
  const defs = [
    ['hips', null, [0, 0.95, 0], [0, 0.1, 0]],
    ['spine', 'hips', [0, 0.1, 0], [0, 0.15, 0]],
    ['chest', 'spine', [0, 0.15, 0], [0, 0.2, 0]],
    ['neck', 'chest', [0, 0.2, 0], [0, 0.08, 0]],
    ['head', 'neck', [0, 0.08, 0], null],
    ['leftUpperArm', 'chest', [0.18, 0.15, 0], [0.27, 0, 0]],
    ['leftLowerArm', 'leftUpperArm', [0.27, 0, 0], [0.25, 0, 0]],
    ['rightUpperArm', 'chest', [-0.18, 0.15, 0], [-0.27, 0, 0]],
    ['rightLowerArm', 'rightUpperArm', [-0.27, 0, 0], [-0.25, 0, 0]],
    ['leftUpperLeg', 'hips', [0.1, -0.05, 0], [0, -0.42, 0]],
    ['leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0], [0, -0.42, 0]],
    ['leftFoot', 'leftLowerLeg', [0, -0.42, 0], [0, -0.04, 0.14]],
    ['rightUpperLeg', 'hips', [-0.1, -0.05, 0], [0, -0.42, 0]],
    ['rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0], [0, -0.42, 0]],
    ['rightFoot', 'rightLowerLeg', [0, -0.42, 0], [0, -0.04, 0.14]],
  ];
  const mat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.6 });
  const root = new THREE.Group();
  const bones = {};
  const up = new THREE.Vector3(0, 1, 0);

  for (const [name, parent, offset, child] of defs) {
    const bone = new THREE.Object3D();
    bone.name = name;
    bone.position.fromArray(offset);
    (parent ? bones[parent] : root).add(bone);
    bones[name] = bone;

    if (child) {
      const v = new THREE.Vector3().fromArray(child);
      const len = v.length();
      const thick = name.startsWith('hips') || name.startsWith('spine') || name.startsWith('chest') ? 0.22 : 0.075;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick * 0.8), name.includes('Lower') ? accent : mat);
      mesh.position.copy(v).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(up, v.clone().normalize());
      mesh.castShadow = true;
      bone.add(mesh);
    } else {
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), mat);
      head.position.y = 0.11;
      head.castShadow = true;
      bone.add(head);
    }
  }
  return { root, bones };
}
