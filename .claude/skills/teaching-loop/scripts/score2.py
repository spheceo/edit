#!/usr/bin/env python3
"""Measures a from-scratch edit against the answer keys' patterns (loop 2).
usage: score2.py <project id> [out.json]   → prints a short report; writes the numbers as JSON
"""
import json, os, re, subprocess, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
LOOP_DIR = os.path.expanduser(os.environ.get('LOOP', '~/edit-experiments/loop'))

MCP = os.path.join(HERE, 'mcp.sh')

def mcp(tool, args):
    out = subprocess.run([MCP, tool, json.dumps(args)], capture_output=True, text=True, timeout=900).stdout
    r = json.loads(out)
    return json.loads(r['result']['content'][0]['text'])

pid = sys.argv[1]
d = json.load(open(os.path.expanduser(f'~/.edit/projects/{pid}.json')))
fps = d['settings']['fps']; W, H = d['settings']['width'], d['settings']['height']
ctx = mcp('get_edit_context', {'project_id': pid})
audit = ctx['audit']; kinds = collections.Counter()
for i in audit['issues']: kinds[i['kind']] += i.get('more', i.get('lines', 1)) if ('more' in i or 'lines' in i) else 1
med = {m['id']: m for m in d['media']}
hidden = {t['id'] for t in d['tracks'] if t.get('hidden')}
clips = [c for c in d['clips'] if c['track'] not in hidden]
end = lambda c: c['start'] + c['duration']
parts = ctx['sections']['parts']
intro = [(p['start'], p['end']) for p in parts if p['kind'] == 'intro']
broll = [(p['start'], p['end']) for p in parts if p['kind'] == 'broll']
dur = ctx['duration_frames']
def within(spans, f): return any(s <= f < e for s, e in spans)
def path(c): return med.get(c.get('media'), {}).get('path', '')
R = {'project': pid, 'name': d['name'], 'minutes': round(dur / fps / 60, 1), 'clips': len(clips), 'audit': dict(kinds)}

# Narration words on the timeline: (seconds, word) from every cut-in.
words = []
cut_ins = list(ctx.get('cut_ins', []))
if any(ci.get('words') is None for ci in cut_ins):
    # A big project's whole context leaves the word times out: read them span by span.
    cut_ins = []
    seen_ci = set()
    for a in range(0, int(dur / fps) + 1, 300):
        part = mcp('get_edit_context', {'project_id': pid, 'start': a, 'end': a + 300})
        for ci in part.get('cut_ins', []):
            if ci.get('cut_in') not in seen_ci and ci.get('words'):
                seen_ci.add(ci.get('cut_in')); cut_ins.append(ci)
for ci in cut_ins:
    for tok in (ci.get('words') or '').split():
        m = re.match(r'(.+)@([\d.]+)$', tok)
        if m: words.append((float(m.group(2)), re.sub(r'[^a-z0-9]', '', m.group(1).lower())))
words.sort()
STOP = set('the a an of to and in on at for is was her his he she they it that this with by as from be had has have were did not no'.split())

def said_at(text, near):
    """When the narration says the text's first content words, nearest to `near` (seconds)."""
    toks = [re.sub(r'[^a-z0-9]', '', t.lower()) for t in re.split(r'\s+', text)]
    toks = [t for t in toks if t and t not in STOP and not re.fullmatch(r'\d+', t)][:3]
    if not toks: return None
    best = None
    for i, (t, w) in enumerate(words):
        if w != toks[0] or abs(t - near) > 20: continue
        ok = all(any(words[j][1] == x for j in range(i, min(i + 8, len(words)))) for x in toks[1:2])
        if ok and (best is None or abs(t - near) < abs(best - near)): best = t
    return best

# I1 text timing: on-screen words in narration (not subtitles, captions, countdowns).
SKIP = ('Subtitle', 'Caption', 'Countdown', 'Film look · tag')
leads = []; short = 0; texts = 0
for c in clips:
    if c['type'] != 'text': continue
    n = c.get('name') or ''
    if n.startswith(SKIP) or not within(broll + intro, c['start']): continue
    texts += 1
    if c['duration'] < 0.5 * fps: short += 1
    t = said_at(c.get('text', ''), c['start'] / fps)
    if t is not None: leads.append(round(t - c['start'] / fps, 2))
for mk in ctx.get('markers', []):  # desktop lines typed on as said
    m = re.match(r'desktop line@(\d+) \((.*)\)', mk)
    if m:
        t = said_at(m.group(2), int(m.group(1)) / fps)
        if t is not None: leads.append(round(t - int(m.group(1)) / fps, 2))
late = [x for x in leads if x < -0.15]; early = [x for x in leads if x >= 0.3]
R['I1_text'] = {'texts': texts, 'matched': len(leads), 'early>=0.3s': len(early), 'late>0.15s': len(late),
                'median_lead_s': sorted(leads)[len(leads) // 2] if leads else None, 'under_0.5s': short}

# I2 music: beds, their lengths, level issues.
music = [c for c in clips if c['type'] == 'audio' and '/library/music/' in path(c)]
lens = sorted(round(c['duration'] / fps, 1) for c in music)
R['I2_music'] = {'beds': len(music), 'median_len_s': lens[len(lens) // 2] if lens else None, 'max_len_s': lens[-1] if lens else None,
                 'music_loud': kinds['music_loud'], 'music_mood': kinds['music_mood'], 'mid_narration_changes': kinds['music_change_mid_narration']}

# I3 centre text: big words in the middle (text slams, closing lines, date titles in the middle).
def centred(c):
    tr = c.get('transform') or {}; st = c.get('style') or {}
    return abs(tr.get('x', 0)) < 0.15 * W and abs(tr.get('y', 0)) < 0.2 * H and st.get('size', 0) >= 54
centre = [c for c in clips if c['type'] == 'text' and not (c.get('name') or '').startswith(SKIP) and centred(c)]
notepads = sum(1 for m in ctx.get('markers', []) if m.startswith('desktop line'))
R['I3_centre_text'] = {'centre_texts': len(centre), 'centre_seconds': round(sum(c['duration'] for c in centre) / fps, 1), 'notepad_lines': notepads}

# I5 bars/borders.
R['I5_frame'] = {'letterboxed': kinds['letterboxed'], 'watermarked': kinds['watermarked_picture'] + kinds['watermarked_footage'], 'burned_subtitles': kinds['burned_subtitles']}

# I6 zooms: share of footage clips with a scale keyframe move; zoom-outs.
foot = [c for c in clips if c['type'] == 'video' and med.get(c.get('media'), {}).get('kind') == 'video']
def scales(c): return [k['value'] for k in (c.get('keyframes') or {}).get('scale', [])]
moving = [c for c in foot if len(set(round(v, 3) for v in scales(c))) > 1]
zoom_out = [c for c in moving if scales(c)[-1] < scales(c)[0] - 0.02]
R['I6_zoom'] = {'footage_clips': len(foot), 'zooming': len(moving), 'zoom_outs': len(zoom_out),
                'intro_zooming_share': round(sum(1 for c in moving if within(intro, c['start'])) / max(1, sum(1 for c in foot if within(intro, c['start']))), 2)}

# I7 looks: red flashes, vignette coverage of the intro, adjustments fading in.
flashes = [c for c in clips if re.search(r'red flash', c.get('name') or '', re.I)]
vig = [c for c in clips if c['type'] == 'adjustment' and ((c.get('grade') or {}).get('vignette', 0) > 0 or 'vignette' in (c.get('keyframes') or {}))]
cov = 0; total = 0
for s, e in intro:
    total += e - s
    cov += sum(1 for f in range(s, e, 3) if any(v['start'] <= f < end(v) for v in vig)) * 3
fade_in_vig = [c for c in vig if within(intro, c['start']) and (c.get('fade_in', 0) > 3 or (c.get('keyframes') or {}).get('vignette'))]
R['I7_looks'] = {'red_flashes': len(flashes), 'intro_vignette_share': round(cov / max(1, total), 2), 'intro_vignettes_animated': len(fade_in_vig), 'vignette_snaps': kinds['vignette_snaps']}

# I8 pictures of people: distinct photo media in File Viewers / insets.
viewers = [c for c in clips if c['type'] == 'video' and med.get(c.get('media'), {}).get('kind') == 'image']
R['I8_pictures'] = {'image_clips': len(viewers), 'distinct_images': len({c['media'] for c in viewers})}

# I9 clicks on pop-ups: a sound starting within 6 frames of each File Viewer / photo / callout.
pops = [c for c in clips if re.match(r'(File Viewer|Photo inset|Name callout|Callout|Quote|Red quote)', c.get('name') or '', re.I)]
sfx = [c for c in clips if c['type'] == 'audio' and ('/library/sfx/' in path(c) or '/.edit/sfx/' in path(c))]
clicked = sum(1 for p in pops if any(-20 <= s['start'] - p['start'] <= 8 for s in sfx))
R['I9_sound'] = {'pop_ups': len(pops), 'with_sound': clicked, 'sfx': len(sfx), 'tape_start_unmarked': kinds['tape_start_unmarked'], 'hook_unmarked': kinds['hook_unmarked']}

# I10 cuts.
R['I10_cuts'] = {'cut_mid_word': kinds['cut_mid_word'], 'off_script': kinds['off_script'], 'dead_air': kinds['dead_air'], 'long_broll_shot': kinds['long_broll_shot'], 'bridge_unillustrated': kinds['bridge_unillustrated']}

# I11 subtitles' speakers.
R['I11_speakers'] = ctx.get('speaker_line_counts')

out = sys.argv[2] if len(sys.argv) > 2 else None
if out: json.dump(R, open(out, 'w'), indent=1)
for k, v in R.items():
    if k in ('audit',): continue
    print(f'{k}: {v}')
print('audit:', dict(sorted(kinds.items(), key=lambda kv: -kv[1])))
