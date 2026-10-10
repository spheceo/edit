// One direction of a Gaussian blur. Taps are spread over 3 sigma so wide glows
// stay a fixed cost; linear filtering smooths the gaps.

struct Blur {
    dir: vec2f,
    texel: vec2f,
    sigma: f32,
    taps: f32,
    _p0: f32,
    _p1: f32,
};

@group(0) @binding(0) var<uniform> b: Blur;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let n = i32(b.taps);
    let step = 3.0 * b.sigma / max(b.taps, 1.0);
    var sum = textureSampleLevel(src, samp, in.uv, 0.0);
    var total = 1.0;
    for (var i = 1; i <= n; i = i + 1) {
        let x = f32(i) * step;
        let w = exp(-(x * x) / (2.0 * b.sigma * b.sigma));
        let offset = b.dir * b.texel * x;
        sum = sum + (textureSampleLevel(src, samp, in.uv + offset, 0.0)
            + textureSampleLevel(src, samp, in.uv - offset, 0.0)) * w;
        total = total + 2.0 * w;
    }
    return sum / total;
}
