"""自動リグを付けたキャラクター（.blend）を VRM 1.0 に書き出す。元の .blend は保存しない。

対応するリグ:
- Tripo（bone_0〜bone_51）。Mixamo と同じ並び（腰 → 背骨 → 首・頭 → 左腕と指 → 右腕と指 → 左脚 → 右脚）。
- Mixamo（mixamorig:Hips など）。FBX を読み込んだままのものは、レスト姿勢が寝ていて
  アニメーションの 1 フレーム目で起き上がっていることがあるので、その姿勢をレスト姿勢として焼き込む。
腕は水平から少し下がっていることが多いので、上腕と前腕を水平にした姿勢を T ポーズとして書き出す。

使い方（VRM Add-on for Blender を入れた Blender で）:
    blender -b キャラクター.blend --python tools/blend_to_vrm.py -- models/キャラクター.vrm [作者名]
"""

import sys

import bpy
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:]
out = args[0]
author = args[1] if len(args) > 1 else ''

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers)]

fingers = ['thumb_metacarpal', 'thumb_proximal', 'thumb_distal', 'index_proximal', 'index_intermediate', 'index_distal',
           'middle_proximal', 'middle_intermediate', 'middle_distal', 'ring_proximal', 'ring_intermediate', 'ring_distal',
           'little_proximal', 'little_intermediate', 'little_distal']

if 'bone_0' in arm.data.bones:
    index = {
        'hips': 0, 'spine': 1, 'chest': 2, 'upper_chest': 3, 'neck': 4, 'head': 5,
        'left_shoulder': 6, 'left_upper_arm': 7, 'left_lower_arm': 8, 'left_hand': 9,
        'right_shoulder': 25, 'right_upper_arm': 26, 'right_lower_arm': 27, 'right_hand': 28,
        'left_upper_leg': 44, 'left_lower_leg': 45, 'left_foot': 46, 'left_toes': 47,
        'right_upper_leg': 48, 'right_lower_leg': 49, 'right_foot': 50, 'right_toes': 51,
    }
    for k, name in enumerate(fingers):
        index['left_' + name] = 10 + k
        index['right_' + name] = 29 + k
    mapping = {name: f'bone_{i}' for name, i in index.items()}
else:
    p = next(b.name.split(':')[0] + ':' for b in arm.data.bones if b.name.endswith('Hips'))
    mapping = {
        'hips': 'Hips', 'spine': 'Spine', 'chest': 'Spine1', 'upper_chest': 'Spine2', 'neck': 'Neck', 'head': 'Head',
    }
    for side, s in (('left', 'Left'), ('right', 'Right')):
        mapping.update({
            f'{side}_shoulder': f'{s}Shoulder', f'{side}_upper_arm': f'{s}Arm', f'{side}_lower_arm': f'{s}ForeArm',
            f'{side}_hand': f'{s}Hand', f'{side}_upper_leg': f'{s}UpLeg', f'{side}_lower_leg': f'{s}Leg',
            f'{side}_foot': f'{s}Foot', f'{side}_toes': f'{s}ToeBase',
        })
        for k, name in enumerate(fingers):
            finger = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')[k // 3]
            mapping[f'{side}_{name}'] = f'{s}Hand{finger}{k % 3 + 1}'
    mapping = {name: p + bone for name, bone in mapping.items() if p + bone in arm.data.bones}

    # 1 フレーム目の姿勢をレスト姿勢にし、オブジェクトの回転と拡大縮小を適用する
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.objects.active = arm
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        mod = next(m for m in o.modifiers if m.type == 'ARMATURE')
        name = mod.name
        bpy.ops.object.modifier_apply(modifier=name)
        o.modifiers.new(name, 'ARMATURE').object = arm
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data_clear()
    for o in bpy.data.objects:
        o.select_set(o == arm or o in meshes)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# テクスチャの α が Alpha につながっていると半透明（BLEND）で書き出され、描画順が崩れるので不透明にする
for o in meshes:
    for slot in o.material_slots:
        if slot.material and slot.material.node_tree:
            for n in slot.material.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    alpha = n.inputs['Alpha']
                    for link in list(alpha.links):
                        slot.material.node_tree.links.remove(link)
                    alpha.default_value = 1.0

ext = arm.data.vrm_addon_extension
ext.spec_version = '1.0'
humanoid = ext.vrm1.humanoid
for name, bone in mapping.items():
    getattr(humanoid.human_bones, name).node.bone_name = bone

# T ポーズ：アドオンの推定に加えて、上腕と前腕を真横（左腕は +X、右腕は -X）に向ける
bpy.context.view_layer.objects.active = arm
bpy.ops.vrm.make_estimated_humanoid_t_pose(armature_object_name=arm.name)
for name, side in (('left_upper_arm', 1), ('left_lower_arm', 1), ('right_upper_arm', -1), ('right_lower_arm', -1)):
    bpy.context.view_layer.update()
    pb = arm.pose.bones[mapping[name]]
    q = (pb.tail - pb.head).normalized().rotation_difference(Vector((side, 0, 0)))
    pb.matrix = Matrix.Translation(pb.head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-pb.head) @ pb.matrix
humanoid.pose = 'currentPose'
bpy.context.view_layer.update()

meta = ext.vrm1.meta
meta.vrm_name = bpy.path.display_name_from_filepath(bpy.data.filepath)
if author:
    if not meta.authors:
        meta.authors.add()
    meta.authors[0].value = author

print('EXPORT', bpy.ops.export_scene.vrm(filepath=out, armature_object_name=arm.name, ignore_warning=True))
