"""Tripo で自動リグを付けたキャラクター（.blend）を VRM 1.0 に書き出す。元の .blend は保存しない。

Tripo のリグは bone_0〜bone_51 の名前で、Mixamo と同じ並び（腰 → 背骨 → 首・頭 → 左腕と指 → 右腕と指 → 左脚 → 右脚）。
腕は水平から少し下がっていることが多いので、上腕と前腕を水平にした姿勢を T ポーズとして書き出す。

使い方（VRM Add-on for Blender を入れた Blender で）:
    blender -b キャラクター.blend --python tools/tripo_blend_to_vrm.py -- models/キャラクター.vrm [作者名]
"""

import sys

import bpy
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:]
out = args[0]
author = args[1] if len(args) > 1 else ''

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ext = arm.data.vrm_addon_extension
ext.spec_version = '1.0'
humanoid = ext.vrm1.humanoid

mapping = {
    'hips': 0, 'spine': 1, 'chest': 2, 'upper_chest': 3, 'neck': 4, 'head': 5,
    'left_shoulder': 6, 'left_upper_arm': 7, 'left_lower_arm': 8, 'left_hand': 9,
    'right_shoulder': 25, 'right_upper_arm': 26, 'right_lower_arm': 27, 'right_hand': 28,
    'left_upper_leg': 44, 'left_lower_leg': 45, 'left_foot': 46, 'left_toes': 47,
    'right_upper_leg': 48, 'right_lower_leg': 49, 'right_foot': 50, 'right_toes': 51,
}
fingers = ['thumb_metacarpal', 'thumb_proximal', 'thumb_distal', 'index_proximal', 'index_intermediate', 'index_distal',
           'middle_proximal', 'middle_intermediate', 'middle_distal', 'ring_proximal', 'ring_intermediate', 'ring_distal',
           'little_proximal', 'little_intermediate', 'little_distal']
for k, name in enumerate(fingers):
    mapping['left_' + name] = 10 + k
    mapping['right_' + name] = 29 + k
for name, index in mapping.items():
    getattr(humanoid.human_bones, name).node.bone_name = f'bone_{index}'

# T ポーズ：アドオンの推定に加えて、上腕と前腕を真横（左腕は +X、右腕は -X）に向ける
bpy.ops.vrm.make_estimated_humanoid_t_pose(armature_object_name=arm.name)
for bone, side in (('bone_7', 1), ('bone_8', 1), ('bone_26', -1), ('bone_27', -1)):
    bpy.context.view_layer.update()
    pb = arm.pose.bones[bone]
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
