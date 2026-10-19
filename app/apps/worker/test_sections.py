import copy
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import httpx
from sections_runtime import LocalControl, check_picture, parallel_upload, ranges


class SectionTests(unittest.TestCase):
    def test_odd_lengths_and_nonzero_starts_cover_every_frame_once(self):
        for start, end, count in [(0, 51958, 8), (0, 34987, 8), (113, 128, 4), (17, 18, 1)]:
            spans = ranges(start, end, count)
            self.assertEqual([frame for a, b in spans for frame in range(a, b)], list(range(start, end)))
            self.assertLessEqual(max(b - a for a, b in spans) - min(b - a for a, b in spans), 1)

    def test_empty_sections_or_unbounded_fanout_are_rejected(self):
        for values in [(0, 7, 8), (0, 30, 9), (3, 3, 1), (-1, 10, 2)]:
            with self.assertRaises(ValueError):
                ranges(*values)

    def probe(self):
        return {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                             "nb_frames": "90", "avg_frame_rate": "30/1", "duration": "3.000000", "start_time": "0"},
                            {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2,
                             "duration": "3.000000", "start_time": "0"}]}

    def test_missing_frames_timing_drift_and_audio_priming_shift_fail(self):
        found = self.probe()
        check_picture(found, 90, 1920, 1080, 30, True)
        for stream, key, value in [(0, "nb_frames", "89"), (0, "start_time", "0.033333"),
                                   (0, "avg_frame_rate", "30000/1001"), (1, "start_time", "0.021333"),
                                   (1, "duration", "2.9")]:
            changed = copy.deepcopy(found)
            changed["streams"][stream][key] = value
            with self.assertRaises(RuntimeError):
                check_picture(changed, 90, 1920, 1080, 30, True)

    def test_video_only_sections_cannot_carry_duplicate_audio(self):
        with self.assertRaises(RuntimeError):
            check_picture(self.probe(), 90, 1920, 1080, 30, False)

    def test_parallel_parts_are_exact_and_completion_order_is_numeric(self):
        barrier = threading.Barrier(3)
        received = {}

        def handle(request):
            received[int(request.url.path[1:])] = request.content
            barrier.wait(timeout=3)
            return httpx.Response(200, headers={"etag": request.url.path[1:]})

        with tempfile.TemporaryDirectory() as temporary, patch("sections_runtime.PART_BYTES", 4):
            path = Path(temporary) / "output.mp4"
            path.write_bytes(b"abcdefghij")
            with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                result = parallel_upload(path, [f"https://r2.test/{i}" for i in range(3)], client, LocalControl("test", 10))
        self.assertEqual(received, {0: b"abcd", 1: b"efgh", 2: b"ij"})
        self.assertEqual(result, {"size": 10, "parts": [{"PartNumber": i + 1, "ETag": str(i)} for i in range(3)]})


if __name__ == "__main__":
    unittest.main()
