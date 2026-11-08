// The output picture as an export's encoder takes it: BT.709, TV range, 4:2:0
// planar (Y, then U, then V, each tightly packed), as FFmpeg's
// `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p` makes it from
// RGBA: each chroma sample from its pair of pixels across, averaged, and down
// through swscale's bicubic over eight rows (within a level of FFmpeg's).
// One invocation is an 8x2 block of pixels: two words of Y in each row, one
// of U and one of V; the width is a multiple of 8 and the height even
// (`Renderer::yuv420_fits`).

@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> planes: array<u32>;

const KR: f32 = 0.2126;
const KB: f32 = 0.0722;
const KG: f32 = 1.0 - KR - KB;

// swscale's bicubic (B 0, C 0.6) halving: rows 2j-3 .. 2j+4 for chroma row j.
const TAPS = array<f32, 8>(
    -0.0140625, -0.0421875, 0.1203125, 0.4359375,
    0.4359375, 0.1203125, -0.0421875, -0.0140625,
);

fn luma(rgb: vec3<f32>) -> f32 {
    return KR * rgb.r + KG * rgb.g + KB * rgb.b;
}

fn byte(value: f32) -> u32 {
    return u32(clamp(round(value), 0.0, 255.0));
}

fn pack(a: f32, b: f32, c: f32, d: f32) -> u32 {
    return byte(a) | (byte(b) << 8u) | (byte(c) << 16u) | (byte(d) << 24u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(picture);
    let x0 = id.x * 8u;
    let y0 = id.y * 2u;
    if (x0 >= size.x || y0 >= size.y) {
        return;
    }
    var y: array<f32, 16>;
    for (var dy = 0u; dy < 2u; dy++) {
        for (var x = 0u; x < 8u; x++) {
            let rgb = textureLoad(picture, vec2<u32>(x0 + x, y0 + dy), 0).rgb;
            y[dy * 8u + x] = 16.0 + 219.0 * luma(rgb);
        }
    }
    var cb: array<f32, 4>;
    var cr: array<f32, 4>;
    let last = i32(size.y) - 1;
    for (var pair = 0u; pair < 4u; pair++) {
        let x = x0 + pair * 2u;
        var rgb = vec3<f32>(0.0);
        for (var tap = 0; tap < 8; tap++) {
            let row = u32(clamp(i32(y0) - 3 + tap, 0, last));
            let left = textureLoad(picture, vec2<u32>(x, row), 0).rgb;
            let right = textureLoad(picture, vec2<u32>(x + 1u, row), 0).rgb;
            rgb += TAPS[tap] * 0.5 * (left + right);
        }
        let l = luma(rgb);
        cb[pair] = 128.0 + 224.0 * (rgb.b - l) / (2.0 * (1.0 - KB));
        cr[pair] = 128.0 + 224.0 * (rgb.r - l) / (2.0 * (1.0 - KR));
    }
    let width = size.x;
    let row = (y0 * width + x0) / 4u;
    let next = row + width / 4u;
    planes[row] = pack(y[0], y[1], y[2], y[3]);
    planes[row + 1u] = pack(y[4], y[5], y[6], y[7]);
    planes[next] = pack(y[8], y[9], y[10], y[11]);
    planes[next + 1u] = pack(y[12], y[13], y[14], y[15]);
    let luma_words = width * size.y / 4u;
    let chroma_words = luma_words / 4u;
    let at = (id.y * (width / 2u) + x0 / 2u) / 4u;
    planes[luma_words + at] = pack(cb[0], cb[1], cb[2], cb[3]);
    planes[luma_words + chroma_words + at] = pack(cr[0], cr[1], cr[2], cr[3]);
}
