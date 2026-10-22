#!/usr/bin/env python3
"""One trial: a fresh copy of a video's base project, a full edit ("Start the editing workflow."),
waited out with hard limits, saved under $LOOP/rounds/<round>/<video>/ (LOOP defaults to ~/edit-experiments/loop).

usage: round.py <video key> <round label>      (video keys in BASES below)
Never hangs: every request has a timeout; the turn has a 150-minute cap; a usage limit is waited out
(up to ~6 hours) and the turn resumed; a stall (nothing new for 25 min) is stopped and resumed once.
"""
import json, os, sys, time, shutil, glob, urllib.request, re
HERE = os.path.dirname(os.path.abspath(__file__))
LOOP_DIR = os.path.expanduser(os.environ.get('LOOP', '~/edit-experiments/loop'))

HOME = os.path.expanduser('~/.edit')
LOOP = LOOP_DIR
BASES = json.load(open(f'{LOOP}/base/bases.json'))  # {key: {"id":…, "name":…}}
API = 'http://127.0.0.1:7700'
MSG = 'Start the editing workflow.'
RESUME = 'Carry on with the editing workflow from where you stopped: get_edit_context shows what is already done; then finish it.'

def req(method, path, body=None, timeout=60):
    for attempt in range(5):
        try:
            r = urllib.request.Request(API + path, method=method,
                                       data=None if body is None else json.dumps(body).encode(),
                                       headers={'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(r, timeout=timeout))
        except Exception as e:
            last = e; time.sleep(10)
    raise last

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def copy(key, label):
    base = BASES[key]; src = f'{HOME}/projects/{base["id"]}.json'
    d = json.load(open(src)); old = d['id']
    made = req('POST', '/api/projects', {'name': f'{label}: {base["name"]}', 'style': d.get('style', 'bodycam'), **d['settings']}, timeout=120)
    new = made['project']['id']; rev = made['rev']
    d['id'] = new; d['name'] = f'{label}: {base["name"]}'
    req('PUT', f'/api/projects/{new}', {'base_rev': rev, 'project': d, 'origin': 'copy'}, timeout=300)
    if os.path.isdir(f'{HOME}/research/{old}'):
        shutil.copytree(f'{HOME}/research/{old}', f'{HOME}/research/{new}', dirs_exist_ok=True)
    for f in glob.glob(f'{HOME}/cache/watch-projects/*{old}*'):
        shutil.copy(f, f.replace(old, new))
    return new

def chat(p):
    return req('GET', f'/api/projects/{p}/agent', timeout=30)

def send(p, text):
    return req('POST', f'/api/projects/{p}/agent', {'text': text, 'model': 'opus', 'effort': 'medium'}, timeout=60)

def wait_turn(p, cap_s):
    t0 = time.time(); last_n = -1; last_change = time.time()
    while True:
        time.sleep(30)
        try: c = chat(p)
        except Exception as e: log('poll failed', e); continue
        n = len(c['entries'])
        if n != last_n: last_n = n; last_change = time.time()
        if not c['running']:
            # Edit may follow a finished edit up by itself a second later.
            time.sleep(20)
            try: c2 = chat(p)
            except Exception: c2 = c
            if c2['running']: continue
            return 'done', c2
        if time.time() - t0 > cap_s: return 'cap', c
        if time.time() - last_change > 25 * 60: return 'stall', c

def turn_errors(c):
    e = c['entries']; i = max(i for i, x in enumerate(e) if x['kind'] == 'user')
    return [x['text'] for x in e[i + 1:] if x['kind'] == 'error']

def main():
    key, label = sys.argv[1], sys.argv[2]
    out = f'{LOOP}/rounds/{label}/{key}'; os.makedirs(out, exist_ok=True)
    p = copy(key, label); log('project', p)
    meta = {'project': p, 'video': key, 'round': label, 'started': time.time(), 'resumes': []}
    json.dump(meta, open(f'{out}/meta.json', 'w'), indent=1)
    send(p, MSG)
    deadline = time.time() + 9 * 3600; resumed_stall = False; agent_s = 0.0
    while True:
        t = time.time()
        state, c = wait_turn(p, 150 * 60)
        agent_s += time.time() - t
        errs = turn_errors(c)
        log('turn', state, 'errors:', [x[:120] for x in errs])
        if state in ('cap', 'stall'):
            req('POST', f'/api/projects/{p}/agent/stop', {}, timeout=60)
            if state == 'stall' and not resumed_stall:
                resumed_stall = True; meta['resumes'].append('stall'); time.sleep(20); send(p, RESUME); continue
            meta['ended'] = state; break
        limited = [x for x in errs if re.search(r'limit|usage|quota|rate|overloaded|529|exceed', x, re.I)]
        if limited and time.time() < deadline:
            meta['resumes'].append('limit: ' + limited[0][:200]); log('usage limit; waiting 20 min')
            time.sleep(20 * 60); send(p, RESUME); continue
        meta['ended'] = 'error: ' + errs[0][:300] if errs and not limited else ('limit-deadline' if limited else 'done')
        break
    meta['finished'] = time.time(); meta['agent_minutes'] = round(agent_s / 60, 1)
    c = chat(p); meta['entries'] = len(c['entries']); meta['tool_calls'] = sum(1 for x in c['entries'] if x['kind'] == 'tool')
    asst = [x for x in c['entries'] if x['kind'] == 'assistant']; meta['summary'] = asst[-1]['text'] if asst else ''
    json.dump(meta, open(f'{out}/meta.json', 'w'), indent=1)
    shutil.copy(f'{HOME}/projects/{p}.json', f'{out}/project.json')
    json.dump(c, open(f'{out}/chat.json', 'w'))
    log('saved', out, meta['ended'], meta['agent_minutes'], 'min', meta['tool_calls'], 'tools')

if __name__ == '__main__':
    main()
