#!/usr/bin/env python3
"""Create a synthetic playback fixture in an isolated running Edit server."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:7711")
    parser.add_argument("--ui", default="http://localhost:5174")
    parser.add_argument("--directory", type=Path, default=Path("/tmp/edit-preview-test"))
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    source = (args.directory / "cuts.mp4").resolve()
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1",
        "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p",
        str(source),
    ], check=True)

    def request(path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(args.server + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    live = request("/api/projects", {"name": "Playback regression", "width": 320, "height": 180, "fps": 30})
    project_id = live["project"]["id"]
    request(f"/api/projects/{project_id}/import", {"paths": [str(source)], "place": True})
    live = request(f"/api/projects/{project_id}")
    project = live["project"]
    first = next(clip for clip in project["clips"] if clip["type"] == "video")
    first["duration"] = 20
    second = copy.deepcopy(first)
    second.update(id="c-preview-second", start=20, source_in=1)
    project["clips"].append(second)
    request(f"/api/projects/{project_id}", {"base_rev": live["rev"], "project": project, "origin": "preview-test"}, "PUT")
    print(f"{args.ui}/tests/preview.html?project={project_id}")


if __name__ == "__main__":
    main()
