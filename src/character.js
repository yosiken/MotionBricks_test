// キャラクター（VRM または簡易マネキン）。
// どちらも VRM の正規化 Humanoid ボーン名で姿勢を受け取る。
// 正規化ボーンは「Tポーズで全回転が単位、+Z が正面」という共通座標系。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

export class Character {
  constructor(scene) {
    this.root = new THREE.Group();   // 位置と向き（yaw）
    this.body = new THREE.Group();   // 上下動（しゃがみ・ジャンプ）
    this.root.add(this.body);
    scene.add(this.root);
    this.yaw = 0;
    this.bones = {};
    this.vrm = null;
    this.useMannequin();
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
  }

  async loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0 は -Z 向きなので +Z 向きに揃える
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

    this.clearModel();
    this.vrm = vrm;
    this.body.add(vrm.scene);
    for (const name of BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.bones[name] = node;
    }
  }

  // pose: { height, bones: { name: THREE.Quaternion } }
  applyPose(pose) {
    this.body.position.y = pose.height;
    for (const [name, q] of Object.entries(pose.bones)) {
      this.bones[name]?.quaternion.copy(q);
    }
    this.root.rotation.y = this.yaw;
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
