import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx
from sections_runtime import LocalControl
from sections_v3_runtime import asset_identity, cached, check_packets, decode_frames, remember, stage_cached


class CacheTests(unittest.TestCase):
    def test_changed_object_version_and_size_cannot_reuse_a_source(self):
        asset = {"key": "edit/originals/a.mp4", "etag": "version-one", "size": 8, "url": "https://r2/a?old"}
        identity = asset_identity(asset)
        self.assertEqual(identity, asset_identity({**asset, "url": "https://r2/a?new"}))
        for field, value in [("etag", "version-two"), ("size", 9), ("key", "edit/originals/b.mp4")]:
            self.assertNotEqual(identity, asset_identity({**asset, field: value}))

    def test_same_size_corruption_and_wrong_version_are_cache_misses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, dest = root / "source", root / "cached.mp4"
            source.write_bytes(b"complete")
            remember(source, dest, "key")
            self.assertIsNotNone(cached(dest, "key"))
            self.assertIsNone(cached(dest, "other-key"))
            dest.write_bytes(b"corrupt!")
            self.assertIsNone(cached(dest, "key"))
            self.assertEqual(source.read_bytes(), b"complete")

    def test_warm_sources_make_no_network_calls_and_a_changed_etag_downloads_again(self):
        fetched = []

        def respond(request):
            fetched.append(str(request.url))
            return httpx.Response(200, headers={"etag": request.headers["if-match"]}, content=b"data")

        asset = {"media": "m", "key": "edit/originals/m.mp4", "etag": "one", "size": 4, "url": "https://r2.test/a"}
        with tempfile.TemporaryDirectory() as temporary, httpx.Client(transport=httpx.MockTransport(respond)) as client:
            root = Path(temporary)
            for i, version in enumerate(["one", "one", "two"]):
                folder = root / str(i)
                folder.mkdir()
                paths, _, result = stage_cached([{**asset, "etag": version}], folder, root / "cache", client, LocalControl("test", 10))
                self.assertEqual(Path(paths["m"]).read_bytes(), b"data")
                self.assertEqual(result["hits"], int(i == 1))
        self.assertEqual(len(fetched), 2)

    def test_full_packet_checks_reject_missing_duplicate_or_nonmonotonic_timestamps(self):
        class Result:
            stdout = "0.000000,-0.033333\n0.033333,0.000000\n0.066667,0.033333\n"
        with patch("sections_v3_runtime.subprocess.run", return_value=Result()):
            self.assertEqual(check_packets(Path("output.mp4"), 3, 30)["frames"], 3)
        for raw in ["0,0\n0,0.033333\n0.066667,0.066667\n", "0,0\n0.033333,0\n0.066667,1\n", "0,0\n"]:
            result = Result()
            result.stdout = raw
            with patch("sections_v3_runtime.subprocess.run", return_value=result), self.assertRaises(RuntimeError):
                check_packets(Path("output.mp4"), 3, 30)


class DecodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("bun"):
            raise unittest.SkipTest("Bun resolves Edit's FFmpeg tools")
        app = Path(__file__).resolve().parents[2]
        tools = json.loads(subprocess.check_output(["bun", "-e", 'import {ffmpeg,ffprobe} from "./apps/server/src/tools.ts"; console.log(JSON.stringify({ffmpeg:ffmpeg(),ffprobe:ffprobe()}));'], cwd=app, text=True))
        cls.temporary = tempfile.TemporaryDirectory(prefix="edit-v3-test-")
        cls.root = Path(cls.temporary.name)
        cls.video = cls.root / "output.mp4"
        cls.tools = tools
        subprocess.run([tools["ffmpeg"], "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=4.1",
                        "-c:v", "libx264", "-g", "30", "-bf", "2", str(cls.video)], check=True, timeout=15)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_command(self, args, *rest, **kwargs):
        from runtime import command
        return command([self.tools.get(args[0], args[0]), *args[1:]], *rest, **kwargs)

    def test_all_odd_length_ranges_decode_with_both_sides_of_every_join(self):
        from sections_runtime import ranges
        with patch("sections_v3_runtime.command", self.run_command):
            for a, b in ranges(0, 123, 8):
                expected = (max(0, a - 2), min(123, b + 2))
                result = decode_frames(self.video, expected, 30, LocalControl("test", 10), self.root)
                self.assertEqual(result["frames"], expected[1] - expected[0])

    def test_a_short_or_truncated_stream_cannot_pass_a_full_range(self):
        with patch("sections_v3_runtime.command", self.run_command), self.assertRaises(RuntimeError):
            decode_frames(self.video, (120, 130), 30, LocalControl("test", 10), self.root)


if __name__ == "__main__":
    unittest.main()
