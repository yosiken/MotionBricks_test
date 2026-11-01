"""MotionBricks 公式リポジトリのサンプルモーションから、デモ用の目標姿勢を切り出す。

使い方（このリポジトリのルートで）:
    pip install numpy usd-core
    python tools/build_soma_assets.py --motionbricks ../motionbricks_official

出力: models/soma_assets.json（骨格・T ポーズ・各モードの目標姿勢 4 枚ずつ、飛び越えと椅子の目標列）

BVH は NVIDIA Sample Data Evaluation License（評価・テスト用）なので、
出力ファイルも models/ に置いて Git には含めない。

座標系は SOMA のモデル空間（Y 上、メートル、+Z が正面）で、three.js / VRM と同じ。
姿勢は関節ごとのローカル変換 [x, y, z, qx, qy, qz, qw]、根（Hips）が先頭。
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

FPS = 30.0
POSES = 4
IDLE_TOKENS = (10, 14)


# ---------- 四元数（xyzw） ----------
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def qaxis(axis, angle):
    s = math.sin(angle / 2)
    return np.array([axis[0] * s, axis[1] * s, axis[2] * s, math.cos(angle / 2)])


def qrot(q, v):
    u = q[:3]
    w = q[3]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def qslerp(a, b, t):
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        r = a + (b - a) * t
        return r / np.linalg.norm(r)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def qfrom_matrix(m):
    # m は列ベクトル規約の 3x3 回転行列
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = 0.5 / math.sqrt(tr + 1)
        q = [(m[2, 1] - m[1, 2]) * s, (m[0, 2] - m[2, 0]) * s, (m[1, 0] - m[0, 1]) * s, 0.25 / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2 * math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2])
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = 2 * math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2])
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = 2 * math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1])
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def tmul(a, b):
    """変換 (p, q) の合成 a * b"""
    return (a[0] + qrot(a[1], b[0]), qmul(a[1], b[1]))


# ---------- 骨格（USD のレスト姿勢） ----------
def load_skeleton(usd_path):
    from pxr import Usd, UsdSkel

    stage = Usd.Stage.Open(str(usd_path))
    prim = stage.GetPrimAtPath('/OUTPUT/c_skeleton_grp/Hips')
    skel = UsdSkel.Skeleton(prim)
    paths = [str(j) for j in skel.GetJointsAttr().Get()]
    names = [p.split('/')[-1] for p in paths]
    parents = [paths.index(p.rsplit('/', 1)[0]) if '/' in p else -1 for p in paths]
    unit = stage.GetMetadata('metersPerUnit') or 0.01
    ref = []
    for m in skel.GetRestTransformsAttr().Get():
        a = np.array(m)  # 行ベクトル規約（平行移動は最終行）
        ref.append(np.concatenate([a[3, :3] * unit, qfrom_matrix(a[:3, :3].T)]))
    return names, parents, np.array(ref)


# ---------- BVH ----------
def load_bvh(path, names):
    """BVH をフレームごとのローカル変換 [F, J, 7] にする（J は USD 骨格の関節順、Root は除く）。"""
    lines = Path(path).read_text().splitlines()
    joints, offsets, channels, stack, end_site = [], [], [], [], False
    i = 0
    while not lines[i].strip().startswith('MOTION'):
        t = lines[i].split()
        if t and t[0] in ('ROOT', 'JOINT'):
            joints.append(t[1].rsplit(':', 1)[-1]); offsets.append([0, 0, 0]); channels.append([])
            stack.append(len(joints) - 1)
        elif t[:2] == ['End', 'Site']:
            end_site = True
        elif t and t[0] == 'OFFSET' and not end_site:
            offsets[stack[-1]] = [float(v) for v in t[1:4]]
        elif t and t[0] == 'CHANNELS':
            channels[stack[-1]] = t[2:]
        elif t and t[0] == '}':
            if end_site:
                end_site = False
            else:
                stack.pop()
        i += 1
    frame_time = float(lines[i + 2].split()[-1])
    data = np.loadtxt(lines[i + 3:], dtype=np.float64, ndmin=2)

    poses = np.zeros((len(data), len(names), 7))
    poses[:, :, 6] = 1
    col = 0
    for j, ch in enumerate(channels):
        k = names.index(joints[j]) if joints[j] in names else -1
        pos = np.array(offsets[j]) * 0.01
        cols = {}
        for c in ch:
            cols[c.lower()] = col
            col += 1
        if k < 0:
            if joints[j] != 'Root':
                print('BVH の関節が骨格に無い:', joints[j])
            continue
        for f, row in enumerate(data):
            p = np.array([row[cols[a + 'position']] for a in 'xyz']) * 0.01 if 'xposition' in cols else pos
            q = np.array([0, 0, 0, 1.0])
            for c in ch:
                c = c.lower()
                if c.endswith('rotation'):
                    axis = [0, 0, 0]; axis['xyz'.index(c[0])] = 1
                    q = qmul(q, qaxis(axis, math.radians(row[cols[c]])))
            poses[f, k, :3] = p
            poses[f, k, 3:] = q / np.linalg.norm(q)
    return poses, 1.0 / frame_time


def sample(clip, rate, t):
    f = min(max(t * rate, 0), len(clip) - 1)
    a, b = int(math.floor(f)), min(int(math.floor(f)) + 1, len(clip) - 1)
    w = f - a
    out = clip[a].copy()
    out[:, :3] = clip[a, :, :3] * (1 - w) + clip[b, :, :3] * w
    for j in range(clip.shape[1]):
        out[j, 3:] = qslerp(clip[a, j, 3:], clip[b, j, 3:], w)
    return out


def window(clip, rate, t):
    return np.stack([sample(clip, rate, t + i / FPS) for i in range(POSES)])


def world_positions(pose, parents):
    world = []
    for j, p in enumerate(parents):
        local = (pose[j, :3], pose[j, 3:])
        world.append(local if p < 0 else tmul(world[p], local))
    return np.array([w[0] for w in world])


def heading(pose, parents, names):
    w = world_positions(pose, parents)
    across = w[names.index('RightLeg')] - w[names.index('LeftLeg')]
    across[1] = 0
    fwd = np.cross([0, 1, 0], across / np.linalg.norm(across))
    return math.atan2(fwd[0], fwd[2])


def place(poses, offset, yaw):
    """根だけを動かす：根 = (平行移動 offset, Y 軸まわり yaw) * 根"""
    out = poses.copy()
    q = qaxis([0, 1, 0], yaw)
    for f in range(len(out)):
        out[f, 0, :3] = qrot(q, out[f, 0, :3]) + offset
        out[f, 0, 3:] = qmul(q, out[f, 0, 3:])
    return out


def canonical(poses, parents, names, by_motion):
    """1 枚目の根を原点（地面上）に、向きを +Z にそろえる。"""
    root = poses[0, 0, :3]
    poses = place(poses, -np.array([root[0], 0, root[2]]), 0)
    d = poses[-1, 0, :3] - poses[0, 0, :3]
    if by_motion and math.hypot(d[0], d[2]) > 0.03:
        yaw = math.atan2(d[0], d[2])
    else:
        yaw = heading(poses[0], parents, names)
    return place(poses, np.zeros(3), -yaw)


# ---------- スマートプリミティブ（飛び越え・椅子） ----------
Y_TO_Z = qaxis([1, 0, 0], math.pi / 2)  # SOMA（Y 上）→ 実行時空間（Z 上）


def node_world(doc, node_id):
    chain = []

    def find(n, path):
        if n['id'] == node_id:
            chain.extend(path + [n]); return True
        return any(find(c, path + [n]) for c in n.get('children', []))
    find(doc['root'], [])
    t = (np.zeros(3), np.array([0, 0, 0, 1.0]))
    for n in chain:
        lt = n['local_transform']
        t = tmul(t, (np.array(lt['translation']), np.array(lt['rotation_xyzw'])))
    return t


def target_component(doc, node_id):
    def find(n):
        if n['id'] == node_id:
            return next(c for c in n['components'] if c['type'] == 'target_pose')
        for c in n.get('children', []):
            r = find(c)
            if r:
                return r
    return find(doc['root'])


def load_doc(mb, doc_name):
    return json.loads((mb / 'assets/smart_primitives/soma' / f'{doc_name}.smart_primitive.json').read_text())


def sequence(doc, seq, clips):
    """スマートプリミティブの目標列を、SOMA の空間（Y 上、プリミティブの原点が原点）の姿勢にする。"""
    to_soma = (np.zeros(3), qmul(qaxis([1, 0, 0], -math.pi / 2), np.array([0, 0, 0, 1.0])))
    steps = []
    for node_id in seq['node_ids']:
        comp = target_component(doc, node_id)
        clip, rate = clips(comp['clip'].split('/')[-1])
        t = comp['frame_index'] / rate if comp['playback_mode'] == 'frames' else comp['sample_time_seconds']
        poses = window(clip, rate, t)
        if comp['hips_constrained']:
            # 1 枚目の根の地面方向の位置を原点にする（高さは残す）
            poses = place(poses, -np.array([poses[0, 0, 0], 0, poses[0, 0, 2]]), 0)
        poses = poses[:comp['num_poses_to_use']]
        # ノード（Z 上）→ SOMA（Y 上）：to_soma * ノード * Y_TO_Z * 根
        nw = tmul(to_soma, tmul(node_world(doc, node_id), (np.zeros(3), Y_TO_Z)))
        for f in range(len(poses)):
            p, q = tmul(nw, (poses[f, 0, :3], poses[f, 0, 3:]))
            poses[f, 0, :3], poses[f, 0, 3:] = p, q
        steps.append({'poses': poses, 'early': comp['transition_early_by_frames'],
                      'min': comp['min_tokens'], 'max': comp['max_tokens'], 'name': comp['clip'].split('/')[-1]})
    return steps


def jump_sequence(mb, doc_name, seq_index, clips):
    doc = load_doc(mb, doc_name)
    steps = sequence(doc, doc['sequences'][seq_index], clips)
    # 入口 → 出口の向きが +Z になるよう回す（障害物は原点）
    d = steps[-1]['poses'][0, 0, :3] - steps[0]['poses'][0, 0, :3]
    yaw = -math.atan2(d[0], d[2])
    for s in steps:
        s['poses'] = place(s['poses'], np.zeros(3), yaw)
    box = next(c for c in [n for n in doc['root']['children'] if n['name'] == 'Box'][0]['components'])
    return steps, box['height']


def sit_sequences(mb, names, parents, clips):
    """椅子：座った姿勢の腰が原点の真上で、+Z を向くようにそろえる。"""
    doc = load_doc(mb, 'sit')
    seqs = {s['name']: sequence(doc, s, clips) for s in doc['sequences']}
    seated = seqs['Sit'][-1]['poses'][0]
    yaw = -heading(seated, parents, names)
    offset = -qrot(qaxis([0, 1, 0], yaw), np.array([seated[0, 0], 0, seated[0, 2]]))
    for steps in seqs.values():
        for s in steps:
            s['poses'] = place(s['poses'], offset, yaw)
    box = next(c for n in doc['root']['children'] for c in n['components'] if c['type'] == 'interaction_box')
    return seqs['Sit'], seqs['Stand'], box


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--motionbricks', required=True, type=Path, help='NVlabs/motionbricks を clone したフォルダ')
    ap.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[1] / 'models/soma_assets.json')
    args = ap.parse_args()
    mb = args.motionbricks.resolve()

    names, parents, reference = load_skeleton(mb / 'motionbricks/assets/human/soma_base_skel_minimal_no_root.usd')
    cache = {}

    def clips(file_name):
        if file_name not in cache:
            path = next((mb / 'assets/motions/soma').rglob(file_name))
            cache[file_name] = load_bvh(path, names)
        return cache[file_name]

    def target(file_name, t=None, frame=None, by_motion=False, early=0, tokens=(6, 14)):
        clip, rate = clips(file_name)
        t = frame / rate if frame is not None else t
        poses = canonical(window(clip, rate, t), parents, names, by_motion)
        return {'poses': poses, 'early': early, 'min': tokens[0], 'max': tokens[1]}

    walk_clip = 'neutral_walk_ff_180_R_002__A536_M.bvh'
    targets = {
        # locomotion_bs1_linear / locomotion_bs2_directional_crouch のスマートプリミティブと同じ時刻
        # 待機は目標がその場なので、短い長さを許すと 0.6 秒ごとに作り直すことになる。長め（約 1.1〜1.7 秒）に限る
        'idle': [target(walk_clip, t=0.62, tokens=IDLE_TOKENS)]
        + [target('idle_loop_001__A268.bvh', t=t, tokens=IDLE_TOKENS) for t in (1.0, 2.5, 4.0, 5.5, 7.0)]
        + [target('neutral_looking_around_R_001__A542.bvh', t=t, tokens=IDLE_TOKENS) for t in (1.0, 3.0, 5.0)],
        'walk': [target(walk_clip, frame=306, by_motion=True, early=10)],
        'jog': [target('neutral_jog_ff_180_R_001__A534.bvh', frame=229, by_motion=True, early=10)],
        'run': [target('run_loop_180_R_003__A326.bvh', frame=49, by_motion=True, early=10)],
        'crouchIdle': [target('crouch_idle_001__A529.bvh', frame=0, tokens=IDLE_TOKENS)],
        'crouchWalk': [target('crouch_ff_loop_180_R_001__A196.bvh', frame=186, by_motion=True, early=10)],
    }
    # locomotion_style_variations_bs1_linear と同じ時刻。歩きと同じく 1 秒先に置き、少し手前で次へ移る
    styles = {
        'Skipping': target('skipping_R_002__A360.bvh', frame=383, by_motion=True, early=10),
        'Vogue': target('dance_vouge_vogue_sequence_180_R_002__A316.bvh', t=3.13, by_motion=True, early=10),
        'Injured Torso': target('injured_torso_grab_walk_ff_180_001__A549.bvh', frame=293, by_motion=True, early=10),
        'Injured Leg': target('injured_L_leg_grab_walk_ff_180_002__A549.bvh', t=5.55, by_motion=True, early=10),
        'Zombie': target('zombie_walk_180_R_003__A330.bvh', t=6.04, by_motion=True, early=10),
        'Combat': target('combat_quickstep_ff_idle_180_R_002__A365.bvh', t=3.66, by_motion=True, early=10),
    }
    jumps = []
    for doc_name, seq in (('jump_0_5m', 0), ('jump_0_5m', 1), ('jump_0_75m', 1), ('jump_0_75m', 2)):
        steps, height = jump_sequence(mb, doc_name, seq, clips)
        jumps.append({'height': height, 'steps': steps})
    sit, stand, seat = sit_sequences(mb, names, parents, clips)
    # 座ったままは、座った姿勢を目標にし続ける（公式は座りのループを再生する）。長めにして作り直しを減らす
    seated = dict(sit[-1], min=IDLE_TOKENS[0], max=IDLE_TOKENS[1])

    r = lambda a: np.round(np.asarray(a, dtype=np.float64), 5).tolist()
    pack = lambda t: {'poses': r(t['poses']), 'early': t['early'], 'tokens': [t['min'], t['max']]}
    out = {
        'note': 'Generated from NVIDIA MotionBricks sample motions (NVIDIA Sample Data Evaluation License). Do not redistribute.',
        'names': names, 'parents': parents, 'reference': r(reference),
        'targets': {k: [pack(t) for t in v] for k, v in targets.items()},
        'jumps': [{'height': j['height'], 'steps': [pack(s) for s in j['steps']]} for j in jumps],
        'styles': {k: pack(t) for k, t in styles.items()},
        'sit': {'sit': [pack(s) for s in sit], 'seated': pack(seated), 'stand': [pack(s) for s in stand],
                'seat': {k: seat[k] for k in ('width', 'depth', 'height')}},
    }
    args.out.parent.mkdir(exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(',', ':')))
    print(f'{args.out} に書き出しました（{args.out.stat().st_size / 1e6:.1f} MB）')

    # 確認用：T ポーズと飛び越えの配置
    w = world_positions(reference, parents)
    for n in ('Hips', 'LeftArm', 'LeftHand', 'RightHand', 'LeftFoot', 'Head'):
        print(f'  レスト {n:10s}', np.round(w[names.index(n)], 3))
    print('  レストの向き（度）', round(math.degrees(heading(reference, parents, names)), 1))
    for j in jumps:
        print(f"  飛び越え 高さ {j['height']:.2f}m:", [np.round(s['poses'][0, 0, :3], 2).tolist() for s in j['steps']])
    for k, t in styles.items():
        d = t['poses'][-1, 0, :3] - t['poses'][0, 0, :3]
        print(f'  スタイル {k:13s} 速さ {math.hypot(d[0], d[2]) * FPS / (POSES - 1):.2f} m/s')
    for k, steps in (('座る', sit), ('立つ', stand)):
        for s in steps:
            w = world_positions(s['poses'][0], parents)
            print(f"  {k} {s['name'][:28]:28s} 腰", np.round(w[0], 2), '向き', round(math.degrees(heading(s['poses'][0], parents, names))),
                  '左足', np.round(w[names.index('LeftFoot')], 2), '枚数', len(s['poses']))
    print('  座面（interaction box）', seat['width'], seat['depth'], seat['height'])


if __name__ == '__main__':
    main()
