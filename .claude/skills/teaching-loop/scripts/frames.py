#!/usr/bin/env python3
"""Frame sheets of an edit for judging by eye (no export): the first 30 s every 2 s, each name / File Viewer /
photo / Notepad / quote as it shows, each bridge's middle, the outro. ≤64 frames, 4×4 sheets, index.txt says
which frame is where. usage: frames.py <project id> <out dir>"""
import json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
LOOP_DIR = os.path.expanduser(os.environ.get('LOOP', '~/edit-experiments/loop'))

pid, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
d = json.load(open(os.path.expanduser(f'~/.edit/projects/{pid}.json')))
fps = d['settings']['fps']
clips = d['clips']; end = max(c['start'] + c['duration'] for c in clips)
picks = []  # (frame, why)
for s in range(0, min(30, int(end / fps)), 2):
    picks.append((s * fps + 5, f'opening {s}s'))
pops = [c for c in clips if re.match(r'(File Viewer|Photo inset|Name|Callout|Quote|Red quote|Desktop|Pause|Date|Place)', c.get('name') or '', re.I)]
seen = set()
for c in sorted(pops, key=lambda c: c['start']):
    key = c['start'] // (3 * fps)
    if key in seen: continue
    seen.add(key); picks.append((c['start'] + min(20, c['duration'] - 1), (c.get('name') or '')[:60]))
cards = [c for c in clips if (c.get('name') or '').startswith('Cut-in') and c['type'] in ('video', 'solid')]
mids = {}
for c in cards:
    n = c['name'].split('·')[0].strip(); a, b = mids.get(n, (c['start'], c['start'] + c['duration']))
    mids[n] = (min(a, c['start']), max(b, c['start'] + c['duration']))
for n, (a, b) in mids.items(): picks.append(((a + b) // 2, f'{n} middle'))
picks.append((end - 2 * fps, 'last 2 s'))
picks = sorted({f: w for f, w in picks if 0 <= f < end}.items())
if len(picks) > 64:  # keep the opening, thin the rest evenly
    head = [p for p in picks if p[1].startswith('opening')]; rest = [p for p in picks if not p[1].startswith('opening')]
    step = len(rest) / (64 - len(head)); rest = [rest[int(i * step)] for i in range(64 - len(head))]
    picks = sorted(head + rest)
with open(f'{out}/index.txt', 'w') as f:
    for i, (fr, why) in enumerate(picks):
        f.write(f'sheet {i // 16 + 1:02d} cell {i % 16 + 1:2d}  frame {fr:6d}  {fr / fps / 60:5.2f} min  {why}\n')
subprocess.run([os.path.join(HERE, 'sheet.sh'), pid, out] + [str(fr) for fr, _ in picks], timeout=3600)
print(open(f'{out}/index.txt').read())
