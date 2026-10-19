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
import build
from sections_runtime import LocalControl
from runtime import transfer
from fractions import Fraction
from sections_runtime import rate
from sections_v3_runtime import asset_identity, cached, check_options, check_packets, decode_frames, remember, stage_cached, upload_parts


class CacheTests(unittest.TestCase):
    def test_transfer_retries_are_bounded_and_authorization_errors_are_not_retried(self):
        attempts = []

        def stalled():
            attempts.append(1)
            raise httpx.WriteTimeout("fixture")

        with patch("runtime.time.sleep"), self.assertRaises(httpx.WriteTimeout):
            transfer(stalled, LocalControl("test", 10), retries=2)
        self.assertEqual(len(attempts), 3)
        attempts.clear()

        def denied():
            attempts.append(1)
            request = httpx.Request("PUT", "https://r2.test/part")
            httpx.Response(403, request=request).raise_for_status()

        with self.assertRaises(httpx.HTTPStatusError):
            transfer(denied, LocalControl("test", 10), retries=2)
        self.assertEqual(len(attempts), 1)

    def test_transfer_deployments_keep_engine_cache_keys_but_engine_changes_invalidate_them(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(build, "ROOT", Path(temporary)):
            root = Path(temporary)
            (root / "Cargo.toml").write_text("workspace")
            (root / "Cargo.lock").write_text("locked")
            (root / "apps/worker").mkdir(parents=True)
            worker = root / "apps/worker/runtime.py"
            worker.write_text("transfer v1")
            old, engine = build.build_id(), build.engine_id()
            worker.write_text("transfer v2")
            self.assertNotEqual(old, build.build_id())
            self.assertEqual(engine, build.engine_id())
            (root / "crates/edit-engine/src").mkdir(parents=True)
            (root / "crates/edit-engine/src/render.rs").write_text("new compositor")
            self.assertNotEqual(engine, build.engine_id())

    def test_upload_retries_only_the_failed_idempotent_part_with_identical_bytes(self):
        attempts, bodies = {}, {}

        def respond(request):
            part = int(request.url.path[1:])
            attempts[part] = attempts.get(part, 0) + 1
            bodies.setdefault(part, []).append(request.content)
            if part == 1 and attempts[part] == 1:
                raise httpx.WriteTimeout("fixture stalled write", request=request)
            return httpx.Response(200, headers={"etag": str(part)})

        with tempfile.TemporaryDirectory() as temporary, patch("sections_v3_runtime.PART_BYTES", 4), httpx.Client(transport=httpx.MockTransport(respond)) as client:
            path = Path(temporary) / "video.mp4"
            path.write_bytes(b"abcdefghij")
            result = upload_parts(path, [f"https://r2.test/{i}" for i in range(3)], client, LocalControl("test", 10))
        self.assertEqual(attempts, {0: 1, 1: 2, 2: 1})
        self.assertEqual(bodies[1], [b"efgh", b"efgh"])
        self.assertEqual([p["PartNumber"] for p in result["parts"]], [1, 2, 3])
        self.assertEqual(result["transfers"][1]["attempts"], 2)

    def test_source_transfer_retry_preserves_the_etag_and_publishes_only_complete_bytes(self):
        attempts = []

        def respond(request):
            attempts.append(request.headers["if-match"])
            if len(attempts) == 1:
                raise httpx.ReadTimeout("fixture stalled read", request=request)
            return httpx.Response(200, headers={"etag": "one"}, content=b"data")

        asset = {"media": "m", "key": "edit/originals/m.mp4", "etag": "one", "size": 4, "url": "https://r2.test/a"}
        with tempfile.TemporaryDirectory() as temporary, httpx.Client(transport=httpx.MockTransport(respond)) as client:
            root = Path(temporary)
            paths, _, _ = stage_cached([asset], root, root / "cache", client, LocalControl("test", 10))
            self.assertEqual(Path(paths["m"]).read_bytes(), b"data")
        self.assertEqual(attempts, ["one", "one"])

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


class OptionsTests(unittest.TestCase):
    def test_an_ntsc_timeline_runs_at_its_real_rate(self):
        self.assertEqual(rate({"fps": 24, "ntsc": True}), Fraction(24000, 1001))
        self.assertEqual(rate({"fps": 30}), 30)

    def test_the_house_export_is_accepted_and_anything_else_is_a_local_export(self):
        settings = {"width": 1920, "height": 1080, "fps": 24, "ntsc": True}
        house = {"format": "h264", "shape": "original", "fill": "blur", "size": None, "fps": None, "quality": "high",
                 "target_mb": None, "hardware": True, "wait_for_smoothing": False, "audio": True, "loudness": -14,
                 "range": [0, 500], "chapters": []}
        self.assertIsNone(check_options(house, settings, 500)["range"])
        self.assertEqual(check_options({**house, "size": 1080, "loudness": None}, settings, 500)["loudness"], None)
        for change in [{"format": "hevc"}, {"shape": "vertical"}, {"size": 720}, {"fps": 60}, {"target_mb": 50},
                       {"range": [0, 400]}, {"audio": False}, {"chapters": [{"start": 0, "title": "One"}]}]:
            with self.assertRaises(ValueError):
                check_options({**house, **change}, settings, 500)

    def test_ntsc_packets_lie_on_their_own_grid(self):
        class Result:
            stdout = "0.000000,-0.041708\n0.041708,0.000000\n0.083417,0.041708\n"
        with patch("sections_v3_runtime.subprocess.run", return_value=Result()):
            self.assertEqual(check_packets(Path("output.mp4"), 3, Fraction(24000, 1001))["frames"], 3)
            with self.assertRaises(RuntimeError):
                check_packets(Path("output.mp4"), 3, 24)


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

    def test_ntsc_ranges_decode_exactly(self):
        video = self.root / "ntsc.mp4"
        subprocess.run([self.tools["ffmpeg"], "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=24000/1001:d=4.2",
                        "-c:v", "libx264", "-g", "24", "-bf", "2", str(video)], check=True, timeout=15)
        from sections_runtime import ranges
        with patch("sections_v3_runtime.command", self.run_command):
            for a, b in ranges(0, 100, 8):
                expected = (max(0, a - 2), min(100, b + 2))
                result = decode_frames(video, expected, "24000/1001", LocalControl("test", 10), self.root)
                self.assertEqual(result["frames"], expected[1] - expected[0])

    def test_a_short_or_truncated_stream_cannot_pass_a_full_range(self):
        with patch("sections_v3_runtime.command", self.run_command), self.assertRaises(RuntimeError):
            decode_frames(self.video, (120, 130), 30, LocalControl("test", 10), self.root)


if __name__ == "__main__":
    unittest.main()
