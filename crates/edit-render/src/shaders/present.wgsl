// Final pass: composite (premultiplied over black) to an 8-bit target.

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let c = textureSampleLevel(src, samp, in.uv, 0.0);
    return vec4f(clamp(c.rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
