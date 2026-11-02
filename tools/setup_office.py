"""3d_office_scene のオフィスを、このデモで使えるように models/office/ へコピーし、椅子の位置を書き出す。

- office.glb と public/assets（Poly Haven / ambientCG。CC0）をコピーする
- 椅子はメッシュが 1 つにまとめられていて位置が分からないので、build_office.py を（書き出しなしで）もう一度走らせ、
  placed_chair の呼び出しを記録する。乱数の種が固定なので、office.glb と同じ配置になる
- 椅子のモデル（blender/Office Chair.fbx）があれば、高さ 1m に縮めて正面を +Z（three.js）に向けた office_chair.glb にする。
  デモでは office.glb の椅子（Chairs）を隠し、このモデルを同じ位置に置く

使い方:
    blender -b --python tools/setup_office.py -- D:/project/3d_office_scene
"""

import json
import math
import shutil
import sys
from pathlib import Path

src = Path(sys.argv[sys.argv.index('--') + 1])
out = Path(__file__).resolve().parents[1] / 'models/office'
out.mkdir(parents=True, exist_ok=True)
shutil.copy2(src / 'public/models/office.glb', out / 'office.glb')
shutil.copytree(src / 'public/assets', out / 'assets', dirs_exist_ok=True)

script = src / 'blender/build_office.py'
code = script.read_text(encoding='utf-8').rsplit('\nmain()', 1)[0]
ns = {'__file__': str(script), '__name__': 'office_layout'}
exec(compile(code, str(script), 'exec'), ns)

chairs = []
place = ns['placed_chair']


def record(mb, f, **kw):
    chairs.append((f.ox, f.oy, f.ang, kw.get('high', False)))
    place(mb, f, **kw)


ns['placed_chair'] = record
# main() と同じ順に組み立てる（乱数の消費順をそろえる）
ns['init_materials']()
builders = {name: ns['MB']() for name in (
    'Structure', 'Ceiling', 'Desks', 'DeskItems', 'Chairs', 'Misc', 'Meeting', 'Refresh', 'Storage', 'Outside')}
ns['build_structure'](builders['Structure'])
ns['build_ceiling_fixtures'](builders['Ceiling'])
ns['build_open_office'](builders['Desks'], builders['DeskItems'], builders['Chairs'], builders['Misc'])
ns['build_meeting_rooms'](builders['Meeting'], builders['Chairs'])

# 座面の上面の高さと、座面の中心が椅子の中心（脚の中心）よりどれだけ前か
seat, forward, model = 0.52, 0.0, None  # office.glb の椅子（布の上面）
fbx = src / 'blender/Office Chair.fbx'
if fbx.exists():
    import bpy
    from mathutils import Vector
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.fbx(filepath=str(fbx))
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    lo, hi = Vector(map(min, *pts)), Vector(map(max, *pts))
    k = 1.0 / (hi.z - lo.z)  # 背もたれの上端まで 1m
    # このモデルは座面が「Chair」、背もたれが -Y 側にあり、正面は +Y
    cushion_obj = bpy.data.objects['Chair']
    cushion = [cushion_obj.matrix_world @ v.co for v in cushion_obj.data.vertices]
    seat = round((max(p.z for p in cushion) - lo.z) * k, 3)
    forward = round(((min(p.y for p in cushion) + max(p.y for p in cushion)) / 2 - (lo.y + hi.y) / 2) * k, 3)
    # 脚の中心を原点・床を高さ 0 にし、正面（+Y）を -Y へ回す（glTF では -Y → +Z になる）
    root = bpy.data.objects.new('office_chair', None)
    bpy.context.scene.collection.objects.link(root)
    for o in bpy.data.objects:
        if o is not root and o.parent is None:
            o.parent = root
            o.matrix_parent_inverse.identity()
            o.location -= Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    root.scale = (k, k, k)
    root.rotation_euler = (0, 0, math.pi)
    bpy.ops.export_scene.gltf(filepath=str(out / 'office_chair.glb'), export_format='GLB', export_yup=True, export_apply=True)
    model = 'office_chair.glb'

# Blender（Z 上、+Y が北）→ three.js（Y 上、-Z が北）: (x, y) → (x, -y)。
# 椅子はローカル +y（机の方）を向く。three.js での向き yaw（atan2(x, z)）は ang + π
chairs_out = []
for x, y, ang, high in chairs:
    yaw = math.atan2(math.sin(ang + math.pi), math.cos(ang + math.pi))
    chairs_out.append({'pos': [round(x, 4), 0, round(-y, 4)], 'yaw': round(yaw, 4), 'high': high})
data = {'model': model, 'seat': seat, 'seatForward': forward, 'chairs': chairs_out}
(out / 'chairs.json').write_text(json.dumps(data, indent=1))
print(f'[setup_office] {out} にコピーし、椅子 {len(chairs_out)} 脚を書き出しました（モデル {model}、座面 {seat}m、座面の中心は {forward}m 前）')
