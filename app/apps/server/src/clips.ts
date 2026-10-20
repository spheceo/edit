// edit-core's clip types as serde reads them (crates/edit-core/src/model.rs):
// what `serde_json::from_value::<Clip>` / `<Keyframe>` / `<TextStyle>` … did in
// the tools. A clip read here has every default filled in and the shape serde
// writes (fields in order, skipped ones left out), f32 fields rounded to f32,
// so the tools see what they would after the addon saved it.

import type { Clip, Keyframe, TextAnimation, TextStyle, Transform } from "./model.ts";
import {
  field,
  fillFields,
  isEmpty,
  isNone,
  isOne,
  isZero,
  optional,
  read,
  readFields,
  readStruct,
  required,
  SerdeError,
  unexpected,
  unknownVariant,
  type Field,
  type Kind,
  type Struct,
} from "./serde.ts";

const rgba: Kind = { rgba: true };
const WHITE = [1, 1, 1, 1];
const BLACK = [0, 0, 0, 1];

function struct(name: string, fields: Field[]): Struct {
  return { name, fields };
}

/** A struct-typed field defaulting to the struct's own default. */
function nested(name: string, spec: Struct, skip?: (value: unknown) => boolean): Field {
  const out: Field = { name, kind: { struct: spec }, default: () => readStruct(spec, {}) };
  if (skip !== undefined) out.skip = skip;
  return out;
}

const enumOf = (name: string, variants: readonly string[]): Kind => ({ enum: name, variants });

export const CLIP_COLORS = ["blue", "cyan", "green", "yellow", "orange", "red", "purple", "pink"] as const;
export const EASES = ["linear", "in_out", "in", "out", "hold"] as const;
export const CLIP_TYPES = ["video", "audio", "text", "adjustment", "solid", "waveform"] as const;

export const TRANSFORM = struct("Transform", [
  field("x", "f32", 0),
  field("y", "f32", 0),
  field("scale", "f32", 1),
  field("rotation", "f32", 0),
  field("shake", "f32", 0, isZero),
]);

const CROP = struct("Crop", [field("left", "f32", 0), field("right", "f32", 0), field("top", "f32", 0), field("bottom", "f32", 0)]);
const cropIsNone = (value: unknown) => Object.values(value as Record<string, number>).every((side) => side === 0);

const PHOTO_FRAME = struct("PhotoFrame", [
  field("width", "f32", 12),
  field("color", rgba, [0.08, 0.08, 0.08, 1]),
  field("shadow", "f32", 0.55),
]);

const MUTE = struct("Mute", [required("from", "f64"), required("to", "f64")]);

export const GLOW = struct("Glow", [
  field("enabled", "bool", true),
  field("color", { option: rgba }, null),
  field("radius", "f32", 46),
  field("strength", "f32", 0.5),
]);

const TEXT_BOX = struct("TextBox", [
  field("color", rgba, BLACK),
  field("opacity", "f32", 0.75),
  field("pad_x", "f32", 12),
  field("pad_y", "f32", 8),
  field("border", "f32", 0, isZero),
  field("border_color", rgba, WHITE),
]);

const TEXT_SHADOW = struct("TextShadow", [
  field("color", rgba, BLACK),
  field("opacity", "f32", 0.65),
  field("distance", "f32", 3),
  field("angle", "f32", 112),
  field("size", "f32", 6),
  field("blur", "f32", 8),
]);

const TEXT_LABEL = struct("TextLabel", [required("text", "string"), field("color", rgba, WHITE), field("size", "f32", 26)]);

const LEADER = struct("Leader", [
  field("x", "f32", 0),
  field("y", "f32", 0),
  field("width", "f32", 3),
  field("color", rgba, [1, 0.1, 0.1, 1]),
  field("draw", "f32", 10),
  field("attach", enumOf("LeaderAttach", ["nearest", "side"]), "nearest"),
  field("fade", "f32", 8),
]);

export const TEXT_STYLE = struct("TextStyle", [
  field("font", "string", "Geist"),
  field("weight", "u16", 700),
  field("size", "f32", 96),
  field("color", rgba, WHITE),
  field("tracking", "f32", 0),
  field("line_height", "f32", 1.15),
  nested("glow", GLOW),
  optional("max_width", "f32"),
  optional("background", { struct: TEXT_BOX }),
  optional("shadow", { struct: TEXT_SHADOW }),
  optional("label", { struct: TEXT_LABEL }),
  optional("leader", { struct: LEADER }),
  field("align", enumOf("TextAlign", ["left", "center", "right"]), "center", (value) => value === "center"),
  field("uppercase", "bool", false, (value) => value === false),
]);

export const TEXT_ANIMATION = struct("TextAnimation", [
  field("preset", enumOf("TextPreset", ["none", "fade", "rise", "pop", "typewriter", "words", "word"]), "none"),
  field("duration", "f32", 12),
  field("stagger", "f32", 1.5),
]);

const GRADE = struct("Grade", [
  field("exposure", "f32", 0),
  field("contrast", "f32", 0),
  field("saturation", "f32", 0),
  field("temperature", "f32", 0),
  field("vignette", "f32", 0),
  field("vignette_x", "f32", 0, isZero),
  field("vignette_y", "f32", 0, isZero),
  field("vignette_size", "f32", 1, isOne),
  field("vignette_aspect", "f32", 1, isOne),
  field("focus_exposure", "f32", 0, isZero),
  field("vignette_saturation", "f32", 0, isZero),
  field("leak", "f32", 0, isZero),
  field("leak_x", "f32", 0, isZero),
  field("grain", "f32", 0, isZero),
  field("scanlines", "f32", 0, isZero),
  field("fade", "f32", 0, isZero),
]);

const SHAKE = struct("Shake", [
  field("preset", enumOf("ShakePreset", ["none", "handheld", "vertical", "horizontal", "impact", "earthquake"]), "none"),
  optional("amount", "f32"),
  optional("frequency", "f32"),
  optional("rotation", "f32"),
  optional("direction", enumOf("ShakeDirection", ["both", "vertical", "horizontal"])),
  optional("envelope", enumOf("ShakeEnvelope", ["steady", "build", "hit", "swell"])),
  optional("motion_blur", "f32"),
  optional("edges", enumOf("ShakeEdges", ["mirror", "zoom"])),
  optional("motion", enumOf("ShakeMotion", ["wiggle", "drop"])),
]);
const shakeIsOff = (value: unknown) => {
  const shake = value as Record<string, unknown>;
  return shake.preset === "none" && Object.keys(shake).length === 1;
};

const GLITCH = struct("Glitch", [field("amount", "f32", 0), field("slices", "f32", 6), field("rgb", "f32", 0.08)]);

const BLUR = struct("Blur", [
  field("radius", "f32", 0),
  field("x", "f32", 0, isZero),
  field("y", "f32", 0, isZero),
  field("width", "f32", 0, isZero),
  field("height", "f32", 0, isZero),
  field("feather", "f32", 0, isZero),
  field("shape", enumOf("BlurShape", ["ellipse", "rect"]), "ellipse", (value) => value === "ellipse"),
]);

const GRADIENT = struct("Gradient", [required("from", "f32"), required("to", "f32")]);

const WAVEFORM_STYLE = struct("WaveformStyle", [
  field("kind", enumOf("WaveformKind", ["line", "bars"]), "line"),
  field("color", rgba, [1, 0.03, 0.03, 1]),
  field("bars", "u32", 48),
  field("strands", "u32", 2),
  field("width", "f32", 1400),
  field("height", "f32", 360),
  field("fill", "f32", 0.5),
  field("window", "f32", 1.6),
  field("gain", "f32", 1),
  nested("glow", GLOW),
]);

const HANDLE = struct("Handle", [required("speed", "f32"), required("influence", "f32")]);

export const KEYFRAME = struct("Keyframe", [
  required("frame", "f32"),
  required("value", "f32"),
  field("ease", enumOf("Ease", EASES), "in_out"),
  optional("handle_in", { struct: HANDLE }),
  optional("handle_out", { struct: HANDLE }),
]);

const CLIP = struct("Clip", [
  required("id", "string"),
  required("track", "string"),
  required("start", "i64"),
  required("duration", "i64"),
  field("color", enumOf("ClipColor", CLIP_COLORS), "blue"),
  optional("name", "string"),
  optional("link", "string"),
  field("fade_in", "i64", 0),
  field("fade_out", "i64", 0),
  field("keyframes", { map: { vec: { struct: KEYFRAME } } }, {}, isEmpty),
]);

const VARIANTS: Record<(typeof CLIP_TYPES)[number], Struct> = {
  video: struct("Video", [
    required("media", "string"),
    field("source_in", "f64", 0),
    field("speed", "f64", 1),
    nested("transform", TRANSFORM),
    field("opacity", "f32", 1),
    nested("crop", CROP, cropIsNone),
    optional("frame", { struct: PHOTO_FRAME }),
  ]),
  audio: struct("Audio", [
    required("media", "string"),
    field("source_in", "f64", 0),
    field("speed", "f64", 1),
    field("volume_db", "f32", 0),
    field("mutes", { vec: { struct: MUTE } }, [], isEmpty),
  ]),
  text: struct("Text", [
    required("text", "string"),
    nested("style", TEXT_STYLE),
    nested("transform", TRANSFORM),
    nested("animation", TEXT_ANIMATION),
    field("opacity", "f32", 1),
    field("word_times", { vec: "f32" }, [], isEmpty),
  ]),
  adjustment: struct("Adjustment", [
    nested("grade", GRADE),
    nested("shake", SHAKE, shakeIsOff),
    nested("glitch", GLITCH, (value) => (value as { amount: number }).amount === 0),
    nested("blur", BLUR, (value) => (value as { radius: number }).radius <= 0),
    field("opacity", "f32", 1),
  ]),
  solid: struct("Solid", [field("fill", rgba, WHITE), field("opacity", "f32", 1), optional("gradient", { struct: GRADIENT })]),
  waveform: struct("Waveform", [
    optional("media", "string"),
    nested("style", WAVEFORM_STYLE),
    nested("transform", TRANSFORM),
    field("opacity", "f32", 1),
  ]),
};

/**
 * A clip from JSON, as `serde_json::from_value::<Clip>`: the clip's own
 * fields, then (flattened) its content by its `type` tag. Throws SerdeError.
 */
export function clipFrom(value: unknown): Clip {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SerdeError(`invalid type: ${unexpected(value)}, expected struct Clip`);
  }
  const given = value as Record<string, unknown>;
  const own = fillFields(CLIP, readFields(CLIP, given));
  const tag = given.type;
  if (tag === undefined || tag === null) throw new SerdeError("missing field `type`");
  if (typeof tag !== "string") throw new SerdeError(`invalid type: ${unexpected(tag)}, expected variant identifier`);
  if (!(CLIP_TYPES as readonly string[]).includes(tag)) throw unknownVariant(tag, CLIP_TYPES);
  const content = fillFields(VARIANTS[tag as keyof typeof VARIANTS], readFields(VARIANTS[tag as keyof typeof VARIANTS], given));
  return { ...own, type: tag, ...content } as unknown as Clip;
}

/** `Vec<Keyframe>` from JSON. */
export function keyframesFrom(value: unknown): Keyframe[] {
  return read({ vec: { struct: KEYFRAME } }, value) as Keyframe[];
}

export function textStyleFrom(value: unknown): TextStyle {
  return readStruct(TEXT_STYLE, value) as unknown as TextStyle;
}

export function textAnimationFrom(value: unknown): TextAnimation {
  return readStruct(TEXT_ANIMATION, value) as unknown as TextAnimation;
}

export function transformFrom(value: unknown): Transform {
  return readStruct(TRANSFORM, value) as unknown as Transform;
}

/** The defaults as serde writes them (`serde_json::to_value(T::default())`). */
export function defaultTextStyle(): TextStyle {
  return textStyleFrom({});
}

export function defaultTextAnimation(): TextAnimation {
  return textAnimationFrom({});
}

export function defaultTransform(): Transform {
  return transformFrom({});
}

/** A clip colour (`ClipColor`) from JSON. */
export function clipColorFrom(value: unknown): string {
  return read({ enum: "ClipColor", variants: CLIP_COLORS }, value) as string;
}

/** Whether a field read is an Option that was None (for callers checking `isNone`). */
export { isNone, SerdeError };
