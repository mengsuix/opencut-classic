struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_amplitude: vec4f,
    u_frequency: vec4f,
    u_phase: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let amplitude_uv = uniforms.u_amplitude.x / uniforms.resolution.x;
    let wave = sin(input.tex_coord.y * uniforms.u_frequency.x + uniforms.u_phase.x);
    let sample_uv = vec2f(input.tex_coord.x + wave * amplitude_uv, input.tex_coord.y);
    return textureSample(input_texture, input_sampler, sample_uv);
}
