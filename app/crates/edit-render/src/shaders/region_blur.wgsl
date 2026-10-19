// An adjustment's blur, second pass: the vertical half of the Gaussian over
// the horizontally blurred picture (`src`), laid over the unblurred one
// (`sharp`) inside the region, fading out over the feather beyond its edge.

struct Region {
    dir: vec2f,
    texel: vec2f,
    sigma: f32,
    taps: f32,
    // 0 ellipse, 1 rounded rectangle, 2 the whole frame.
    shape: f32,
    feather: f32,
    // Target px from the top-left.
    center: vec2f,
    half: vec2f,
    size: vec2f,
    amount: f32,
    _p: f32,
};

@group(0) @binding(0) var<uniform> r: Region;
@group(0) @binding(3) var sharp: texture_2d<f32>;

// Signed distance (px) from the region's edge, negative inside.
fn edge_distance(p: vec2f) -> f32 {
    let half = max(r.half, vec2f(0.5));
    if (r.shape > 0.5) {
        let corner = 0.2 * min(half.x, half.y);
        let q = abs(p) - half + corner;
        return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - corner;
    }
    // An ellipse: the usual close estimate of the distance.
    let k0 = length(p / half);
    let k1 = length(p / (half * half));
    if (k1 < 1e-6) {
        return -min(half.x, half.y);
    }
    return k0 * (k0 - 1.0) / k1;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let base = textureSampleLevel(sharp, samp, in.uv, 0.0);
    var cover = r.amount;
    if (r.shape < 1.5) {
        let d = edge_distance(in.uv * r.size - r.center);
        cover = cover * (1.0 - smoothstep(0.0, max(r.feather, 1.0), d));
    }
    let n = i32(r.taps);
    let step = 3.0 * r.sigma / max(r.taps, 1.0);
    var sum = textureSampleLevel(src, samp, in.uv, 0.0);
    var total = 1.0;
    for (var i = 1; i <= n; i = i + 1) {
        let x = f32(i) * step;
        let w = exp(-(x * x) / (2.0 * r.sigma * r.sigma));
        let offset = r.dir * r.texel * x;
        sum = sum + (textureSampleLevel(src, samp, in.uv + offset, 0.0)
            + textureSampleLevel(src, samp, in.uv - offset, 0.0)) * w;
        total = total + 2.0 * w;
    }
    return mix(base, sum / total, cover);
}
