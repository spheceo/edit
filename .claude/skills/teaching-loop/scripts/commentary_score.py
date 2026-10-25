#!/usr/bin/env python3
"""Inspect a commentary trial without treating police-style metrics as its goal.
Usage: commentary_score.py PROJECT OUT_DIR [--frames]
Numbers describe structure, not taste or semantic relevance; judge the pictures
and audiovisual samples against the private answer key separately.
"""
import collections
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

pid, output = sys.argv[1:3]
out = Path(output); out.mkdir(parents=True, exist_ok=True)
home = Path(os.environ.get("EDIT_HOME", str(Path.home() / ".edit")))
p = json.loads((home / "projects" / (pid + ".json")).read_text())
fps = p["settings"]["fps"]
clips = p["clips"]; med = {m["id"]: m for m in p["media"]}
end = lambda c: c["start"] + c["duration"]
length = max((end(c) for c in clips), default=0)
body = {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"review_edit","arguments":{"project_id":pid}}}
reply = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:7700/mcp?project=" + pid, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"}), timeout=900))
if reply.get("result", {}).get("isError"): raise RuntimeError(reply)
review = json.loads(reply["result"]["content"][0]["text"])
(out / "review.json").write_text(json.dumps(review, indent=2))
audit = review.get("audit", {}).get("issues", [])
counts = collections.Counter(i["kind"] for i in audit)
blocks = p.get("script", {}).get("blocks", [])
narration = [b for b in blocks if b["kind"] == "narration"]
alive = {c["id"] for c in clips}
sources = set()
for m in p["media"]:
    source = m.get("cloud", {}).get("source", "")
    match = re.match(r"youtube:([\w-]{11})", source)
    if match: sources.add(match.group(1))
inventory = home / "research" / pid / "broll.json"
saved = json.loads(inventory.read_text()) if inventory.exists() else {}
report = {"project":pid,"name":p["name"],"minutes":round(length/fps/60,2),"clips":len(clips),"media":len(med),
    "narration_blocks":len(narration),"voiced_blocks":sum(b.get("voiceover") in alive for b in narration),
    "source_blocks":sum(b["kind"]=="footage" for b in blocks),"youtube_sources_imported":len(sources),
    "saved_frame_observations":sum(k.startswith("observation:") for k in saved),
    "captured_evidence_pages":sum(k.startswith("capture:") for k in saved),
    "designed_graphics":dict(collections.Counter(c.get("name") for c in clips if (c.get("name") or "").startswith("Janitor ·"))),
    "audit":dict(counts),"limits":"Counts do not certify relevance, visual quality, source verification or the heard mix."}
(out / "score.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))

if "--frames" not in sys.argv: sys.exit(0)
picks = {}
def pick(frame, why):
    frame = max(0,min(length-1,int(frame)))
    picks.setdefault(frame, why)
for second in range(0,min(30,int(length/fps)),2): pick(second*fps+5,"opening")
for i in range(20): pick((i+.5)*length/20,"distributed")
chapter_first = {}
for b in blocks:
    heading = next((n[9:] for n in b.get("notes",[]) if n.startswith("Chapter: ")),"Story")
    c = next((c for c in clips if c["id"]==b.get("voiceover",b.get("clip"))),None)
    if c and heading not in chapter_first:
        chapter_first[heading] = c["start"]; pick(c["start"]+min(c["duration"]//2,3*fps),heading)
graphics = sorted((c for c in clips if c.get("name") in {"Janitor · source card","Janitor · emphasis","Janitor · profile facts","Janitor · chapter number"}),key=lambda c:c["start"])
if graphics:
    for i in range(min(14,len(graphics))):
        c=graphics[int(i*len(graphics)/min(14,len(graphics)))];pick(c["start"]+min(35,c["duration"]-1),c["name"])
pick(length-2*fps,"ending")
chosen=sorted(picks.items())
if len(chosen)>64: chosen=[chosen[int(i*len(chosen)/64)] for i in range(64)]
frames=out/"frames";frames.mkdir(exist_ok=True)
(frames/"index.txt").write_text("\n".join(f"sheet {i//16+1:02} cell {i%16+1:02} frame {f} {f/fps:.2f}s {why}" for i,(f,why) in enumerate(chosen)))
subprocess.run([str(Path(__file__).with_name("sheet.sh")),pid,str(frames),*[str(f) for f,_ in chosen]],check=True,timeout=3600)
