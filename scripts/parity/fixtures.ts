// The parity run's fixtures: small generated media at fixed absolute paths
// (outside both homes, so the two servers' media keys are the same) with a
// fixed mtime, and copies of real projects from ~/.edit/projects with every
// media remapped onto them (read only; nothing is written to ~/.edit).

import * as fs from "node:fs";
import * as nodePath from "node:path";

/** Bump when a fixture changes: the media and the seed home are made again. */
export const FIXTURE_VERSION = 3;

/** Every fixture file's mtime (media keys cover size and mtime). */
const MTIME = new Date("2026-01-01T00:00:00Z");

export interface Fixtures {
  dir: string;
  /** 1910 s, 320×180, 30 fps testsrc counter with speech-like pink noise: every remapped video. */
  footage: string;
  /** 12 s, 640×360, 30 fps testsrc2 with sound: imports, exports, small edits. */
  short: string;
  /** 370 s of modulated brown noise: every remapped voice-over. */
  voice: string;
  /** 370 s, in a library music folder: every remapped music track. */
  music: string;
  /** 15 s of beeps in an `sfx` folder: every remapped sound effect. */
  sfx: string;
  /** A 1280×720 still: every remapped picture. */
  still: string;
  /** A 4 s tone (an upload's body). */
  tone: string;
  /** Speech for the relay's /v1/speech (an MP3). */
  speech: string;
  /** A small JPEG for research images. */
  photo: string;
}

export function fixturePaths(dir: string): Fixtures {
  return {
    dir,
    footage: nodePath.join(dir, "footage/counter-long.mp4"),
    short: nodePath.join(dir, "footage/short.mp4"),
    voice: nodePath.join(dir, "voice/voice.m4a"),
    music: nodePath.join(dir, "library/music/parity/music.m4a"),
    sfx: nodePath.join(dir, "sfx/beeps.wav"),
    still: nodePath.join(dir, "pictures/still.png"),
    tone: nodePath.join(dir, "upload/tone.m4a"),
    speech: nodePath.join(dir, "relay/speech.mp3"),
    photo: nodePath.join(dir, "relay/photo.jpg"),
  };
}

const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"];

function ffmpeg(args: string[]): void {
  const done = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (done.exitCode !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

/** Makes the fixture media (once per FIXTURE_VERSION). */
export function makeFixtures(dir: string): Fixtures {
  const paths = fixturePaths(dir);
  const stamp = nodePath.join(dir, ".version");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === String(FIXTURE_VERSION)) return paths;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const file of Object.values(paths)) {
    if (file !== dir) fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  }
  const speechy = (_seconds: number, period: number) => `volume='0.35+0.3*sin(2*PI*t/${period})':eval=frame`;
  console.log("parity: making fixture media");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1910",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:amplitude=0.3:duration=1910:seed=7",
    "-af", speechy(1830, 3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-g", "60", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "48k", "-ac", "1", ...BITEXACT, "-shortest", paths.footage,
  ]);
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:amplitude=0.3:duration=12:seed=3",
    "-af", speechy(12, 2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", "-ac", "2", ...BITEXACT, "-shortest", paths.short,
  ]);
  for (const [out, seed] of [
    [paths.voice, 11],
    [paths.music, 13],
  ] as const) {
    ffmpeg([
      "-f", "lavfi", "-i", `anoisesrc=color=brown:sample_rate=48000:amplitude=0.4:duration=370:seed=${seed}`,
      "-af", speechy(370, 1.7), "-c:a", "aac", "-b:a", "48k", "-ac", "1", ...BITEXACT, out,
    ]);
  }
  ffmpeg([
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=15",
    "-af", "volume='if(lt(mod(t,3),0.25),1,0)':eval=frame", ...BITEXACT, paths.sfx,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=1:duration=1", "-frames:v", "1", ...BITEXACT, paths.still]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-c:a", "aac", "-b:a", "64k", ...BITEXACT, paths.tone]);
  ffmpeg([
    "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=44100:amplitude=0.3:duration=6:seed=5",
    "-af", speechy(6, 1.3), "-c:a", "libmp3lame", "-b:a", "64k", ...BITEXACT, paths.speech,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=800x600:rate=1:duration=1", "-frames:v", "1", "-q:v", "4", ...BITEXACT, paths.photo]);
  for (const file of Object.values(paths)) {
    if (file !== dir) fs.utimesSync(file, MTIME, MTIME);
  }
  fs.writeFileSync(stamp, String(FIXTURE_VERSION));
  return paths;
}

export interface Probed {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export function probe(path: string): Probed {
  const out = Bun.spawnSync([
    "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json", path,
  ]).stdout.toString();
  const parsed = JSON.parse(out) as { streams?: { width?: number; height?: number; r_frame_rate?: string }[]; format: { duration: string } };
  const stream = parsed.streams?.[0];
  const [num, den] = (stream?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(parsed.format.duration),
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    fps: den ? num! / den : 0,
  };
}

interface MediaJson {
  id: string;
  name: string;
  path: string;
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  cloud?: unknown;
  [key: string]: unknown;
}

/**
 * A real project (read from ~/.edit/projects, never written) with every media
 * pointed at a fixture: videos at the counter clip (their own size and rate),
 * voice-overs, music and sound effects at the matching sound, pictures at the
 * still. Cloud links are dropped: these are local projects in the seed.
 */
export function remapProject(source: string, fixtures: Fixtures, name: string): Record<string, unknown> {
  const project = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown> & { media: MediaJson[]; name: string };
  const footage = probe(fixtures.footage);
  const still = probe(fixtures.still);
  for (const media of project.media) {
    delete media.cloud;
    if (media.kind === "video") {
      media.path = fixtures.footage;
      media.width = footage.width;
      media.height = footage.height;
      media.fps = footage.fps;
      media.duration = Math.min(media.duration, footage.duration);
      media.has_audio = true;
    } else if (media.kind === "image") {
      media.path = fixtures.still;
      media.width = still.width;
      media.height = still.height;
    } else if (/\/sfx\//.test(media.path)) {
      media.path = fixtures.sfx;
      media.duration = Math.min(media.duration, 15);
    } else if (/\/music\//.test(media.path)) {
      media.path = fixtures.music;
      media.duration = Math.min(media.duration, 370);
    } else {
      media.path = fixtures.voice;
      media.duration = Math.min(media.duration, 370);
    }
  }
  project.name = name;
  return project;
}
