#!/usr/bin/env python3
"""The loop's measures, round by round, per video (from rounds/R*/<video>/score.json and meta.json)."""
import json, os, glob, re
HERE = os.path.dirname(os.path.abspath(__file__))
LOOP_DIR = os.path.expanduser(os.environ.get('LOOP', '~/edit-experiments/loop'))

L = os.path.join(LOOP_DIR, 'rounds')
rows = []
for path in sorted(glob.glob(f'{L}/R*/*/score.json'), key=lambda p: (p.split('/')[-2], int(re.search(r'/R(\d+)/', p).group(1)))):
    rnd, video = path.split('/')[-3], path.split('/')[-2]
    if '-' in video: continue
    s = json.load(open(path)); m = json.load(open(os.path.join(os.path.dirname(path), 'meta.json')))
    a = s['audit']
    rows.append([video, rnd, m.get('agent_minutes'), m.get('tool_calls'),
                 f"{s['I1_text']['early>=0.3s']}/{s['I1_text']['matched']} ({s['I1_text']['late>0.15s']} late)",
                 s['I3_centre_text']['centre_texts'], f"{s['I6_zoom']['intro_zooming_share']:.2f}",
                 f"{s['I9_sound']['with_sound']}/{s['I9_sound']['pop_ups']}",
                 a.get('bridge_unillustrated', 0), a.get('long_broll_shot', 0), a.get('text_late', 0),
                 a.get('teaser_wide', 0), a.get('dead_air', 0), a.get('music_bed_long', 0), a.get('cut_mid_word', 0),
                 a.get('watermarked_picture', 0)])
head = ['video', 'round', 'min', 'tools', 'text early', 'centre', 'teaser zoom', 'clicks', 'unillus.', 'long shot', 'text_late', 'teaser_wide', 'dead_air', 'bed_long', 'cut_mid', 'marked pic']
w = [max(len(str(r[i])) for r in rows + [head]) for i in range(len(head))]
print('  '.join(h.ljust(w[i]) for i, h in enumerate(head)))
for r in rows: print('  '.join(str(v).ljust(w[i]) for i, v in enumerate(r)))
