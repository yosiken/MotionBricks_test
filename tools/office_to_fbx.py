"""デモのオフィス（models/office/）を、デモの見た目に近い形で 1 つの FBX に書き出す。

src/office.js が実行時にしていることを Blender で再現してから書き出す:
- 当たり判定の箱（COL_*）と照明の目印（LIGHT_*）を消す。窓の外（Outside*）も、デモと同じく消す
- chairs.json に椅子のモデルがあれば、office.glb の椅子（Chairs）を消し、そのモデルを全部の椅子の位置に置く
- 小物の目印（PROP_<key>__<n>）を Poly Haven のモデルに置き換える（SPECS は office.js と同じ）

実行時に作っているもの（照明、空の HDRI、ambientCG の法線・粗さ、Canvas で描くカーペット・壁・天井・画面の模様、
ガラスの透明度）は FBX に入らない。テクスチャは office.glb と Poly Haven に入っている画像だけ。

使い方（Blender 4.2 以降）:
    blender -b --python tools/office_to_fbx.py -- models/office/office.fbx
    blender -b --python tools/office_to_fbx.py -- models/office/office.fbx --no-props --keep-outside

オプション:
    --no-chairs     椅子を置き換えない（office.glb の椅子のまま）
    --no-props      小物を置かない
    --keep-outside  窓の外の景色を残す
    --unity         Unity 向けの軸・単位で書き出す（既定は Blender の標準：-Z 前・Y 上・1 単位 = 1m）
"""

import json
import re
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
flags = {a for a in args if a.startswith('--')}
positional = [a for a in args if not a.startswith('--')]
BASE = Path(__file__).resolve().parents[1] / 'models/office'
out = Path(positional[0]) if positional else BASE / 'office.fbx'

# office.js の SPECS と同じ。pick は glTF の一番上のノード名で選ぶ
SPECS = {
    'pachira_a': {'file': 'pachira_aquatica_01', 'pick': r'_a$'},
    'pachira_b': {'file': 'pachira_aquatica_01', 'pick': r'_b$'},
    'pachira_c': {'file': 'pachira_aquatica_01', 'pick': r'_c$'},
    'pachira_d': {'file': 'pachira_aquatica_01', 'pick': r'_d$'},
    'plant1': {'file': 'potted_plant_01'},
    'plant2': {'file': 'potted_plant_02'},
    'stationery': {'file': 'stationery_supplies'},
    'note_a4': {'file': 'office_notepads', 'pick': r'a4_stack$'},
    'note_sticky': {'file': 'office_notepads', 'pick': r'sticky_stack$'},
    'note_yellow': {'file': 'office_notepads', 'pick': r'yellow_pad$'},
    'clock': {'file': 'wall_clock', 'ground': False, 'center': False},
    'shelves': {'file': 'steel_frame_shelves_01', 'scale': 0.1},
    'box': {'file': 'cardboard_box_01'},
    'barchair': {'file': 'bar_chair_round_01'},
    'sofa': {'file': 'sofa_02'},
}


def import_gltf(path):
    """glTF を読み込み、新しく増えたオブジェクトのうち一番上のもの（親なし）を返す。"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    return [o for o in new if o.parent is None or o.parent not in new]


def delete_tree(obj):
    for o in [obj, *obj.children_recursive]:
        bpy.data.objects.remove(o, do_unlink=True)


def copy_tree(obj, parent):
    """obj を子孫ごと複製して parent の下に置く（メッシュのデータは共有。FBX ではインスタンスになる）。"""
    dup = obj.copy()
    bpy.context.scene.collection.objects.link(dup)
    dup.parent = parent
    for child in obj.children:
        copy_tree(child, dup)
    return dup


def new_empty(name, matrix, parent=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.parent = parent
    e.matrix_local = matrix  # parent の下で、matrix_parent_inverse は単位行列のまま
    return e


def world_bounds(objs):
    pts = [o.matrix_world @ Vector(c) for root in objs for o in [root, *root.children_recursive]
           if o.type == 'MESH' for c in o.bound_box]
    return Vector(map(min, *pts)), Vector(map(max, *pts))


def three_to_blender(pos, yaw):
    """three.js（Y 上）の位置と Y 軸まわりの向き → Blender（Z 上）。(x, y, z) → (x, -z, y)、Y 軸まわり → Z 軸まわり"""
    return Matrix.Translation((pos[0], -pos[2], pos[1])) @ Matrix.Rotation(yaw, 4, 'Z')


# ---- 空のシーンから office.glb を読み込む
bpy.ops.wm.read_factory_settings(use_empty=True)
import_gltf(BASE / 'office.glb')
chair_data = json.loads((BASE / 'chairs.json').read_text(encoding='utf-8')) if (BASE / 'chairs.json').exists() else None
chair_model = chair_data and chair_data.get('model') and BASE / chair_data['model']
replace_chairs = '--no-chairs' not in flags and chair_model and chair_model.exists()

markers = []
for o in list(bpy.data.objects):
    if o.name not in bpy.data.objects:  # 先に親ごと消えた
        continue
    if o.name.startswith('COL_') or o.name.startswith('LIGHT_'):
        delete_tree(o)
    elif o.name.startswith('Outside') and '--keep-outside' not in flags:
        delete_tree(o)
    elif o.name == 'Chairs' and replace_chairs:
        delete_tree(o)
    elif o.name.startswith('PROP_'):
        markers.append(o)

# ---- 椅子のモデルを全部の椅子の位置に置く（office.js の placeChairs）
if replace_chairs:
    chair_roots = import_gltf(chair_model)
    group = new_empty('Chairs', Matrix())
    for i, c in enumerate(chair_data['chairs']):
        holder = new_empty(f'Chair_{i:03d}', three_to_blender(c['pos'], c['yaw']), group)
        for r in chair_roots:
            dup = copy_tree(r, holder)
            dup.matrix_local = r.matrix_world.copy()
    for r in chair_roots:
        delete_tree(r)
    print(f'[office_to_fbx] 椅子 {len(chair_data["chairs"])} 脚を {chair_model.name} に置き換えました')

# ---- 小物（office.js の placeProps / makeTemplate）
if '--no-props' not in flags:
    files, templates, missing = {}, {}, set()
    group = new_empty('Props', Matrix())
    for m in markers:
        key = (re.match(r'^PROP_(.+)__\d+$', m.name) or [None, None])[1]
        spec = SPECS.get(key)
        if not spec:
            continue
        if spec['file'] not in files:
            path = BASE / 'assets/polyhaven' / spec['file'] / f"{spec['file']}_1k.gltf"
            files[spec['file']] = import_gltf(path) if path.exists() else None
        roots = files[spec['file']]
        if roots is None:
            missing.add(spec['file'])
            continue
        if key not in templates:
            picked = [r for r in roots if not spec.get('pick') or re.search(spec['pick'], r.name)]
            # 縮尺をかけ、底面を床に・水平方向の中心を原点に合わせる変換（three.js の inner）
            s = spec.get('scale', 1.0)
            lo, hi = world_bounds(picked)
            lo, hi = lo * s, hi * s
            offset = Vector((0, 0, 0))
            if spec.get('center', True):
                offset.x, offset.y = -(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2
            if spec.get('ground', True):
                offset.z = -lo.z
            templates[key] = (picked, Matrix.Translation(offset) @ Matrix.Scale(s, 4))
        picked, inner = templates[key]
        holder = new_empty(m.name.removeprefix('PROP_'), m.matrix_world.copy(), group)
        for r in picked:
            dup = copy_tree(r, holder)
            dup.matrix_local = inner @ r.matrix_world
    for roots in files.values():
        for r in roots or []:
            delete_tree(r)
    if missing:
        print(f'[office_to_fbx] 見つからず置けなかった小物: {", ".join(sorted(missing))}')
for m in markers:
    if m.name in bpy.data.objects:
        delete_tree(m)

# ---- glb に埋め込まれた画像を FBX に埋め込めるよう、いったんファイルに書き出す
out = out.resolve()
tex_dir = out.parent / f'{out.stem}_textures'
for img in bpy.data.images:
    if img.packed_file:
        ext = {'JPEG': '.jpg', 'PNG': '.png'}.get(img.file_format, '.png')
        tex_dir.mkdir(parents=True, exist_ok=True)
        path = tex_dir / (re.sub(r'[^\w.-]', '_', img.name) + ext)
        path.write_bytes(img.packed_file.data)
        img.filepath = str(path)
        img.unpack(method='REMOVE')

out.parent.mkdir(parents=True, exist_ok=True)
axes = {'axis_forward': '-Z', 'axis_up': 'Y'}
if '--unity' in flags:
    # Unity の FBX 読み込みで回転 (-90, 0, 0) や 100 倍が付かないようにする
    axes = {'axis_forward': '-Z', 'axis_up': 'Y', 'apply_scale_options': 'FBX_SCALE_ALL', 'bake_space_transform': True}
bpy.ops.export_scene.fbx(
    filepath=str(out), object_types={'EMPTY', 'MESH'}, use_mesh_modifiers=True,
    path_mode='COPY', embed_textures=True, **axes,
)
meshes = sum(1 for o in bpy.data.objects if o.type == 'MESH')
print(f'[office_to_fbx] {out} に書き出しました（メッシュ {meshes} 個、画像 {len(bpy.data.images)} 枚）')
