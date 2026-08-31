struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_intensity: vec4f,
    u_radius: vec4f,
    u_color: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_WEIGHTS = vec3f(0.2126, 0.7152, 0.0722);
const TAP_COUNT: u32 = 24u;
const GOLDEN_ANGLE: f32 = 2.39996323;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let base = textureSample(input_texture, input_sampler, input.tex_coord);
    let texel = vec2f(1.0, 1.0) / uniforms.resolution.xy;
    let radius_px = max(uniforms.u_radius.x, 0.0);
    let intensity = max(uniforms.u_intensity.x, 0.0);

    // 24 sunflower-distributed taps over the radius disc: smoother than a
    // single ring, single pass, no dependency on the blur pipeline.
    var glow = 0.0;
    for (var i: u32 = 0u; i < TAP_COUNT; i = i + 1u) {
        let t = (f32(i) + 0.5) / f32(TAP_COUNT);
        let angle = f32(i) * GOLDEN_ANGLE;
        let offset = vec2f(cos(angle), sin(angle)) * (sqrt(t) * radius_px) * texel;
        let s = textureSampleLevel(input_texture, input_sampler, input.tex_coord + offset, 0.0);
        glow += s.a * dot(s.rgb, LUMA_WEIGHTS) * (1.0 - t);
    }
    // Weights (1 - t) sum to TAP_COUNT / 2, so glow stays within 0..1.
    glow = glow / (f32(TAP_COUNT) * 0.5);

    let glow_alpha = clamp(glow * intensity, 0.0, 1.0);
    let premultiplied = base.rgb * base.a + uniforms.u_color.rgb * glow_alpha;
    let out_alpha = clamp(base.a + glow_alpha, 0.0, 1.0);
    let out_rgb = premultiplied / max(out_alpha, 0.0001);
    return vec4f(clamp(out_rgb, vec3f(0.0), vec3f(1.0)), out_alpha);
}
