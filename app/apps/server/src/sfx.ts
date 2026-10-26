// Sound effects bundled with Edit. They're embedded in the binary
// (imported as files: `bun build --compile` carries them) and written into
// <home>/sfx so a project imports them like any other file.

import * as fs from "node:fs";

import shutterWav from "../../../assets/sfx/shutter.wav" with { type: "file" };
import whoosh3 from "../../../assets/sfx/whoosh-3.mp3" with { type: "file" };

import { ioMessage, writeAtomic } from "./files.ts";
import type { Marker } from "./model.ts";
import { join } from "./paths.ts";

/** The marker a placed sound lines up on the cut. */
export const HIT = "hit";

/** A sound effect's name saying it's one moment (a whoosh, a hit), not a bed. */
export const MOMENT = /whoosh|swoosh|swish|impact|\bhit\b|boom|click|riser|stinger|slam|thud|transition|shutter/iu;

/**
 * A one-moment sound effect longer than this plays only its hit unless told
 * how long (`HIT_PLAY` seconds, the hit two thirds in, fading out): Judge
 * EXPLODES' "Swooshes, Whoosh, Dark, Big" is 22 s of whooshes in one file and
 * played whole under every teaser and cut-in, turned up to +3 dB because
 * the whole file measured quiet (Marius: "Really loud sound effect for no
 * reason", "this does occur later on in the video as well").
 */
export const LONG_MOMENT = 4.0;
export const HIT_PLAY = 1.8;

export interface Sound {
  name: string;
  /** Its file name in the assets ("shutter.wav"). */
  file: string;
  /** Where its bytes are (in the binary, or the checkout in development). */
  source: string;
  /** Seconds into the file of its "hit" marker: the point that lands on the cut. */
  hit: number;
}

export const SOUNDS: Sound[] = [
  // The middle of the shutter, so it straddles the cut.
  { name: "shutter", file: "shutter.wav", source: shutterWav, hit: 0.085 },
  // The Internet Janitor guide's "Whoosh - 3.mp3" for image slide-down
  // transitions: almost a second of build-up, its loudest moment (0.95 s)
  // landing as the animation begins.
  { name: "whoosh-3", file: "whoosh-3.mp3", source: whoosh3, hit: 0.95 },
];

/** The markers a sound comes with. */
export function markers(sound: Sound): Marker[] {
  return [{ time: sound.hit, name: HIT }];
}

export function find(name: string): Sound | undefined {
  return SOUNDS.find((sound) => sound.name === name);
}

export function names(): string[] {
  return SOUNDS.map((sound) => sound.name);
}

const bytesOf = new Map<string, Uint8Array>();

function bytes(sound: Sound): Uint8Array {
  let known = bytesOf.get(sound.name);
  if (known === undefined) {
    known = new Uint8Array(fs.readFileSync(sound.source));
    bytesOf.set(sound.name, known);
  }
  return known;
}

/** FNV-1a (64-bit) over `data`, as its low 32 bits (how the files have always been named, so old projects keep theirs). */
export function fnv1a32(data: Uint8Array): number {
  // The 64-bit product kept as two 32-bit halves: hash * 0x100000001b3 is
  // hash * 0x1b3 plus hash's low half shifted up 32 (into the high half).
  let low = 0x84222325;
  let high = 0xcbf29ce4;
  for (const byte of data) {
    low = (low ^ byte) >>> 0;
    const lowProduct = low * 0x1b3;
    const carry = Math.floor(lowProduct / 0x1_0000_0000);
    const newLow = lowProduct >>> 0;
    high = (Math.imul(high, 0x1b3) + Math.imul(low, 0x100) + carry) >>> 0;
    low = newLow;
  }
  return low;
}

/**
 * The sound's file on disk, written if missing. The name carries a hash of
 * the bytes, so a new version of a sound is a new file and projects using
 * the old one keep it.
 */
export function path(home: string, sound: Sound): string {
  const data = bytes(sound);
  const dot = sound.file.lastIndexOf(".");
  const [stem, extension] = dot >= 0 ? [sound.file.slice(0, dot), sound.file.slice(dot + 1)] : [sound.file, "wav"];
  const out = join(home, "sfx", `${stem}-${fnv1a32(data).toString(16).padStart(8, "0")}.${extension}`);
  let current: Uint8Array | null = null;
  try {
    current = fs.readFileSync(out);
  } catch {
    current = null;
  }
  if (current === null || Buffer.compare(Buffer.from(current), Buffer.from(data)) !== 0) {
    try {
      fs.mkdirSync(join(home, "sfx"), { recursive: true });
      writeAtomic(out, data);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
  }
  return out;
}
