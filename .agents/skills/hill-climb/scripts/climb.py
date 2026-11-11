#!/usr/bin/env python3
"""Keep score for a hill climb.

The agent edits code. This script runs the check, decides keep or undo,
commits kept steps, and writes the log. The model never grades itself.

Trimmed from Hill Climb (github.com/Bil0000/Hill-Climb, MIT, (c) Bil0000)
to one repo, no kits, and only in a worktree of its own.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
NUMBER = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")
BARS = "▁▂▃▄▅▆▇█"
PLATEAU = 5
COMMIT_LIMIT = 10_000_000
STATE_WARN = 200_000_000
SLOW_STEP = 120
MORE = "Stop and report. If Sphe gives more, run: climb.py budget --hours N, --steps N, or --off"


class Fail(Exception):
    pass


def git(*args, check=True):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and result.returncode:
        raise Fail(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def repo():
    return Path(git("rev-parse", "--show-toplevel"))


def climbs_dir():
    return repo() / ".hill-climb"


def shared_checkout():
    """True in the main checkout, where other sessions work and commit."""
    own = git("rev-parse", "--absolute-git-dir")
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
    return Path(own).resolve() == Path(common).resolve()


def own_worktree():
    if shared_checkout():
        raise Fail("Climb only in a worktree of its own: an undone step resets the whole tree and deletes "
                   "untracked files, and other sessions work in this checkout. Ask Sphe for a worktree.")


def resolve(name):
    if name:
        folder = climbs_dir() / name
        if not (folder / "card.json").is_file():
            raise Fail(f"No climb named {name!r}. Run: climb.py list")
        return folder
    found = sorted(path.parent for path in climbs_dir().glob("*/card.json"))
    if len(found) != 1:
        raise Fail("Name the climb. Run: climb.py list" if found else "No climb yet. Run: climb.py init")
    return found[0]


def load(folder):
    return json.loads((folder / "card.json").read_text())


def save(folder, card):
    (folder / "card.json").write_text(json.dumps(card, indent=2) + "\n")


def append(folder, row):
    row = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), **row}
    with (folder / "log.jsonl").open("a") as handle:
        handle.write(json.dumps(row) + "\n")


def rows(folder):
    path = folder / "log.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def tail(text, lines=15):
    return "\n".join(text.strip().splitlines()[-lines:])


def run(command, timeout):
    process = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        stdout = None
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if stdout is None:
        process.communicate()
        return None
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def together(commands, timeout):
    with ThreadPoolExecutor() as pool:
        return list(pool.map(lambda command: run(command, timeout), commands))


def read_score(result, pattern):
    text = ANSI.sub("", result.stdout + result.stderr)
    if pattern:
        lines = [line for line in text.splitlines() if re.search(pattern, line)]
        if lines:
            found = [group for match in re.finditer(pattern, lines[-1])
                     for group in (match.groups() if match.re.groups else [match.group()]) if group is not None]
            values = [value.replace(",", "") for value in found]
            if not all(NUMBER.fullmatch(value) for value in values):
                raise Fail(f"--score matched {found!r} in {lines[-1].strip()!r}, which is not a number")
            return sum(float(value) for value in values)
        if not result.returncode:
            return 0.0
        raise Fail(f"check exited {result.returncode} and printed nothing that matches --score\n{tail(text)}")
    if result.returncode:
        raise Fail(f"check exited {result.returncode}\n{tail(text)}")
    lines = ANSI.sub("", result.stdout).strip().splitlines()
    if not lines or not NUMBER.fullmatch(lines[-1].strip()):
        raise Fail(f"the last line of check output must be the score\n{tail(text)}")
    return float(lines[-1])


def measure(checks, runs, timeout, output=None, patterns=None):
    patterns = patterns or [None]
    if len(patterns) not in (1, len(checks)):
        raise Fail(f"Give one --score for all checks, or one per check: {len(patterns)} for {len(checks)} checks.")
    patterns = patterns * len(checks) if len(patterns) == 1 else patterns
    scores, seconds = [], []
    for attempt in range(runs + (runs > 1)):
        start = time.monotonic()
        results = together(checks, timeout)
        seconds.append(time.monotonic() - start)
        if output:
            output.write_text("\n".join(f"$ {command}\n{result.stdout}{result.stderr}" for command, result in zip(checks, results) if result))
        if None in results:
            raise Fail(f"check timed out after {timeout}s: {checks[results.index(None)]}")
        score = sum(read_score(result, pattern) for result, pattern in zip(results, patterns))
        if runs > 1 and attempt == 0:
            seconds.pop()
            continue
        scores.append(score)
    return statistics.median(scores), max(scores) - min(scores), sum(seconds) / len(seconds)


def switch_tree(tree):
    git("clean", "-fdq")
    git("read-tree", "-u", "--reset", tree)


def paired(folder, card):
    git("add", "-A")
    tree = git("write-tree")
    (folder / "pending-tree").write_text(tree + "\n")
    base, new, seconds = [], [], []
    for turn in range(card["runs"] + card["runs"] % 2):
        order = [(tree, new), ("HEAD", base)]
        for side, scores in order if turn % 2 == 0 else order[::-1]:
            switch_tree(side)
            score, _, took = measure(card["check"], 1, card["timeout"], folder / "last.txt" if side == tree else None, card["score"])
            if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
                raise Fail("the check changed a locked file")
            scores.append(score)
            seconds.append(took)
    switch_tree(tree)
    (folder / "pending-tree").unlink()
    new, base = statistics.median(new), statistics.median(base)
    if base == 0:
        raise Fail("--paired needs a score that is never 0")
    return card["best"]["score"] * new / base, [base, new], sum(seconds) / len(seconds)


def failing_guards(guards, timeout):
    for command in guards:
        result = run(command, timeout)
        if result is None:
            return command, f"timed out after {timeout}s"
        if result.returncode:
            return command, tail(result.stdout + result.stderr)
    return None


def ignored(files, folder):
    found = subprocess.run(["git", "check-ignore", "--stdin"], input="\n".join(map(str, files)), cwd=folder,
                           capture_output=True, text=True).stdout
    return set(found.splitlines())


def fingerprint(paths):
    digest = hashlib.sha256()
    root = repo()
    for name in paths:
        target = root / name
        if not target.exists():
            raise Fail(f"Locked path does not exist: {name}")
        files = [target] if target.is_file() else sorted(p for p in target.rglob("*") if p.is_file())
        skip = set() if ".hill-climb" in target.parts else ignored(files, target.parent)
        for path in files:
            digest.update(os.path.relpath(path, root).encode())
            digest.update(b"ignored" if str(path) in skip else path.read_bytes())
    return digest.hexdigest()


def threshold(min_gain, score):
    text = str(min_gain)
    if text.endswith("%"):
        return abs(score) * float(text[:-1]) / 100
    return float(text)


def better(card, new, old):
    gain = threshold(card["min_gain"], old)
    return new > old + gain if card["direction"] == "max" else new < old - gain


def reached(card, score):
    target = card["target"]
    if target is None:
        return False
    return score >= target if card["direction"] == "max" else score <= target


def bar(text, baseline, direction):
    if text is None:
        return None
    if text.endswith("x"):
        factor = float(text[:-1])
        if factor <= 1:
            raise Fail("A bar like 2x needs a factor above 1.")
        return baseline / factor if direction == "min" else baseline * factor
    return float(text)


def outside(paths, allowed):
    return [path for path in paths if not any(path == lock or path.startswith(lock.rstrip("/") + "/") for lock in allowed)]


def number(value):
    return f"{value:.6g}"


def interrupted(folder):
    tree = (folder / "pending-tree").read_text().strip()
    restore = shlex.join(["git", "-C", str(repo()), "read-tree", "-u", "--reset", tree])
    return (f"A paired step was cut off and the tree may hold the old code. Restore the edit with: "
            f"{restore} && rm {folder / 'pending-tree'}")


def gaining(steps):
    kept = [row for row in steps if row["result"] == "kept" and row.get("gain", True)]
    if not kept:
        return False
    at = time.mktime(time.strptime(kept[-1]["time"], "%Y-%m-%d %H:%M:%S"))
    return time.time() - at < 3600 and len(steps) - kept[-1]["step"] < PLATEAU


def hours(card):
    return (time.time() - card["started"]) / 3600 if card.get("started") else 0


def changed_files():
    return sorted(set(git("diff", "--name-only", "HEAD").splitlines()
                      + git("ls-files", "--others", "--exclude-standard").splitlines()))


def too_big(paths):
    return [path for path in paths if os.path.isfile(path) and os.path.getsize(path) > COMMIT_LIMIT]


def folder_size(folder):
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file() and not path.is_symlink())


def dirty():
    return bool(git("status", "--porcelain"))


def undo():
    git("reset", "--hard", "-q", "HEAD")
    git("clean", "-fdq")


def commit(message):
    if dirty():
        git("add", "-A")
        git("commit", "-q", "--no-verify", "-m", message)


def keep_output(folder):
    if (folder / "last.txt").exists():
        shutil.copyfile(folder / "last.txt", folder / "best.txt")


def exclude_state():
    exclude = Path(git("rev-parse", "--git-path", "info/exclude"))
    if not exclude.is_absolute():
        exclude = repo() / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text() if exclude.exists() else ""
    if "/.hill-climb/" not in text.splitlines():
        exclude.write_text(text + ("" if text.endswith("\n") or not text else "\n") + "/.hill-climb/\n")


def hold_lock():
    handle = open(git("rev-parse", "--git-path", "hill-climb.lock"), "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Fail("Another climb.py command is still running in this checkout. Wait for it to finish. "
                   "A command you interrupted can still be running.")
    return handle


def run_holdout(folder, card, reason):
    if not card["holdout"]:
        return None
    score, _, _ = measure([card["holdout"]], card["runs"], card["timeout"])
    append(folder, {"kind": "holdout", "score": score, "visible": card["best"]["score"], "why": reason})
    return score


def cmd_init(args):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", args.name):
        raise Fail("Use a short lowercase name with dashes, like build-speed.")
    own_worktree()
    folder = climbs_dir() / args.name
    if (folder / "card.json").exists():
        raise Fail(f"Climb {args.name!r} already exists. Resume it with: climb.py status {args.name}")
    exclude_state()
    threshold(args.min_gain, 1)
    lock = [os.path.relpath(os.path.abspath(path), repo()) for path in args.lock or []]
    stray = outside(changed_files(), lock)
    if stray:
        raise Fail("Commit or set aside changes outside the locked check files first: " + ", ".join(stray[:5]))
    folder.mkdir(parents=True, exist_ok=True)
    score, spread, seconds = measure(args.check, args.runs, args.timeout, folder / "best.txt", args.score)
    target = bar(args.target, score, args.direction)
    failed = failing_guards(args.guard or [], args.timeout)
    if failed:
        raise Fail(f"A guard already fails before the climb starts: {failed[0]}\n{failed[1]}")
    big = too_big(changed_files())
    if big:
        raise Fail(f"A file is over {COMMIT_LIMIT // 1_000_000} MB and would be committed: {big[0]}. "
                   f"Move big data under .hill-climb/{args.name}/data/.")
    locked = fingerprint(lock) if lock else None
    base = git("branch", "--show-current")
    if not args.here:
        git("switch", "-q", "-c", f"climb/{args.name}")
    commit(f"climb({args.name}): add the check")
    card = {
        "name": args.name,
        "goal": args.goal,
        "check": args.check,
        "score": args.score or [],
        "direction": args.direction,
        "guards": args.guard or [],
        "target": target,
        "after": args.after,
        "runs": args.runs,
        "min_gain": args.min_gain,
        "timeout": args.timeout,
        "holdout": args.holdout,
        "lock": lock,
        "fingerprint": locked,
        "max_steps": args.max_steps,
        "paired": args.paired,
        "max_hours": args.max_hours,
        "hard": args.hard,
        "started": time.time(),
        "base": base,
        "branch": git("branch", "--show-current"),
        "start_commit": git("rev-parse", "HEAD"),
        "baseline": score,
        "best": {"score": score, "commit": git("rev-parse", "HEAD"), "step": 0},
    }
    save(folder, card)
    append(folder, {"kind": "baseline", "score": score, "spread": spread, "seconds": round(seconds, 2)})
    holdout = run_holdout(folder, card, "baseline")
    print(f"Climb {args.name} started on {card['branch']}. Check output: {folder / 'best.txt'}")
    print(f"Baseline {number(score)} ({args.direction}), check takes {seconds:.1f}s.")
    if holdout is not None:
        print(f"Holdout baseline {number(holdout)}.")
    step_seconds = seconds * (2 * (args.runs + args.runs % 2) if args.paired else args.runs + (args.runs > 1))
    if step_seconds > SLOW_STEP:
        print(
            f"Warning: each step will take about {step_seconds / 60:.0f} min to score. Aim for under "
            f"{SLOW_STEP // 60} min: count the work instead of timing it, or score a sample, and move "
            f"the slow measure to --holdout."
        )
    if args.runs > 1 and spread > threshold(args.min_gain, score):
        percent = 100 * spread / abs(score) if score else 0
        print(
            f"Warning: the score moved {number(spread)} ({percent:.1f}%) between runs with no code change. "
            f"Set --min-gain above that, or a lucky run will count as a win. A percent like "
            f"--min-gain {max(1, round(percent * 1.5))}% keeps working as the score shrinks. "
            f"If the machine's load changes the score, add --paired."
        )
    if not args.guard:
        risk = ("A crash that stops the tests can print fewer failures and win." if args.score and args.direction == "min"
                else "A kept step can break anything the check does not measure.")
        print(f"Warning: no guard. {risk} Add --guard with the tests that pass today, or a build or typecheck.")
    if target is not None:
        print(f"Bar {number(target)}, then {args.after}.")
    if target is not None and reached(card, score):
        print("Warning: the baseline already meets the bar. Pick a harder bar.")


def cmd_try(args):
    own_worktree()
    folder = resolve(args.name)
    card = load(folder)
    if git("branch", "--show-current") != card["branch"]:
        raise Fail(f"Switch to {card['branch']} first.")
    steps = [row for row in rows(folder) if row["kind"] == "step"]
    over = []
    if card["max_steps"] and len(steps) >= card["max_steps"]:
        over.append(f"{len(steps)} of {card['max_steps']} steps")
    if card.get("max_hours") and hours(card) >= card["max_hours"]:
        over.append(f"{hours(card):.1f} of {number(card['max_hours'])} hours")
    if over and (card.get("hard") or not gaining(steps)):
        why = "" if card.get("hard") else f" and no gain in the last hour or {PLATEAU} steps"
        raise Fail(f"Budget used: {' and '.join(over)}{why}. {MORE}")
    if over:
        print(f"Past the limit ({' and '.join(over)}), but still gaining, so the climb goes on.")
    if (folder / "pending-tree").exists():
        raise Fail(interrupted(folder))
    if card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]:
        raise Fail(
            "Locked files changed. Undo those edits, or if the check itself is wrong, "
            "run: climb.py relock --why '<reason>'"
        )
    if not dirty():
        raise Fail("No change to try. Edit the code first.")
    step = len(steps) + 1
    best = card["best"]["score"]
    row = {"kind": "step", "step": step, "idea": args.idea}
    try:
        if card.get("paired"):
            score, row["pair"], seconds = paired(folder, card)
        else:
            score, _, seconds = measure(card["check"], card["runs"], card["timeout"], folder / "last.txt", card["score"])
    except Fail as error:
        undo()
        (folder / "pending-tree").unlink(missing_ok=True)
        lines = str(error).splitlines()
        why = lines[0] if len(lines) == 1 else f"{lines[0]}: {lines[-1].strip()[:120]}"
        append(folder, {**row, "result": "broke", "why": why})
        print(f"step {step} broke   {args.idea}\n{error}\nUndone. Full output: {folder / 'last.txt'}")
        return
    row.update(score=score, seconds=round(seconds, 2))
    held = score >= best if card["direction"] == "max" else score <= best
    if not (better(card, score, best) or args.fix and held):
        undo()
        append(folder, {**row, "result": "undone", "why": "score got worse" if args.fix else "no gain"})
        print(f"step {step} undone  {number(score)} (best {number(best)})  {args.idea}\nOutput: {folder / 'last.txt'}")
        return
    failed = failing_guards(card["guards"], card["timeout"])
    if failed:
        undo()
        append(folder, {**row, "result": "undone", "why": f"guard failed: {failed[0]}"})
        print(f"step {step} undone  {number(score)} but guard failed: {failed[0]}\n{failed[1]}")
        return
    try:
        moved = card["lock"] and fingerprint(card["lock"]) != card["fingerprint"]
    except Fail:
        moved = True
    if moved:
        undo()
        append(folder, {**row, "result": "broke", "why": "the check or a guard changed a locked file"})
        print(f"step {step} broke   {args.idea}\nThe check or a guard changed a locked file.\nUndone.")
        return
    big = too_big(changed_files())
    if big:
        undo()
        append(folder, {**row, "result": "broke", "why": f"would commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}"})
        print(f"step {step} broke   {args.idea}\nWould commit a file over {COMMIT_LIMIT // 1_000_000} MB: {big[0]}\n"
              f"Write big output under .hill-climb/{card['name']}/data/.\nUndone.")
        return
    commit(f"climb({card['name']}): step {step} {args.idea}\n\nscore {number(score)}, was {number(best)}")
    keep_output(folder)
    card["best"] = {"score": score, "commit": git("rev-parse", "HEAD"), "step": step}
    save(folder, card)
    append(folder, {**row, "result": "kept", "gain": better(card, score, best)})
    print(f"step {step} kept    {number(score)} (was {number(best)}, start {number(card['baseline'])})  {args.idea}")
    if reached(card, score):
        holdout = run_holdout(folder, card, "bar reached")
        print(f"BAR REACHED: {number(score)} meets {number(card['target'])}. The card says: {card['after']}.")
        if holdout is not None:
            print(f"Holdout now {number(holdout)}. Compare it with the holdout baseline before you claim a win.")


def spark(values, direction):
    if len(values) < 2:
        return ""
    low, high = min(values), max(values)
    span = (high - low) or 1
    levels = [(value - low) / span for value in values]
    if direction == "min":
        levels = [1 - level for level in levels]
    return "".join(BARS[round(level * (len(BARS) - 1))] for level in levels)


def cmd_status(args):
    folder = resolve(args.name)
    card = load(folder)
    log = rows(folder)
    steps = [row for row in log if row["kind"] == "step"]
    kept = [row for row in steps if row["result"] == "kept"]
    trail = [card["baseline"]] + [row["score"] for row in kept]
    since = len(steps) - card["best"]["step"]
    reviews = [row for row in log if row["kind"] == "review"]
    last_review = reviews[-1]["step"] if reviews else None
    stuck = len(reviews) >= 2 and reviews[-2]["step"] >= card["best"]["step"]
    timed = [row["seconds"] for row in log if "seconds" in row]
    print(f"Climb {card['name']} on {card['branch']}: {card['goal']}")
    print(f"Score {number(card['baseline'])} -> {number(card['best']['score'])} ({card['direction']})  {spark(trail, card['direction'])}")
    goal = "none" if card["target"] is None else f"{number(card['target'])}, then {card['after']}"
    budget = f" of {card['max_steps']}" if card["max_steps"] else ""
    print(f"Bar {goal}. Steps {len(steps)}{budget}, kept {len(kept)}, {since} since the last gain.")
    limit = f" of {number(card['max_hours'])}" if card.get("max_hours") else ""
    pace = f", about {60 * hours(card) / len(steps):.1f} min a step" if steps else ""
    print(f"Time {hours(card):.1f}{limit} hours{pace}.")
    if timed:
        print(f"Check takes {sum(timed) / len(timed):.1f}s on average.")
    for row in log:
        if row["kind"] == "raise":
            print(f"Raised {row['why']}")
    holdouts = [row for row in log if row["kind"] == "holdout"]
    if holdouts:
        print("Holdout " + ", ".join(f"{number(row['score'])} ({row['why']})" for row in holdouts))
    for row in log[-args.last:]:
        if row["kind"] == "step":
            score = number(row["score"]) if "score" in row else "-"
            note = "" if row["result"] == "kept" else f"  [{row['why']}]"
            print(f"  {row['step']:>4} {row['result']:<6} {score:>10}  {row['idea']}{note}")
        elif row["kind"] != "holdout":
            print(f"  ---- {row['kind']}: {row.get('why', number(row.get('score', 0)))}")
    if (folder / "pending-tree").exists():
        print(interrupted(folder))
    if (folder / "notes.md").exists():
        print("Notes:\n" + tail((folder / "notes.md").read_text(), 40))
    size = folder_size(climbs_dir())
    if size > STATE_WARN:
        print(f"STORAGE: .hill-climb holds {size // 1_000_000} MB. Shrink or delete .hill-climb/{card['name']}/data/.")
    if card["target"] is not None and reached(card, card["best"]["score"]):
        print(f"BAR REACHED. {'Check the holdout, then ' if card['holdout'] else 'Then '}{card['after']}.")
    elif stuck:
        print("STUCK: two blocker reviews with no gain between them. Stop and report.")
    elif since >= PLATEAU and (last_review is None or len(steps) - last_review >= PLATEAU):
        print(f"PLATEAU: {since} steps with no gain. Do a blocker review, then log it with: climb.py review")


def cmd_holdout(args):
    folder = resolve(args.name)
    card = load(folder)
    if not card["holdout"]:
        raise Fail("This climb has no holdout check.")
    print(f"Holdout {number(run_holdout(folder, card, args.why))}, visible best {number(card['best']['score'])}.")


def cmd_raise(args):
    folder = resolve(args.name)
    card = load(folder)
    if not reached(card, card["best"]["score"]):
        raise Fail("Reach the current bar before you raise it.")
    old = card["target"]
    card["target"] = bar(args.target, card["best"]["score"], card["direction"])
    if reached(card, card["best"]["score"]):
        raise Fail("The new bar is already met. Pick a harder one.")
    save(folder, card)
    append(folder, {"kind": "raise", "why": f"bar {number(old)} -> {number(card['target'])}: {args.why}"})
    print(f"Bar raised to {number(card['target'])}.")


def cmd_relock(args):
    own_worktree()
    folder = resolve(args.name)
    card = load(folder)
    if not card["lock"]:
        raise Fail("This climb locks no files.")
    stray = outside(changed_files(), card["lock"])
    if stray:
        raise Fail("Relock changes only the locked check files. Undo or try these first: " + ", ".join(stray[:5]))
    failed = failing_guards(card["guards"], card["timeout"])
    if failed:
        raise Fail(f"A guard fails with the changed check: {failed[0]}\n{failed[1]}")
    commit(f"climb({card['name']}): fix the check\n\n{args.why}")
    score, _, _ = measure(card["check"], card["runs"], card["timeout"], folder / "best.txt", card["score"])
    card["fingerprint"] = fingerprint(card["lock"])
    card["best"] = {"score": score, "commit": git("rev-parse", "HEAD"), "step": len([r for r in rows(folder) if r["kind"] == "step"])}
    save(folder, card)
    append(folder, {"kind": "relock", "why": args.why, "score": score})
    print(f"Check relocked. New best {number(score)} measured with the changed check.")


def cmd_budget(args):
    folder = resolve(args.name)
    card = load(folder)
    if args.off:
        card["max_hours"] = card["max_steps"] = None
    if args.hours:
        card["max_hours"] = round(hours(card) + args.hours, 2)
    if args.steps:
        card["max_steps"] = len([row for row in rows(folder) if row["kind"] == "step"]) + args.steps
    save(folder, card)
    limits = [f"{number(card['max_hours'])} hours" if card.get("max_hours") else "",
              f"{card['max_steps']} steps" if card["max_steps"] else ""]
    text = " and ".join(item for item in limits if item) or "no limit"
    append(folder, {"kind": "budget", "why": text})
    print(f"Budget now {text}.")


def cmd_review(args):
    folder = resolve(args.name)
    steps = [row for row in rows(folder) if row["kind"] == "step"]
    append(folder, {"kind": "review", "step": len(steps), "why": args.found})
    print(f"Review logged after step {len(steps)}. Climb at least {PLATEAU} more steps before the next one.")


def cmd_drop(args):
    folder = resolve(args.name)
    card = load(folder)
    if dirty():
        raise Fail("Commit or undo the current edit first.")
    if card["branch"] == card["base"]:
        raise Fail("This climb ran on its own base branch, so there is nothing to switch back to. Remove its card by hand.")
    kept = f"{card['branch']}-dropped-{time.strftime('%Y%m%d%H%M%S')}"
    git("switch", "-q", card["base"])
    git("branch", "-m", card["branch"], kept)
    mine = [lock for lock in card["lock"] if git("ls-tree", "-r", "--name-only", kept, "--", lock)]
    if mine:
        git("checkout", kept, "--", *mine)
        git("reset", "-q", "--", *mine)
    for name in ("card.json", "log.jsonl"):
        (folder / name).unlink(missing_ok=True)
    print(f"Dropped {card['name']}. Back on {card['base']}. The old climb is on branch {kept}.")
    if mine:
        print("The check files are back in the tree, uncommitted, ready for a new init: " + ", ".join(mine))


def cmd_list(args):
    for path in sorted(climbs_dir().glob("*/card.json")):
        card = json.loads(path.read_text())
        print(f"{card['name']:<20} {card['branch']:<28} {number(card['baseline'])} -> {number(card['best']['score'])}  {card['goal']}")


def parse(argv):
    parser = argparse.ArgumentParser(prog="climb.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="write the card, measure the baseline, start the branch")
    init.add_argument("name")
    init.add_argument("--goal", required=True)
    init.add_argument("--check", action="append", required=True,
                      help="command that prints the score (repeatable: they run at once and their scores add)")
    init.add_argument("--score", action="append",
                      help="regex for the score in the check output, like '(\\d+) failed'; one for all checks or one per check; the matches on the last matching line add up, no match is 0")
    init.add_argument("--direction", choices=["max", "min"], required=True)
    init.add_argument("--guard", action="append", help="command that must exit 0 (repeatable)")
    init.add_argument("--target", help="the bar that means done, a number or a factor like 2x")
    init.add_argument("--after", choices=["stop", "raise"], default="stop", help="what to do at the bar")
    init.add_argument("--runs", type=int, default=1, help="runs per score, median wins, plus one warm-up run")
    init.add_argument("--min-gain", default="0", help="smallest change that counts, a number or a percent like 2%%")
    init.add_argument("--timeout", type=int, default=1800, help="seconds per check run")
    init.add_argument("--holdout", help="check on cases the climber never sees")
    init.add_argument("--lock", action="append", help="file or folder the climber may not edit")
    init.add_argument("--max-steps", type=int, help="soft limit: past it, steps go on while they still gain")
    init.add_argument("--max-hours", type=float, help="soft limit in hours since init, like --max-steps")
    init.add_argument("--hard", action="store_true", help="stop exactly at --max-steps and --max-hours")
    init.add_argument("--paired", action="store_true",
                      help="score each step against the best commit in alternating runs, for checks the machine's load moves")
    init.add_argument("--here", action="store_true", help="climb on the current branch")

    attempt = sub.add_parser("try", help="score the current edit, keep it or undo it")
    attempt.add_argument("idea")
    attempt.add_argument("--fix", action="store_true", help="keep a fix that holds the score, for a break the guards missed")
    attempt.add_argument("--name")

    status = sub.add_parser("status", help="where the climb stands")
    status.add_argument("name", nargs="?")
    status.add_argument("--last", type=int, default=10)

    holdout = sub.add_parser("holdout", help="run the holdout check now")
    holdout.add_argument("name", nargs="?")
    holdout.add_argument("--why", default="milestone")

    bump = sub.add_parser("raise", help="set a harder bar after reaching this one")
    bump.add_argument("target", help="a number or a factor like 2x over the current best")
    bump.add_argument("--why", required=True)
    bump.add_argument("--name")

    relock = sub.add_parser("relock", help="accept a fixed check and measure again")
    relock.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    relock.add_argument("--why", required=True)
    relock.add_argument("--name")

    budget = sub.add_parser("budget", help="give more hours or steps, or remove the limits")
    budget.add_argument("--hours", type=float, help="hours from now")
    budget.add_argument("--steps", type=int, help="steps from now")
    budget.add_argument("name", nargs="?", default=argparse.SUPPRESS)
    budget.add_argument("--off", action="store_true", help="remove both limits")
    budget.add_argument("--name")

    review = sub.add_parser("review", help="log a blocker review and what it found")
    review.add_argument("found")
    review.add_argument("--name")

    drop = sub.add_parser("drop", help="abandon a climb, go back to the base branch, keep the old branch")
    drop.add_argument("name", nargs="?")

    sub.add_parser("list", help="show every climb in this checkout")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse(argv)
    try:
        os.chdir(repo())
        held = None if args.command in ("status", "list") else hold_lock()
    except Fail as error:
        print(error, file=sys.stderr)
        return 1
    handlers = {
        "init": cmd_init, "try": cmd_try, "status": cmd_status, "holdout": cmd_holdout, "raise": cmd_raise,
        "relock": cmd_relock, "review": cmd_review, "budget": cmd_budget, "drop": cmd_drop, "list": cmd_list,
    }
    try:
        handlers[args.command](args)
    except (Fail, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
