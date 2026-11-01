"""3d_office_scene のオフィスを、このデモで使えるように models/office/ へコピーし、椅子の位置を書き出す。

- office.glb と public/assets（Poly Haven / ambientCG。CC0）をコピーする
- 椅子はメッシュが 1 つにまとめられていて位置が分からないので、build_office.py を（書き出しなしで）もう一度走らせ、
  placed_chair の呼び出しを記録する。乱数の種が固定なので、office.glb と同じ配置になる

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

# Blender（Z 上、+Y が北）→ three.js（Y 上、-Z が北）: (x, y) → (x, -y)。
# 椅子はローカル +y（机の方）を向く。three.js での向き yaw（atan2(x, z)）は ang + π
seat = 0.52  # 座面（布）の上面
data = []
for x, y, ang, high in chairs:
    yaw = math.atan2(math.sin(ang + math.pi), math.cos(ang + math.pi))
    data.append({'pos': [round(x, 4), 0, round(-y, 4)], 'yaw': round(yaw, 4), 'seat': seat, 'high': high})
(out / 'chairs.json').write_text(json.dumps(data, indent=1))
print(f'[setup_office] {out} にコピーし、椅子 {len(data)} 脚を書き出しました')
