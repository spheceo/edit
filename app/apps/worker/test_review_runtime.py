from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import review_runtime


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class ReviewPieceTests(unittest.TestCase):
    def test_a_piece_of_an_export_with_chapters_carries_none(self):
        # Nov 1: the export's chapters ran to its end, Debian's ffmpeg counted
        # them in each piece's length, and an 82-minute review copy was joined
        # 17 hours long. A piece has only its own picture.
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            plain, source = folder / "plain.mp4", folder / "source.mp4"
            (folder / "chapters.txt").write_text(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=A\n"
                                                 "[CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=6000\ntitle=B\n")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "6",
                            "-c:v", "libx264", "-preset", "ultrafast", str(plain)], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(plain), "-f", "ffmetadata", "-i", str(folder / "chapters.txt"),
                            "-map", "0", "-map_chapters", "1", "-c", "copy", str(source)], check=True)
            kept = folder / "piece.mp4"
            with patch.object(review_runtime, "put", lambda url, path, kind: shutil.copy(path, kept)), \
                 patch.object(review_runtime, "run", lambda cmd: review_runtime.subprocess.run(
                     [one if one != "h264_nvenc" else "libx264" for one in cmd], capture_output=True, check=True).stdout):
                review_runtime.piece(str(source), 1.0, 30, "https://r2.test/piece")
            found = subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-show_entries", "stream=codec_type:format=duration",
                                    "-of", "compact", str(kept)], capture_output=True, text=True, check=True).stdout
            self.assertNotIn("chapter", found)
            self.assertNotIn("codec_type=data", found)
            self.assertIn("format|duration=1.000000", found)


class CopyCheckTests(unittest.TestCase):
    def test_a_copy_is_refused_unless_it_plays_as_its_export(self):
        export = {"video": 4948.77, "frames": 148463, "audio": 4948.77}
        self.assertIsNone(review_runtime.copy_problem({"video": 4948.77, "frames": 148463, "audio": 4948.80}, export, 30))
        # Kroger's (Nov 1): every frame there, each piece's last held to the export's end.
        self.assertIn("picture runs 61860.0 s", review_runtime.copy_problem({"video": 61860.0, "frames": 148463, "audio": 4948.77}, export, 30))
        self.assertIn("frames", review_runtime.copy_problem({"video": 4948.77, "frames": 148000, "audio": 4948.77}, export, 30))
        self.assertIn("sound runs", review_runtime.copy_problem({"video": 4948.77, "frames": 148463, "audio": 1590.0}, export, 30))
        self.assertIn("no picture", review_runtime.copy_problem({"video": None, "frames": None, "audio": 4948.77}, export, 30))
        # An export longer than its edit (Off-Duty Officer, Oct 29) still passes: the copy stands for the export.
        long = {"video": 7344.0, "frames": 220320, "audio": 7344.0}
        self.assertIsNone(review_runtime.copy_problem(dict(long), long, 30))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
    def test_lengths_reads_a_real_files_streams(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "a.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i",
                            "sine=r=48000", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(out)], check=True)
            found = review_runtime.lengths(out)
            self.assertEqual(found["frames"], 60)
            self.assertAlmostEqual(found["video"], 2.0, places=1)
            self.assertAlmostEqual(found["audio"], 2.0, delta=0.1)
            self.assertEqual(review_runtime.lengths(Path(folder) / "missing.mp4"), {"video": None, "frames": None, "audio": None})


if __name__ == "__main__":
    unittest.main()
