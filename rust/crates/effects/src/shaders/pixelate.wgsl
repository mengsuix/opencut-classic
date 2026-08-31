struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_size: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let block_uv = vec2f(max(uniforms.u_size.x, 1.0)) / uniforms.resolution.xy;
    let sample_uv = floor(input.tex_coord / block_uv) * block_uv + block_uv * 0.5;
    return textureSample(input_texture, input_sampler, sample_uv);
}
