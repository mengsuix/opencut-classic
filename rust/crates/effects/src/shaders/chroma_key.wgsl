struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_key_color: vec4f,
    u_tolerance: vec4f,
    u_softness: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let diff = distance(color.rgb, uniforms.u_key_color.xyz);
    let tolerance = uniforms.u_tolerance.x;
    let softness = max(uniforms.u_softness.x, 0.0001);
    let keyed_alpha = 1.0 - smoothstep(tolerance, tolerance + softness, diff);
    return vec4f(color.rgb, color.a * keyed_alpha);
}
