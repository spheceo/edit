// The short names broll gives the files it makes (`fingerprint`): Rust's
// `DefaultHasher` (SipHash-1-3, keys 0 and 0) over each part as `str::hash`
// feeds it (its UTF-8 bytes, then 0xff), the low 48 bits in hex. The files
// already on disk (stills, smoothed shots, map renders) are named this way, so
// the same inputs must give the same name here or they're made again. It's
// not a cache key of the media cache (those stay native: `mediaKey`), only a
// file name; `hash.test.ts` pins it to values the Rust code printed.
//
// Like the Rust, it changes if Rust's DefaultHasher ever does (pinned toolchain).

const MASK = (1n << 64n) - 1n;

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK;
}

/** SipHash with `c` compression and `d` finalization rounds over `bytes`, keys k0 and k1. */
export function siphash(bytes: Uint8Array, k0 = 0n, k1 = 0n, c = 1, d = 3): bigint {
  let v0 = k0 ^ 0x736f6d6570736575n;
  let v1 = k1 ^ 0x646f72616e646f6dn;
  let v2 = k0 ^ 0x6c7967656e657261n;
  let v3 = k1 ^ 0x7465646279746573n;
  const round = () => {
    v0 = (v0 + v1) & MASK;
    v1 = rotl(v1, 13n);
    v1 ^= v0;
    v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK;
    v3 = rotl(v3, 16n);
    v3 ^= v2;
    v0 = (v0 + v3) & MASK;
    v3 = rotl(v3, 21n);
    v3 ^= v0;
    v2 = (v2 + v1) & MASK;
    v1 = rotl(v1, 17n);
    v1 ^= v2;
    v2 = rotl(v2, 32n);
  };
  const length = bytes.length;
  const whole = length - (length % 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < whole; at += 8) {
    const m = view.getBigUint64(at, true);
    v3 ^= m;
    for (let i = 0; i < c; i++) round();
    v0 ^= m;
  }
  let last = BigInt(length & 0xff) << 56n;
  for (let i = 0; i < length % 8; i++) last |= BigInt(bytes[whole + i]!) << BigInt(8 * i);
  v3 ^= last;
  for (let i = 0; i < c; i++) round();
  v0 ^= last;
  v2 ^= 0xffn;
  for (let i = 0; i < d; i++) round();
  return (v0 ^ v1 ^ v2 ^ v3) & MASK;
}

/** `fingerprint`: 12 hex digits naming what `parts` describe. */
export function fingerprint(parts: string[]): string {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(new TextEncoder().encode(part), new Uint8Array([0xff]));
  }
  const bytes = Buffer.concat(chunks);
  const value = siphash(bytes) & 0xffff_ffff_ffffn;
  return value.toString(16).padStart(12, "0");
}

/**
 * `format!("{:?}", metadata.modified().ok())` on unix, as still_video puts a
 * file's mtime into its name: `Some(SystemTime { tv_sec: …, tv_nsec: … })`.
 */
export function debugModified(mtimeNs: bigint | null): string {
  if (mtimeNs === null) return "None";
  const second = 1_000_000_000n;
  let seconds = mtimeNs / second;
  let nanos = mtimeNs % second;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += second;
  }
  return `Some(SystemTime { tv_sec: ${seconds}, tv_nsec: ${nanos} })`;
}
