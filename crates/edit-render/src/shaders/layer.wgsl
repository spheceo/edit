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
    // 0 straight-alpha texture, 1 solid tint, 2 glow mask (tinted alpha), 3 premultiplied texture, 4 shadow
    mode: u32,
    _p0: u32,
    _p1: u32,
    _p2: u32,
};

@group(0) @binding(0) var<uniform> u: Layer;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
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
    out.uv = corner;
    return out;
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
        default: {
            return vec4f(texel.rgb * texel.a, texel.a) * u.opacity;
        }
    }
}
