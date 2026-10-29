"""The export and review drivers run in the cloud, for an Edit installed on
anyone's Mac (the relay starts them; export_v3.py runs the same on a
developer's Mac): R2's keys come from the app's Modal secret, the export
stays in R2 where Edit archives it, and the review copy is made beside it.
Nothing goes through the Mac that asked."""
import os
import time

import boto3
from botocore.config import Config
import modal

PARTS = 512  # 32 MiB each: the 16 GiB output limit (sections_runtime.MAX_OUTPUT).
SECTIONS = 8
PHASES = {"staged": .10, "planned": .12, "picture_finished": .74, "assembled": .78, "verified": .86, "uploaded": .90}


def storage():
    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 2}))
    return s3, bucket


def export(job, coordinate, progress, build):
    """The whole edit rendered on the sections pool and kept in R2 at job["key"]."""
    s3, bucket = storage()
    name, project, key = job["id"], job["project"], job["key"]
    if not key.startswith("edit/exports/"):
        raise ValueError("An export is kept under edit/exports/")
    assets = []
    for media in project["media"]:
        original = (media.get("cloud") or {}).get("original")
        if not original:
            raise RuntimeError(f"{media.get('name', media['id'])} isn't in the cloud")
        head = s3.head_object(Bucket=bucket, Key=original)
        assets.append({"media": media["id"], "etag": head["ETag"], "size": head["ContentLength"], "key": original,
                       "url": s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": original}, ExpiresIn=6 * 3600)})
        media["path"] = "asset:" + media["id"]
    upload = {"Bucket": bucket, "Key": key, "UploadId": s3.create_multipart_upload(Bucket=bucket, Key=key, ContentType="video/mp4")["UploadId"]}
    try:
        urls = [s3.generate_presigned_url("upload_part", Params={**upload, "PartNumber": i}, ExpiresIn=6 * 3600) for i in range(1, PARTS + 1)]
        call = coordinate.spawn({"id": name, "project": project, "assets": assets, "upload_urls": urls, "sections": SECTIONS, "options": job["options"]})
        progress({"phase": "queued", "progress": .03})
        while True:
            try:
                receipt = call.get(timeout=2)
                break
            except TimeoutError:
                pass
        if receipt.get("build") != build:
            raise RuntimeError("The cloud exporter changed while this export ran; export again")
        s3.complete_multipart_upload(**upload, MultipartUpload={"Parts": receipt["upload"]["parts"]})
    except BaseException:
        try:
            s3.abort_multipart_upload(**upload)
        except Exception:
            pass
        raise
    head = s3.head_object(Bucket=bucket, Key=key)
    if head["ContentLength"] != receipt["upload"]["size"]:
        raise RuntimeError("The published file's length doesn't match the checked one")
    rendered = [one for one in receipt["sections"] if not one.get("cached")]
    return {"bytes": head["ContentLength"], "sha256": receipt["sha256"], "key": key, "sections": len(receipt["sections"]),
            "rendered": len(rendered), "sound_cached": receipt.get("sound_cached")}


def review(job, make):
    """A review copy, poster and waveform made from an export kept in R2, and the export copied to the review's own key."""
    s3, bucket = storage()
    for field in ["source_key", "review_key", "poster_key", "full_key"]:
        if not job[field].startswith("edit/"):
            raise ValueError("Review files are kept under edit/")
    sign = lambda method, key: s3.generate_presigned_url(method, Params={"Bucket": bucket, "Key": key}, ExpiresIn=6 * 3600)
    fps, frames = float(job["fps"]), int(job["frames"])
    count = max(1, min(24, round(frames / fps / 180)))
    step = -(-frames // count)
    temp = f"edit/reviews/tmp/{job['id']}"
    pieces = [{"start": at / fps, "frames": min(step, frames - at), "put": sign("put_object", f"{temp}/{i:03d}.mp4"),
               "get": sign("get_object", f"{temp}/{i:03d}.mp4")} for i, at in enumerate(range(0, frames, step))]
    started = time.monotonic()
    upload = {"Bucket": bucket, "Key": job["review_key"], "UploadId": s3.create_multipart_upload(Bucket=bucket, Key=job["review_key"], ContentType="video/mp4")["UploadId"]}
    try:
        parts = [s3.generate_presigned_url("upload_part", Params={**upload, "PartNumber": i}, ExpiresIn=6 * 3600) for i in range(1, 161)]
        result = make({"source": sign("get_object", job["source_key"]), "pieces": pieces, "video_put": sign("put_object", job["review_key"]),
                       "video_parts": parts, "poster_put": sign("put_object", job["poster_key"]), "poster_second": float(job["poster_second"])})
        s3.complete_multipart_upload(**upload, MultipartUpload={"Parts": result.pop("parts")})
    except BaseException:
        try:
            s3.abort_multipart_upload(**upload)
        except Exception:
            pass
        raise
    s3.copy({"Bucket": bucket, "Key": job["source_key"]}, bucket, job["full_key"])
    try:
        listed = s3.list_objects_v2(Bucket=bucket, Prefix=temp + "/")
        if listed.get("Contents"):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": one["Key"]} for one in listed["Contents"]]})
    except Exception:
        pass
    return {**result, "pieces": len(pieces), "seconds": time.monotonic() - started}
