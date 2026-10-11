// Adjustment layer: shakes and grades everything composited so far.

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
};

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

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    // Blur along the move from a shutter ago to now: the shake's motion blur.
    let moving = any(g.prev != g.shake) || g.prev_turn != g.turn;
    let taps = select(1, BLUR_TAPS, moving);
    var sum = vec4f(0.0);
    for (var i = 0; i < taps; i++) {
        let t = (f32(i) + 0.5) / f32(taps);
        let at = select(1.0, t, moving);
        let uv = edge(shaken(in.uv, mix(g.prev, g.shake, at), mix(g.prev_turn, g.turn, at)));
        sum += textureSampleLevel(src, samp, uv, 0.0);
    }
    let base = sum / f32(taps);
    var lin = to_linear(max(base.rgb, vec3f(0.0))) * exp2(g.exposure);
    let t = g.temperature;
    lin = lin * vec3f(1.0 + 0.18 * t, 1.0 + 0.02 * t, 1.0 - 0.18 * t);
    var s = to_srgb(max(lin, vec3f(0.0)));
    s = (s - 0.5) * (1.0 + g.contrast) + 0.5;
    let luma = dot(s, vec3f(0.2126, 0.7152, 0.0722));
    s = mix(vec3f(luma), s, 1.0 + g.saturation);
    let d = (in.uv - 0.5) * vec2f(g.aspect, 1.0);
    let r = length(d) / length(vec2f(g.aspect, 1.0) * 0.5);
    s = s * (1.0 - g.vignette * smoothstep(0.35, 1.0, r));
    s = max(s, vec3f(0.0));
    return vec4f(mix(base.rgb, s, g.opacity), base.a);
}
