// Adjustment layer: grades everything composited so far.

struct Grade {
    exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    vignette: f32,
    opacity: f32,
    aspect: f32,
    _p: f32,
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

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let base = textureSampleLevel(src, samp, in.uv, 0.0);
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
