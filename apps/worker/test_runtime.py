import os
from pathlib import Path
import tempfile
import threading
import subprocess
import unittest
from unittest.mock import patch

import httpx
from runtime import Control, Stop, download, stage, upload, terminate


class RuntimeTests(unittest.TestCase):
    def test_cancelling_one_export_leaves_its_peer_process_running(self):
        import sys
        first = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        second = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        stop = Stop()
        stop.watch(first)
        try:
            stop.request()
            first.wait(timeout=3)
            self.assertIsNotNone(first.returncode)
            self.assertIsNone(second.poll())
        finally:
            terminate(first); terminate(second)

    def control(self, handler):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        with patch.dict(os.environ, {"EDIT_RELAY_URL": "https://relay.test", "MODAL_WORKER_TOKEN": "worker"}):
            control = Control({"id": "export-one", "permit": "attempt"}, "build", "L4", client)
        return client, control

    def test_source_is_pinned_and_incomplete_bytes_never_become_an_asset(self):
        def handler(request):
            self.assertEqual(request.headers["if-match"], '"v1"')
            return httpx.Response(200, headers={"etag": '"v2"'}, content=b"new")
        client, control = self.control(handler)
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "asset"
            with self.assertRaisesRegex(RuntimeError, "changed"):
                download({"url": "https://r2.test/file", "etag": '"v1"', "size": 3}, dest, client, control)
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix(".partial").exists())

    def test_truncated_source_is_rejected(self):
        client, control = self.control(lambda request: httpx.Response(200, headers={"etag": '"v1"'}, content=b"x"))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "truncated"):
                download({"url": "https://r2.test/file", "etag": '"v1"', "size": 10}, Path(directory) / "asset", client, control)

    def test_four_downloads_overlap_and_each_media_gets_its_own_bytes(self):
        barrier = threading.Barrier(4)
        def handler(request):
            if request.url.host == "relay.test":
                return httpx.Response(200, json={"ok": True})
            barrier.wait(timeout=2)
            return httpx.Response(200, headers={"etag": '"v1"'}, content=request.url.path[-1:].encode())
        client, control = self.control(handler)
        assets = [{"media": str(i), "url": f"https://r2.test/{i}", "etag": '"v1"', "size": 1} for i in range(4)]
        with tempfile.TemporaryDirectory() as directory:
            paths = stage(assets, Path(directory), client, control)
            self.assertEqual({key: Path(path).read_text() for key, path in paths.items()}, {str(i): str(i) for i in range(4)})

    def test_one_large_file_uses_parallel_ranges_and_assembles_exact_bytes(self):
        source = b"abcdefghijklmno"
        barrier = threading.Barrier(4)
        def handler(request):
            if request.url.host == "relay.test":
                return httpx.Response(200, json={"ok": True})
            self.assertEqual(request.headers["if-match"], '"v1"')
            first, last = map(int, request.headers["range"].removeprefix("bytes=").split("-"))
            barrier.wait(timeout=2)
            return httpx.Response(206, headers={"etag": '"v1"', "content-range": f"bytes {first}-{last}/{len(source)}"},
                                  content=source[first:last + 1])
        client, control = self.control(handler)
        assets = [{"media": "m", "url": "https://r2.test/file", "etag": '"v1"', "size": len(source)}]
        with tempfile.TemporaryDirectory() as directory, patch("runtime.RANGE_THRESHOLD", 1), patch("runtime.RANGE_BYTES", 4):
            paths = stage(assets, Path(directory), client, control)
            self.assertEqual(Path(paths["m"]).read_bytes(), source)
            self.assertFalse(list(Path(directory).glob("*.partial")))

    def test_bad_or_truncated_range_never_publishes_a_sparse_asset(self):
        for status, headers, content, error in [
            (200, {"etag": '"v1"'}, b"data", "wrong byte range"),
            (206, {"etag": '"v1"', "content-range": "bytes 0-2/4"}, b"dat", "wrong byte range"),
            (206, {"etag": '"v1"', "content-range": "bytes 0-3/4"}, b"da", "truncated"),
            (206, {"etag": '"v2"', "content-range": "bytes 0-3/4"}, b"data", "changed"),
        ]:
            with self.subTest(error=error, headers=headers):
                client, control = self.control(lambda request: httpx.Response(200, json={"ok": True})
                                               if request.url.host == "relay.test" else httpx.Response(status, headers=headers, content=content))
                with tempfile.TemporaryDirectory() as directory, patch("runtime.RANGE_THRESHOLD", 1), patch("runtime.RANGE_BYTES", 4):
                    with self.assertRaisesRegex(RuntimeError, error):
                        stage([{"media": "m", "url": "https://r2.test/file", "etag": '"v1"', "size": 4}], Path(directory), client, control)
                    self.assertFalse(list(Path(directory).iterdir()))

    def test_only_verified_uploaded_parts_are_completed(self):
        calls = []
        def handler(request):
            import json
            if request.url.host == "r2.test":
                self.assertEqual(request.content, b"done")
                return httpx.Response(200, headers={"etag": '"part1"'})
            body = json.loads(request.content)
            calls.append((request.url.path.rsplit("/", 1)[-1], body))
            if request.url.path.endswith("/upload"):
                return httpx.Response(200, json={"partSize": 32 * 1024 * 1024, "urls": [{"number": 1, "url": "https://r2.test/part"}]})
            return httpx.Response(200, json={"status": "done"})
        client, control = self.control(handler)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "output.mp4"
            file.write_bytes(b"done")
            self.assertEqual(upload(file, control, client)["status"], "done")
        self.assertEqual(calls[-1][0], "complete")
        self.assertEqual(calls[-1][1]["parts"], [{"number": 1, "etag": '"part1"'}])


if __name__ == "__main__":
    unittest.main()
