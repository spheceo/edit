import pickle, sys, time, collections, json, csv, datetime

D = sys.argv[1]
S = pickle.load(open(f'{D}/state.pkl', 'rb'))
rows, projects, later = S['rows'], S['projects'], S['later']
NOW = time.time() * 1000
DAY = 86400000
GB = 1e9
fmt = lambda b: f'{b/GB:8.1f}'
iso = lambda ms: time.strftime('%Y-%m-%d', time.gmtime(ms / 1000))
age_days = lambda at: (NOW - datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp() * 1000) / DAY

tot = collections.Counter()
for r in rows:
    top = r['key'].split('/')[0]
    tot['edit/' if top == 'edit' else top + '/'] += r['size']
print('BUCKET', {k: round(v / GB, 1) for k, v in tot.items()}, 'total', round(sum(tot.values()) / GB, 1))
# Growth since Nov 1 by kind
grow = collections.Counter()
for r in rows:
    if r['at'] >= '2026-11-01':
        grow[r['kind']] += r['size']
print('ADDED since Nov 1 (still present):', {k: round(v / GB, 1) for k, v in grow.most_common()})

edit = [r for r in rows if r['key'].startswith('edit/')]

# Orphans: referenced by no project and nothing else.
orph = collections.Counter(); orph_old = collections.Counter(); orph_n = collections.Counter()
orphan_rows = []
for r in edit:
    if r['kind'] == 'keep':
        continue
    if r['projs'] or r['others']:
        continue
    orphan_rows.append(r)
    orph[r['kind']] += r['size']; orph_n[r['kind']] += 1
    if age_days(r['at']) >= 14:
        orph_old[r['kind']] += r['size']
print('\nORPHANS by kind (GB, all / last written 14+ days ago, count)')
for k, v in orph.most_common():
    print(f'  {k:16s} {fmt(v)} {fmt(orph_old[k])} {orph_n[k]:6d}')
print('  TOTAL', fmt(sum(orph.values())), fmt(sum(orph_old.values())))
# Orphans of deleted projects (owned by a project id not in Convex)
dead = collections.Counter()
for r in orphan_rows:
    for i in r['ids']:
        if i.startswith('project/'):
            dead[i[8:]] += r['size']
print('  of deleted projects:', {k: round(v / GB, 1) for k, v in dead.most_common(12)})
# Writer-only footage (no Edit project but a live script)
wr = collections.Counter()
for r in edit:
    if not r['projs'] and r['others'] and all(o.startswith('writer') for o in r['others']):
        wr[r['kind']] += r['size']
print('  held only by live Writer scripts (not orphans):', {k: round(v / GB, 1) for k, v in wr.items()}, round(sum(wr.values()) / GB, 1))

# Finished --------------------------------------------------------------------
done = {l['key'][5:]: l['at'] for l in later if l['key'].startswith('edit:') and l.get('done')}
aside = {l['key'][5:]: l for l in later if l['key'].startswith('edit:') and not l.get('done')}
locked = {l['projectId'] for l in S['locks'] if l['until'] > NOW}
rev_by = {r['sourceId']: r for r in S['reviews']}


def why(pid):
    p = projects[pid]
    out = []
    if pid in done: out.append(f'Done on Home {iso(done[pid])}')
    if pid in aside: out.append('set aside (Later)')
    r = rev_by.get(pid)
    if r: out.append(f'review v{r["currentVersion"]} {r["openCount"]} open notes' + (' approved' if r.get('approved') else ''))
    out.append(f'untouched {int((NOW - p["updatedAt"]) / DAY)}d')
    return '; '.join(out)


tiers = {
    'A: Done on Home, untouched 7+ days': {pid for pid in done if pid in projects and NOW - projects[pid]['updatedAt'] >= 7 * DAY},
    'B: Done on Home (any)': {pid for pid in done if pid in projects},
    'C: untouched 14+ days (Done or not)': {pid for pid in projects if NOW - projects[pid]['updatedAt'] >= 14 * DAY},
    'D: Done, or untouched 14+ days': {pid for pid in projects if pid in done or NOW - projects[pid]['updatedAt'] >= 14 * DAY},
}
for t in tiers:
    tiers[t] -= locked
print('\nlocked now:', locked)
print('done markers for deleted projects:', [p for p in done if p not in projects])

def exclusive(fin, kinds_filter=None):
    """Bytes of objects referenced by projects only in `fin` and by nothing else."""
    by_kind = collections.Counter(); by_proj = collections.defaultdict(collections.Counter)
    shared_live = collections.Counter()
    for r in edit:
        if r['kind'] in ('keep',) or not r['projs']:
            continue
        if r['projs'] <= fin and not r['others']:
            by_kind[r['kind']] += r['size']
            owner = next(iter(r['projs'])) if len(r['projs']) == 1 else 'shared among finished'
            by_proj[owner][r['kind']] += r['size']
        elif r['projs'] & fin:
            shared_live[r['kind']] += r['size']
    return by_kind, by_proj, shared_live

summary = {}
for t, fin in tiers.items():
    k, bp, sl = exclusive(fin)
    total = sum(k.values())
    # Keeping each finished project's latest review version (link keeps working)
    keep_latest = 0
    for r in edit:
        if r['kind'].startswith('review') and r['projs'] <= fin and not r['others'] and r['projs']:
            p = r['key'].split('/')
            lt = S['latest_tl'].get(p[2])
            if lt and p[3] == lt[0]:
                keep_latest += r['size']
    summary[t] = dict(projects=len(fin), gb=round(total / GB, 1), usd=round(total / GB * 0.015, 2),
                      gb_keep_latest_review=round((total - keep_latest) / GB, 1), by_kind={a: round(b / GB, 1) for a, b in k.most_common()},
                      shared_with_live_gb={a: round(b / GB, 1) for a, b in sl.most_common()})
    print(f'\n{t}: {len(fin)} projects, exclusive {fmt(total)} GB (${total/GB*0.015:.2f}/mo); keeping latest review version: {fmt(total-keep_latest)} GB')
    print('   by kind', {a: round(b / GB, 1) for a, b in k.most_common()})
    print('   shared with live (kept)', {a: round(b / GB, 1) for a, b in sl.most_common()})

# Per-project table for tier D (widest)
fin = tiers['D: Done, or untouched 14+ days']
_, bp, _ = exclusive(fin)
cols = ['originals', 'excerpts', 'proxies/pieces', 'excerpt-cells', 'analysis', 'sound', 'exports', 'review-video', 'review-full', 'review-meta']
out = []
for pid in sorted(fin, key=lambda x: -sum(bp[x].values())):
    p = projects[pid]
    c = bp[pid]
    rec = dict(project_id=pid, name=p['name'], owner=(p.get('createdBy') or {}).get('name', ''), style=(p.get('summary') or {}).get('style', ''),
               last_activity=iso(p['updatedAt']), why=why(pid),
               tiers=''.join(t[0] for t, s in tiers.items() if pid in s), total_gb=round(sum(c.values()) / GB, 2))
    for col in cols:
        rec[col + '_gb'] = round(c[col] / GB, 2)
    rec['other_gb'] = round(sum(v for kk, v in c.items() if kk not in cols) / GB, 2)
    out.append(rec)
with open(f'{D}/finished_projects.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print('\nPER PROJECT (tier D)')
for rec in out:
    print(f"  {rec['total_gb']:7.1f} {rec['tiers']:4s} {rec['project_id']:24s} {rec['last_activity']} {rec['owner'][:10]:10s} {rec['name'][:60]} | orig {rec['originals_gb']} exc {rec['excerpts_gb']} prox {rec['proxies/pieces_gb']} exp {rec['exports_gb']} rev {rec['review-video_gb']+rec['review-full_gb']} | {rec['why']}")
print('  shared among finished', {a: round(b / GB, 1) for a, b in bp['shared among finished'].items()})

# Live projects for comparison
live = set(projects) - fin
lb = collections.Counter()
for r in edit:
    if r['projs'] & live:
        lb[r['kind']] += r['size']
print('\nLIVE projects (not in D):', len(live), 'reference', round(sum(lb.values()) / GB, 1), 'GB', {a: round(b / GB, 1) for a, b in lb.most_common()})

# Superseded review versions across all projects (not the latest live version)
sup = collections.Counter(); sup_fin = collections.Counter()
for r in edit:
    if not r['kind'].startswith('review'): continue
    p = r['key'].split('/')
    lt = S['latest_tl'].get(p[2])
    if lt and p[3] != lt[0] and not (r['others']) and len(r['projs'] - {p[2]}) == 0:
        sup[r['kind']] += r['size']
        if p[2] in fin: sup_fin[r['kind']] += r['size']
print('SUPERSEDED review versions (all projects):', {a: round(b / GB, 1) for a, b in sup.items()}, round(sum(sup.values()) / GB, 1), ' of finished(D):', round(sum(sup_fin.values()) / GB, 1))

# Biggest single deletable items (tier D exclusive + orphans)
big = [r for r in edit if r['kind'] != 'keep' and ((r['projs'] and r['projs'] <= fin and not r['others']) or (not r['projs'] and not r['others']))]
big.sort(key=lambda r: -r['size'])
print('\nBIGGEST deletable items')
for r in big[:25]:
    print(f"  {r['size']/GB:6.2f} {r['kind']:14s} {r['at'][:10]} {','.join(sorted(r['projs'])) or 'ORPHAN'} {r['key'][:120]}")

json.dump(dict(summary=summary, orphans={k: round(v / GB, 2) for k, v in orph.items()}, orphans_14d={k: round(v / GB, 2) for k, v in orph_old.items()}),
          open(f'{D}/summary.json', 'w'), indent=1)
with open(f'{D}/orphans.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['key', 'bytes', 'last_modified', 'kind', 'identities'])
    for r in sorted(orphan_rows, key=lambda r: -r['size']):
        w.writerow([r['key'], r['size'], r['at'], r['kind'], ' '.join(sorted(r['ids']))])
with open(f'{D}/deletable_finished_tierD.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['key', 'bytes', 'last_modified', 'kind', 'projects'])
    for r in sorted([r for r in edit if r['kind'] != 'keep' and r['projs'] and r['projs'] <= fin and not r['others']], key=lambda r: -r['size']):
        w.writerow([r['key'], r['size'], r['at'], r['kind'], ' '.join(sorted(r['projs']))])
