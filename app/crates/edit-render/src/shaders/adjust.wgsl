// Adjustment layer: shakes, glitches and grades everything composited so far.

struct Grade {
    exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    vignette: f32,
    opacity: f32,
    aspect: f32,
    _p: f32,
    shake: vec2f,
    turn: f32,
    zoom: f32,
    prev: vec2f,
    prev_turn: f32,
    mirror: f32,
    // Vignette centre (frame heights from the centre), reach, width over height.
    vignette_at: vec2f,
    vignette_size: f32,
    vignette_aspect: f32,
    // Glitch: band slide (frame widths), bands, colour split, pattern.
    glitch: f32,
    slices: f32,
    rgb: f32,
    seed: f32,
    // Inside the vignette's clear area: extra stops; where it falls: extra saturation.
    focus_exposure: f32,
    vignette_saturation: f32,
    // The light leak: strength, and where it comes from (-1 left .. 1 right).
    leak: f32,
    leak_x: f32,
    // Film grain, scan lines, a faded print; the frame's height in pixels.
    grain: f32,
    scanlines: f32,
    fade: f32,
    height: f32,
};

// A hash in 0..1 per pixel and pattern (the grain's noise).
fn grain_hash(p: vec2f) -> f32 {
    let q = fract(p * vec2f(0.1031, 0.1030));
    let r = q + dot(q, q.yx + 33.33);
    return fract((r.x + r.y) * r.x);
}

@group(0) @binding(0) var<uniform> g: Grade;

fn to_linear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

fn to_srgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

// Samples along the shake's path for motion blur (S_Shake's Motion Blur).
const BLUR_TAPS: i32 = 24;

// Where the picture beneath shows at `uv` once it's moved by `offset` and
// tilted by `turn` (units of frame height), and zoomed.
fn shaken(uv: vec2f, offset: vec2f, turn: f32) -> vec2f {
    let toward = vec2f(g.aspect, 1.0);
    var p = (uv - 0.5) * toward / g.zoom;
    let c = cos(turn);
    let s = sin(turn);
    p = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y) - offset;
    return p / toward + 0.5;
}

// Past the edges the picture is mirrored (S_Shake's Reflect), else held at the edge.
fn edge(uv: vec2f) -> vec2f {
    if (g.mirror > 0.5) {
        return 1.0 - abs(1.0 - fract(uv * 0.5) * 2.0);
    }
    return uv;
}

fn hash(n: f32) -> f32 {
    return fract(sin(n * 127.1 + g.seed * 311.7) * 43758.5453);
}

// How far the glitch slides the band at height `y` (frame widths). Bands of
// uneven height: tall ones, now and then one cut again; about half of each move.
fn glitch_slide(y: f32) -> f32 {
    let coarse = floor(y * g.slices);
    let fine = floor(y * g.slices * 3.0);
    var slide = 0.0;
    if (hash(coarse) > 0.45) {
        slide = (hash(coarse + 31.0) * 2.0 - 1.0);
    }
    if (hash(fine + 57.0) > 0.88) {
        slide += (hash(fine + 91.0) * 2.0 - 1.0) * 0.5;
    }
    return slide * g.glitch;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    // Blur along the move from a shutter ago to now: the shake's motion blur.
    let moving = any(g.prev != g.shake) || g.prev_turn != g.turn;
    let taps = select(1, BLUR_TAPS, moving);
    let slide = select(0.0, glitch_slide(in.uv.y), g.glitch > 0.0);
    let start = in.uv + vec2f(slide, 0.0);
    var sum = vec4f(0.0);
    for (var i = 0; i < taps; i++) {
        let t = (f32(i) + 0.5) / f32(taps);
        let at = select(1.0, t, moving);
        let uv = edge(shaken(start, mix(g.prev, g.shake, at), mix(g.prev_turn, g.turn, at)));
        sum += textureSampleLevel(src, samp, uv, 0.0);
    }
    var base = sum / f32(taps);
    // A touch of colour split along each band's slide.
    if (slide != 0.0 && g.rgb > 0.0) {
        let split = vec2f(slide * g.rgb, 0.0);
        base.r = textureSampleLevel(src, samp, edge(shaken(start + split, g.shake, g.turn)), 0.0).r;
        base.b = textureSampleLevel(src, samp, edge(shaken(start - split, g.shake, g.turn)), 0.0).b;
    }
    // The vignette: 0 in its clear area, 1 where it's fully dark.
    var d = (in.uv - 0.5) * vec2f(g.aspect, 1.0) - g.vignette_at;
    d.x = d.x / g.vignette_aspect;
    let r = length(d) / (length(vec2f(g.aspect, 1.0) * 0.5) * g.vignette_size);
    let falloff = smoothstep(0.35, 1.0, r);
    var lin = to_linear(max(base.rgb, vec3f(0.0))) * exp2(g.exposure + g.focus_exposure * (1.0 - falloff));
    let t = g.temperature;
    lin = lin * vec3f(1.0 + 0.18 * t, 1.0 + 0.02 * t, 1.0 - 0.18 * t);
    // The light leak: warm light added as light, from a soft source a little
    // above the middle on one side, wider than tall, with a faint wash over
    // the whole frame; orange where it's faint, turning white where it's strong.
    if (g.leak > 0.0) {
        let p = (in.uv - 0.5) * vec2f(g.aspect, 1.0);
        let source = vec2f(g.leak_x * g.aspect * 0.5, -0.12);
        let q = (p - source) * vec2f(0.55, 1.0);
        let glow = exp(-dot(q, q) * 2.4) + 0.06;
        let light = g.leak * glow;
        let warm = mix(vec3f(1.0, 0.28, 0.05), vec3f(1.0, 0.9, 0.75), clamp((light - 0.8) * 0.4, 0.0, 1.0));
        lin = lin + warm * light;
    }
    var s = to_srgb(max(lin, vec3f(0.0)));
    s = (s - 0.5) * (1.0 + g.contrast) + 0.5;
    let luma = dot(s, vec3f(0.2126, 0.7152, 0.0722));
    s = mix(vec3f(luma), s, max(1.0 + g.saturation + g.vignette_saturation * falloff, 0.0));
    s = s * (1.0 - g.vignette * falloff);
    // A faded print: blacks lifted, whites dimmed.
    if (g.fade > 0.0) {
        s = mix(s, vec3f(0.07) + s * 0.82, g.fade);
    }
    // Scan lines: faint dark rows, about one every 3 pixels at 1080p.
    if (g.scanlines > 0.0) {
        let row = in.uv.y * g.height / max(g.height / 360.0, 1.0);
        let line = 0.5 + 0.5 * cos(row * 6.2831853);
        s = s * (1.0 - g.scanlines * 0.22 * line);
    }
    // Grain: a new fine noise every frame, strongest in the mid-tones.
    if (g.grain > 0.0) {
        let pixel = floor(in.uv * vec2f(g.height * g.aspect, g.height));
        let n = grain_hash(pixel + vec2f(g.seed * 17.0, g.seed * 31.0)) - 0.5;
        let mids = 1.0 - abs(dot(s, vec3f(0.333)) - 0.5) * 1.2;
        s = s + vec3f(n * g.grain * 0.22 * max(mids, 0.25));
    }
    s = max(s, vec3f(0.0));
    return vec4f(mix(base.rgb, s, g.opacity), base.a);
}
