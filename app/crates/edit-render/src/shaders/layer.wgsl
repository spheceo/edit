// Draws one transformed quad onto the composite: video frames, solids,
// rasterized text and text glow. Positions are project pixels from the frame
// centre with y pointing down; rotation is clockwise on screen.

struct Layer {
    center: vec2f,
    size: vec2f,
    half_canvas: vec2f,
    rotation: f32,
    opacity: f32,
    tint: vec4f,
    // 0 straight-alpha texture, 1 solid tint, 2 glow mask (tinted alpha), 3 premultiplied texture, 4 shadow,
    // 5 box shadow, 6 gradient (tint fading across the quad)
    mode: u32,
    // Box shadow: the Gaussian's sigma in pixels.
    blur: f32,
    _p1: u32,
    _p2: u32,
    // The part of the texture drawn (x0, y0, x1, y1): a crop. A gradient: clear
    // at x = uv.x, full at x = uv.y (shares of the quad's width).
    uv: vec4f,
};

@group(0) @binding(0) var<uniform> u: Layer;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    // Where in the quad (0..1 across and down), whatever part of the texture it shows.
    @location(1) corner: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let corner = vec2f(f32(i & 1u), f32(i >> 1u));
    let local = (corner - 0.5) * u.size;
    let c = cos(u.rotation);
    let s = sin(u.rotation);
    let p = vec2f(local.x * c - local.y * s, local.x * s + local.y * c) + u.center;
    var out: VsOut;
    out.pos = vec4f(p.x / u.half_canvas.x, -p.y / u.half_canvas.y, 0.0, 1.0);
    out.uv = mix(u.uv.xy, u.uv.zw, corner);
    out.corner = corner;
    return out;
}

// erf, closely enough (Abramowitz & Stegun 7.1.27), per component.
fn erf2(x: vec2f) -> vec2f {
    let s = sign(x);
    let a = abs(x);
    var r = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
    r = r * r;
    return s - s / (r * r);
}

// How much of a box (half-size `half`, centred) a Gaussian of `sigma` around
// `p` covers: the box blurred exactly, separable in x and y.
fn box_blur(p: vec2f, half: vec2f, sigma: f32) -> f32 {
    let k = 1.0 / (sqrt(2.0) * sigma);
    let covered = 0.5 * (erf2((p + half) * k) - erf2((p - half) * k));
    return covered.x * covered.y;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let texel = textureSampleLevel(tex, samp, in.uv, 0.0);
    switch u.mode {
        case 1u: {
            return vec4f(u.tint.rgb * u.tint.a, u.tint.a) * u.opacity;
        }
        case 2u: {
            let a = min(texel.a * u.tint.a * u.opacity, 1.0);
            return vec4f(u.tint.rgb * a, a);
        }
        case 3u: {
            return texel * u.opacity;
        }
        case 4u: {
            // Drop shadow: the blurred text, thickened (the "grown" text), then
            // capped at the shadow's own opacity.
            let a = min(texel.a * 2.5, 1.0) * u.tint.a * u.opacity;
            return vec4f(u.tint.rgb * a, a);
        }
        case 5u: {
            // The quad is the shape plus 3 sigma all round.
            let p = (in.corner - 0.5) * u.size;
            let half = max(u.size * 0.5 - 3.0 * u.blur, vec2f(0.0));
            let a = box_blur(p, half, u.blur) * u.tint.a * u.opacity;
            return vec4f(u.tint.rgb * a, a);
        }
        case 6u: {
            let t = clamp((in.corner.x - u.uv.x) / (u.uv.y - u.uv.x), 0.0, 1.0);
            let a = smoothstep(0.0, 1.0, t) * u.tint.a * u.opacity;
            return vec4f(u.tint.rgb * a, a);
        }
        default: {
            return vec4f(texel.rgb * texel.a, texel.a) * u.opacity;
        }
    }
}
