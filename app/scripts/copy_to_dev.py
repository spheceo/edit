#!/usr/bin/env python3
"""Copies one cloud project from prod into dev, so a dev build can work on a
real project without touching the team's (Oct 31: dev and prod split, "copy
real projects in for testing"):

    just copy-to-dev --list              prod's projects, newest first
    just copy-to-dev <project id|name>   copy it (again: dev's copy is replaced)
    just copy-to-dev <...> --dry-run     what it would copy, nothing written

What goes: the project's body (Convex file storage), its footage's registry
rows (`editMedia`), and on R2 every key the body names (originals, excerpts,
proxies), each footage's original and proxy, the analysis beside them that
costs money to redo (`edit/analysis/…`: transcripts, faces, seats, the
watcher's answers), a pieced proxy's folder (`edit/pieces/…`: its layout and
pieces) and the project's research (`edit/research/projects/<id>/`).
R2 objects already in dev with the same size are skipped, so copying again
is quick. Prod is only read; nothing in it changes.

Settings come from Infisical (Platform, `/edit-relay`, prod and dev) into
memory, as push-secrets.ts does: no value in an argument, a file or a log.
"""
import json
import re
import subprocess
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
import httpx

PROJECT = "979fe56c-c4d0-4809-b64f-5ebc75eeaf05"
HOLDER = "copy-to-dev"


def settings(environment):
    out = subprocess.run(["infisical", "export", f"--projectId={PROJECT}", f"--env={environment}", "--path=/edit-relay",
                          "--format=json", "--silent"], check=True, capture_output=True, text=True).stdout
    return {one["key"]: one["value"] for one in json.loads(out)}


class Convex:
    def __init__(self, env):
        self.url = env["CONVEX_URL"].rstrip("/")
        self.token = env["CONVEX_SERVICE_TOKEN"]

    def call(self, kind, path, **args):
        answer = httpx.post(f"{self.url}/api/{kind}", json={"path": path, "args": {"token": self.token, **args}, "format": "json"},
                            timeout=120).json()
        if answer.get("status") != "success":
            raise RuntimeError(f"{path}: {answer.get('errorMessage', answer)}")
        return answer["value"]


def r2(env):
    return boto3.client("s3", endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", region_name="auto",
                        aws_access_key_id=env["R2_ACCESS_KEY_ID"], aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
                        config=Config(retries={"max_attempts": 5, "mode": "standard"}))


def size_of(s3, bucket, key):
    try:
        return s3.head_object(Bucket=bucket, Key=key)["ContentLength"]
    except ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def listed(s3, bucket, prefix):
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for one in page.get("Contents", []):
            yield one["Key"]


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    dry = "--dry-run" in sys.argv
    prod_env, dev_env = settings("prod"), settings("dev")
    if prod_env["CONVEX_URL"] == dev_env["CONVEX_URL"] or prod_env["R2_BUCKET"] == dev_env["R2_BUCKET"]:
        raise SystemExit("Infisical dev /edit-relay still points at prod's Convex or bucket: nothing copied")
    prod, dev = Convex(prod_env), Convex(dev_env)
    projects = prod.call("query", "edit:listProjects")
    if "--list" in sys.argv or not args:
        for one in projects:
            print(f"{one['projectId']}  {one['name']}")
        return
    wanted = args[0]
    matches = [one for one in projects if one["projectId"] == wanted] or \
              [one for one in projects if wanted.lower() in one["name"].lower()]
    if len(matches) != 1:
        raise SystemExit(f"{len(matches)} prod projects match {wanted!r}: " + ", ".join(one["name"] for one in matches[:8]))
    card = matches[0]
    project_id = card["projectId"]
    found = prod.call("query", "edit:getProject", projectId=project_id)
    body = httpx.get(found["bodyUrl"], timeout=600).content
    text = body.decode()
    sources = sorted(set(re.findall(r'"((?:drive|sha256|youtube):[^"]+)"', text)))
    rows = []
    for at in range(0, len(sources), 100):
        rows += prod.call("query", "edit:listMedia", sources=sources[at:at + 100])

    src_s3, dst_s3 = r2(prod_env), r2(dev_env)
    src_bucket, dst_bucket = prod_env["R2_BUCKET"], dev_env["R2_BUCKET"]
    keys = set(re.findall(r'"(edit/[^"]+)"', text + json.dumps(found.get("summary"))))
    prefixes = [f"edit/research/projects/{project_id}/"]
    for row in rows:
        keys.update(key for key in (row.get("originalKey"), row.get("proxyKey")) if key)
        proxy = row.get("proxyKey") or ""
        if proxy.startswith("edit/proxies/") and proxy.endswith(".mp4"):
            prefixes.append("edit/analysis/" + proxy[len("edit/proxies/"):-len(".mp4")] + "/")
    # A pieced proxy (`edit/pieces/v3/<kind>/<id>/proxy.mp4`) is its folder: the layout and the pieces made so far
    # (Killer Pastor, Nov 8: without its layout.json dev asked for it again and again and the footage never played).
    for key in list(keys):
        if key.startswith("edit/pieces/") and key.endswith("/proxy.mp4"):
            prefixes.append(key[: -len("proxy.mp4")])
    for prefix in prefixes:
        keys.update(listed(src_s3, src_bucket, prefix))
    keys = sorted(key for key in keys if key.startswith("edit/") and ".." not in key)
    print(f"{card['name']} ({project_id}): {len(sources)} sources, {len(rows)} registered, {len(keys)} R2 objects")

    copied = skipped = missing = 0
    copied_bytes = 0
    for key in keys:
        size = size_of(src_s3, src_bucket, key)
        if size is None:
            missing += 1
            continue
        if size_of(dst_s3, dst_bucket, key) == size:
            skipped += 1
            continue
        if not dry:
            stream = src_s3.get_object(Bucket=src_bucket, Key=key)["Body"]
            dst_s3.upload_fileobj(stream, dst_bucket, key)
        copied += 1
        copied_bytes += size
        print(f"  {'would copy' if dry else 'copied'} {key} ({size / 1e6:.1f} MB)", flush=True)
    print(f"R2: {copied} {'to copy' if dry else 'copied'} ({copied_bytes / 1e9:.2f} GB), {skipped} already in dev, {missing} not in prod")
    if dry:
        return

    for row in rows:
        fields = {name: row[name] for name in ("name", "originalKey", "originalReady", "proxyKey", "proxyReady", "size", "duration")
                  if row.get(name) is not None}
        dev.call("mutation", "edit:putMedia", source=row["source"], **fields)
    lock = dev.call("mutation", "edit:acquireLock", projectId=project_id, holder=HOLDER, force=True)
    dev.call("mutation", "edit:deleteProject", projectId=project_id, lockToken=lock["token"])
    lock = dev.call("mutation", "edit:acquireLock", projectId=project_id, holder=HOLDER, force=True)
    upload = dev.call("mutation", "edit:uploadUrl")
    stored = httpx.post(upload, content=body, headers={"content-type": "application/json"}, timeout=600).json()["storageId"]
    commit = {"projectId": project_id, "baseRev": 0, "storageId": stored, "name": card["name"], "summary": found.get("summary"),
              "holder": HOLDER, "lockToken": lock["token"]}
    if card.get("createdBy"):
        commit["actor"] = {name: card["createdBy"][name] for name in ("sub", "name", "email", "picture") if card["createdBy"].get(name)}
    dev.call("mutation", "edit:commitProject", **commit)
    dev.call("mutation", "edit:releaseLock", projectId=project_id, lockToken=lock["token"])
    print(f"Convex: {len(rows)} footage rows and the project's body are in dev; open it in `just dev`")


if __name__ == "__main__":
    main()
