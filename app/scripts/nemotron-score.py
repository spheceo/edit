#!/usr/bin/env python3
"""Scores nemotron-bench.py's answers against our finished transcripts.

The reference is Edit's transcript after the watch and the team's fixes: each
word's voice named as a person (`speakers`). It began as Scribe's, so it leans
towards Scribe: Scribe's words agree with it by construction, and a Scribe
voice is all one person by construction. What's fair to compare:

- speakers, one-to-one: each tag (Nemotron's) or voice (Scribe's) stands for
  one person, the best pairing; a person split across tags loses the words of
  every tag but one. This is what the labelling has to undo.
- speakers, many-to-one: each tag goes to its most common person; how pure the
  tags are, whatever the splitting.
- split: how many tags carry a person (each with 10%+ of their words).
- words: how far Nemotron's words are from ours (not an error rate: ours have
  mistakes too), and timing against the Scribe pieces' times.

    uv run --with scipy python scripts/nemotron-score.py \
        --ref /tmp/nemo-bench/ref --out /tmp/nemo-bench/out \
        --window "killer-couple:804-870=Mike (Detective)"
"""
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import statistics

from scipy.optimize import linear_sum_assignment

TAG = re.compile(r"<spk:(\d+)>")
EVENT = re.compile(r"^[\(\[<].*[\)\]>]$")


def token(text: str) -> str:
    return re.sub(r"[^a-z0-9']", "", text.lower().replace("’", "'"))


def ref_words(path: Path) -> list[dict]:
    transcript = json.loads(path.read_text())
    names = transcript.get("speakers") or {}
    out = []
    for word in transcript["words"]:
        if EVENT.match(word["text"].strip()):
            continue
        text = token(word["text"])
        if text:
            voice = word.get("speaker") or "?"
            out.append({"t": text, "start": word["start"], "voice": voice, "person": names.get(voice, voice)})
    return out


def hyp_words(answer: dict) -> tuple[list[dict], dict]:
    response = answer["response"]
    stamps = response.get("ctc_timestamps") or {}
    out = []
    for word in stamps.get("words") or []:
        text = token(TAG.sub("", str(word.get("word", ""))))
        if text:
            out.append({"t": text, "start": float(word["start"]), "tag": str(word.get("speaker"))})
    return out, stamps


def one_to_one(pairs: list[tuple[str, str]]) -> float:
    rows = sorted({a for a, _ in pairs})
    cols = sorted({b for _, b in pairs})
    counts = Counter(pairs)
    cost = [[-counts[(a, b)] for b in cols] for a in rows]
    r, c = linear_sum_assignment(cost)
    return sum(-cost[i][j] for i, j in zip(r, c)) / len(pairs)


def many_to_one(pairs: list[tuple[str, str]]) -> float:
    by = defaultdict(Counter)
    for a, b in pairs:
        by[a][b] += 1
    return sum(c.most_common(1)[0][1] for c in by.values()) / len(pairs)


def splits(pairs: list[tuple[str, str]], people: list[str]) -> dict[str, int]:
    """How many tags carry each person (each with 10%+ of their words)."""
    by = defaultdict(Counter)
    for tag, person in pairs:
        by[person][tag] += 1
    return {p: sum(1 for n in by[p].values() if n >= 0.1 * sum(by[p].values())) for p in people}


def score(ref: list[dict], hyp: list[dict], windows: list[tuple[float, float, str]]) -> dict:
    matcher = SequenceMatcher(None, [w["t"] for w in ref], [w["t"] for w in hyp], autojunk=False)
    subs = dels = ins = 0
    matched = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            matched += zip(range(i1, i2), range(j1, j2))
        elif op == "replace":
            subs += min(i2 - i1, j2 - j1)
            dels += max(0, (i2 - i1) - (j2 - j1))
            ins += max(0, (j2 - j1) - (i2 - i1))
        elif op == "delete":
            dels += i2 - i1
        else:
            ins += j2 - j1
    drift = sorted(abs(ref[i]["start"] - hyp[j]["start"]) for i, j in matched)
    nemo = [(hyp[j]["tag"], ref[i]["person"]) for i, j in matched]
    scribe = [(ref[i]["voice"], ref[i]["person"]) for i, j in matched]
    no_narrator = [(t, p) for t, p in nemo if "narrator" not in p.lower()]
    words = Counter(p for _, p in nemo)
    people = [p for p, n in words.most_common() if n >= 50]

    # Each tag's person, as many-to-one would have it, for the per-person and window tables.
    by_tag = defaultdict(Counter)
    for tag, person in nemo:
        by_tag[tag][person] += 1
    tag_person = {tag: c.most_common(1)[0][0] for tag, c in by_tag.items()}
    hit = Counter(p for t, p in nemo if tag_person[t] == p)
    nemo_split, scribe_split = splits(nemo, people), splits(scribe, people)

    spots = []
    for start, end, who in windows:
        inside = [(i, j) for i, j in matched if start <= ref[i]["start"] < end]
        tags = Counter(hyp[j]["tag"] for _, j in inside)
        persons = Counter(ref[i]["person"] for i, _ in inside)
        spots.append({
            "window": f"{start:.0f}-{end:.0f} s", "expected": who, "words": len(inside),
            "reference_says": dict(persons.most_common(3)),
            "nemotron_tags": {t: f"{n} words → {tag_person[t]}" for t, n in tags.most_common(4)},
            "nemotron_right": sum(1 for i, j in inside if tag_person[hyp[j]["tag"]] == who),
        })

    return {
        "ref_words": len(ref), "nemotron_words": len(hyp),
        "word_difference": round((subs + dels + ins) / len(ref), 4),
        "missing": dels, "extra": ins, "different": subs,
        "matched_words": len(matched),
        "timing_median_s": round(statistics.median(drift), 3) if drift else None,
        "timing_p90_s": round(drift[int(0.9 * len(drift))], 3) if drift else None,
        "timing_over_1s": round(sum(d > 1 for d in drift) / len(drift), 4) if drift else None,
        "nemotron_tags": len(by_tag), "scribe_voices": len({v for v, _ in scribe}), "people": len(words),
        "speakers_one_to_one": {"nemotron": round(one_to_one(nemo), 4), "scribe": round(one_to_one(scribe), 4)},
        "speakers_many_to_one": {"nemotron": round(many_to_one(nemo), 4), "scribe": round(many_to_one(scribe), 4)},
        "speakers_one_to_one_without_narrator": round(one_to_one(no_narrator), 4) if no_narrator else None,
        "people_table": [
            {"person": p, "words": words[p], "nemotron_right": round(hit[p] / words[p], 3),
             "nemotron_tags": nemo_split[p], "scribe_voices": scribe_split[p]}
            for p in people
        ],
        "tags": {t: dict(c.most_common(3)) for t, c in sorted(by_tag.items())},
        "windows": spots,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ref", type=Path, required=True, help="folder of <video>.json (Edit transcripts)")
    parser.add_argument("--out", type=Path, required=True, help="nemotron-bench.py's answers")
    parser.add_argument("--window", action="append", default=[], help='video:start-end=Person, seconds')
    args = parser.parse_args()
    windows = defaultdict(list)
    for item in args.window:
        video, rest = item.split(":", 1)
        span, who = rest.split("=", 1)
        start, end = span.split("-")
        windows[video].append((float(start), float(end), who))

    results = {}
    for answer_path in sorted(args.out.glob("*-*.json")):
        if answer_path.name.endswith(".score.json"):
            continue
        answer = json.loads(answer_path.read_text())
        name = f"{answer['video']}-{answer['variant']}"
        if "http_error" in answer["response"]:
            results[name] = {"failed": answer["response"]}
            continue
        hyp, stamps = hyp_words(answer)
        if stamps.get("error") or not hyp:
            results[name] = {"failed": stamps.get("error") or "no words"}
            continue
        ref = ref_words(args.ref / f"{answer['video']}.json")
        result = score(ref, hyp, windows[answer["video"]])
        result["seconds"] = answer["seconds"]
        result["diarization_speakers"] = len({str(s.get("speaker")) for s in stamps.get("diarization") or []})
        result["usage"] = answer["response"].get("usage")
        results[name] = result
        (args.out / f"{name}.score.json").write_text(json.dumps(result, indent=1))

    for name, r in results.items():
        print(f"\n== {name}")
        if "failed" in r:
            print("  failed:", str(r["failed"])[:500])
            continue
        print(f"  words: ours {r['ref_words']}, Nemotron {r['nemotron_words']}; differ by {r['word_difference']:.1%}"
              f" (missing {r['missing']}, extra {r['extra']}, different {r['different']}); heard in {r['seconds']} s")
        print(f"  timing vs Scribe pieces: median {r['timing_median_s']} s, p90 {r['timing_p90_s']} s,"
              f" {r['timing_over_1s']:.1%} over 1 s")
        print(f"  speakers: {r['people']} people; Nemotron {r['nemotron_tags']} tags"
              f" ({r['diarization_speakers']} in its diarization), Scribe {r['scribe_voices']} voices")
        one, many = r["speakers_one_to_one"], r["speakers_many_to_one"]
        print(f"  one-to-one: Nemotron {one['nemotron']:.1%}, Scribe {one['scribe']:.1%}"
              f"  |  many-to-one: Nemotron {many['nemotron']:.1%}, Scribe {many['scribe']:.1%} (by construction)")
        for row in r["people_table"]:
            print(f"    {row['person'][:34]:34} {row['words']:5} words  Nemotron right {row['nemotron_right']:.0%}"
                  f"  tags {row['nemotron_tags']}  Scribe voices {row['scribe_voices']}")
        for spot in r["windows"]:
            print(f"  window {spot['window']} (should be {spot['expected']}): {spot['nemotron_right']}/{spot['words']} right;"
                  f" ours {spot['reference_says']}; Nemotron {spot['nemotron_tags']}")


if __name__ == "__main__":
    main()
