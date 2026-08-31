struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_intensity: vec4f,
    u_threshold: vec4f,
    u_color: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_WEIGHTS = vec3f(0.2126, 0.7152, 0.0722);

fn luma_at(uv: vec2f) -> f32 {
    return dot(textureSample(input_texture, input_sampler, uv).rgb, LUMA_WEIGHTS);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let texel_size = vec2f(1.0, 1.0) / uniforms.resolution.xy;
    let base = textureSample(input_texture, input_sampler, input.tex_coord);

    let left = luma_at(input.tex_coord - vec2f(texel_size.x, 0.0));
    let right = luma_at(input.tex_coord + vec2f(texel_size.x, 0.0));
    let top = luma_at(input.tex_coord - vec2f(0.0, texel_size.y));
    let bottom = luma_at(input.tex_coord + vec2f(0.0, texel_size.y));
    let gradient = vec2f(right - left, bottom - top);
    let magnitude = length(gradient);

    let threshold = uniforms.u_threshold.x;
    let edge = smoothstep(threshold, threshold + 0.1, magnitude);
    let glow = uniforms.u_color.rgb * edge * uniforms.u_intensity.x;

    return vec4f(clamp(base.rgb + glow, vec3f(0.0), vec3f(1.0)), base.a);
}
