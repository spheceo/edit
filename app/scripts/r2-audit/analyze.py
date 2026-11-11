# Read-only analysis of prod R2 (listing) against prod Convex (dumps) and project bodies.
import json, re, os, sys, glob, time, collections, urllib.parse, csv

D = sys.argv[1]
NOW = time.time() * 1000
DAY = 86400000
L = lambda t: [json.loads(l) for l in open(f'{D}/cx/{t}.jsonl') if l.strip()]

projects = {p['projectId']: p for p in L('editProjects')}
later = L('editLater')
reviews = [r for r in L('reviews') if r['app'] == 'edit']
rv = L('reviewVersions')
locks = L('editLocks')
writer = L('writerScripts')
media = [json.loads(l) for l in open(f'{D}/cx/editMedia.16000.jsonl') if l.strip()]

SCHEMES = ('drive', 'youtube', 'sha256', 'posts', 'post', 'review')
TEMP = ('edit/reviews/tmp/', 'edit/proxies/jobs/', 'edit/exports/results/', 'edit/transcribe/', 'edit/test/')
KEEP = ('edit/reports/', 'edit/thumbnails/', 'edit/ideas/', 'edit/covers/', 'edit/sweep/', 'edit/library/', 'edit/research/images/')
PIECE_RANGE = re.compile(r'_\d+-\d+$')

# review timeline -> version n, per project
timeline_n = {}
rid_to_src = {r['_id']: r['sourceId'] for r in reviews}
latest_tl = {}
for v in rv:
    src = rid_to_src.get(v['reviewId'])
    if src is None:
        continue
    m = re.match(r'edit/reviews/([^/]+)/([^/]+)/', v['key'])
    if m:
        timeline_n[(m.group(1), m.group(2))] = v['n']
        if v.get('deletedAt') is None and (src not in latest_tl or v['n'] > latest_tl[src][1]):
            latest_tl[src] = (m.group(2), v['n'])


def identities(key):
    """What a key belongs to: a footage source, a finished video, or a project."""
    p = key.split('/')
    out = set()
    if p[1] in ('reviews',) and len(p) > 3:
        out.add('project/' + p[2])
        n = timeline_n.get((p[2], p[3]))
        if n is not None:
            out.add(f'review/{p[2]}/{n}')
        return out
    if p[1] == 'exports' and len(p) > 3 and p[2] == 'playback':
        out.add('project/' + p[3]); return out
    if p[1] in ('exports', 'playback') and len(p) > 2 and p[2].startswith('p'):
        out.add('project/' + p[2]); return out
    if p[1] == 'research' and len(p) > 3 and p[2] == 'projects':
        out.add('project/' + p[3]); return out
    if p[1] == 'chats':
        out.add('project/' + p[2].removesuffix('.json')); return out
    for i in range(2, len(p) - 1):
        if p[i] in SCHEMES:
            s = p[i]
            if s == 'review':
                if i + 2 < len(p):
                    out.add(f'review/{p[i+1]}/{p[i+2].removesuffix(".mp4")}')
                return out
            ident = p[i + 1]
            for suf in ('.mp4', '.mov', '.json'):
                ident = ident.removesuffix(suf)
            ident = ident.split('#')[0]
            if p[1] == 'pieces':
                ident = PIECE_RANGE.sub('', ident)
            out.add(f'{"posts" if s == "post" else s}/{ident}' if s != 'post' else f'post/{ident}')
            return out
    return out


TOK = re.compile(r'(drive|youtube|sha256|post):([A-Za-z0-9_=-]{6,128})')
REVTOK = re.compile(r'review:(p\d+-\d+)/(\d+)')
KEYTOK = re.compile(r'edit/[A-Za-z0-9_.=/#%:-]+?(?=["\\\s?&]|$)', re.M)
YT = re.compile(r'(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})')
DR = re.compile(r'drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_-]{20,})')


def refs_of(text):
    t = text + '\n' + urllib.parse.unquote(text)
    out = set()
    for m in KEYTOK.finditer(t):
        k = m.group(0)
        out |= identities(k)
        out.add('key:' + k)
    for m in TOK.finditer(t):
        out.add(f'{m.group(1)}/{m.group(2)}')
    for m in REVTOK.finditer(t):
        out.add(f'review/{m.group(1)}/{m.group(2)}')
    for m in YT.finditer(t):
        out.add('youtube/' + m.group(1))
    for m in DR.finditer(t):
        out.add('drive/' + m.group(1))
    return out


# Referrers ------------------------------------------------------------------
proj_refs = {}
for pid in projects:
    f = f'{D}/bodies/{pid}.json'
    proj_refs[pid] = refs_of(open(f).read()) | {'project/' + pid}

other_refs = collections.defaultdict(set)  # referrer label -> identities
# Live Writer scripts, from the local prod-share copy of their folders.
live_scripts = {w['scriptId']: w for w in writer if not w.get('deletedAt')}
missing_local = []
for sid in live_scripts:
    folder = os.path.expanduser(f'~/.edit-prodshare/writer/scripts/{sid}')
    if not os.path.isdir(folder):
        missing_local.append(sid)
        continue
    acc = set()
    for root, _, files in os.walk(folder):
        for name in files:
            if name.endswith('.json'):
                try:
                    acc |= refs_of(open(os.path.join(root, name), errors='replace').read())
                except Exception:
                    pass
    other_refs['writer:' + sid] = acc
other_refs['writer-rows'] = refs_of(json.dumps(list(live_scripts.values())))
for t in ('ideas', 'thumbnails', 'thumbnailAssets', 'editNotes'):
    try:
        other_refs[t] = refs_of(open(f'{D}/cx/{t}.jsonl').read())
    except FileNotFoundError:
        pass
# Local projects on this machine's prod-share copy not in the cloud.
local_only = []
for f in glob.glob(os.path.expanduser('~/.edit-prodshare/projects/p*.json')):
    pid = os.path.basename(f).removesuffix('.json')
    if '.' in pid or pid in projects:
        continue
    local_only.append(pid)
    other_refs['local:' + pid] = refs_of(open(f).read()) | {'project/' + pid}

# Reverse index: identity -> project ids, and identity -> other referrers
by_ident = collections.defaultdict(set)
for pid, refs in proj_refs.items():
    for r in refs:
        by_ident[r].add(pid)
other_ident = collections.defaultdict(set)
for lab, refs in other_refs.items():
    for r in refs:
        other_ident[r].add(lab)

# Objects ----------------------------------------------------------------------
objs = []
for line in open(f'{D}/r2.tsv'):
    k, s, at = line.rstrip('\n').split('\t')
    objs.append((k, int(s), at))


def kind_of(k):
    p = k.split('/')
    if p[0] != 'edit':
        return 'repack' if p[0] in ('repack', 'projects') else p[0]
    if k.startswith(TEMP):
        return 'temp'
    if k.startswith(KEEP):
        return 'keep'
    if p[1] == 'reviews':
        f = p[-1]
        return 'review-full' if f == 'full.mp4' else 'review-video' if f.endswith('.mp4') else 'review-meta'
    if p[1] == 'originals':
        return 'originals'
    if p[1] == 'excerpts':
        return 'excerpt-cells' if len(p) > 2 and p[2] in ('originals', 'excerpts') else 'excerpts'
    if p[1] in ('proxies', 'pieces', 'scrub'):
        return 'proxies/pieces'
    if p[1] == 'exports' or p[1] == 'playback':
        return 'exports'
    if p[1] in ('analysis', 'sound'):
        return p[1]
    return 'other:' + p[1]


rows = []
for k, s, at in objs:
    kind = kind_of(k)
    if not k.startswith('edit/'):
        rows.append(dict(key=k, size=s, at=at, kind=kind, ids=set(), projs=set(), others=set()))
        continue
    ids = identities(k)
    projs = set()
    others = set()
    for i in ids | {'key:' + k}:
        projs |= by_ident.get(i, set())
        others |= other_ident.get(i, set())
    rows.append(dict(key=k, size=s, at=at, kind=kind, ids=ids, projs=projs, others=others))

json.dump(dict(missing_local=missing_local, local_only=local_only), open(f'{D}/meta.json', 'w'))
import pickle
pickle.dump(dict(rows=rows, projects=projects, later=later, reviews=reviews, rv=rv, locks=locks, latest_tl=latest_tl,
                 media=media, live_scripts=list(live_scripts)), open(f'{D}/state.pkl', 'wb'))
print('objects', len(rows), 'missing local writer copies', len(missing_local), 'local-only projects', local_only)
