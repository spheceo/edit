import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mac_benchmark", Path(__file__).with_name("benchmark-mac-sections.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class MacBenchmarkTests(unittest.TestCase):
    def test_stop_terminates_only_the_benchmarks_process_group(self):
        peer = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(benchmark, "pressure", return_value=1), patch.object(benchmark, "other_media", return_value=[]):
                folder = Path(directory)
                runner = benchmark.Runner(folder, Path(sys.executable), {"ffmpeg": "ffmpeg", "ffprobe": "ffprobe"})
                errors = []

                def work():
                    try:
                        runner.command([sys.executable, "-c", "import time; time.sleep(60)"], folder, "test", 30)
                    except RuntimeError as error:
                        errors.append(str(error))

                thread = threading.Thread(target=work)
                thread.start()
                deadline = time.monotonic() + 3
                while not runner.processes and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(runner.processes)
                runner.stop()
                thread.join(timeout=6)
                self.assertFalse(thread.is_alive())
                self.assertTrue(errors)
                self.assertIsNone(peer.poll())
                self.assertFalse(runner.processes)
        finally:
            peer.terminate()
            peer.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
