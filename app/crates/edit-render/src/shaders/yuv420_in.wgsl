// A decoded frame's BT.709 TV-range 4:2:0 planes into the video's RGBA
// texture, as FFmpeg's own conversion makes it (what a decoder piped before,
// Nov 8): each chroma sample over its 2x2 block, and the values truncated.

@group(0) @binding(0) var luma: texture_2d<f32>;
@group(0) @binding(1) var blue: texture_2d<f32>;
@group(0) @binding(2) var red: texture_2d<f32>;

const KR: f32 = 0.2126;
const KB: f32 = 0.0722;
const KG: f32 = 1.0 - KR - KB;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let at = vec2<u32>(position.xy);
    let y = (textureLoad(luma, at, 0).r * 255.0 - 16.0) / 219.0;
    let cb = (textureLoad(blue, at / 2u, 0).r * 255.0 - 128.0) / 224.0;
    let cr = (textureLoad(red, at / 2u, 0).r * 255.0 - 128.0) / 224.0;
    let r = y + 2.0 * (1.0 - KR) * cr;
    let b = y + 2.0 * (1.0 - KB) * cb;
    let g = (y - KR * r - KB * b) / KG;
    let rgb = floor(clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0 + 0.001);
    return vec4<f32>(rgb / 255.0, 1.0);
}
