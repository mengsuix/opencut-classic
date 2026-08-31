struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_offset: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let offset_uv = uniforms.u_offset.xy / uniforms.resolution.xy;
    let red = textureSample(input_texture, input_sampler, input.tex_coord + offset_uv).r;
    let base = textureSample(input_texture, input_sampler, input.tex_coord);
    let blue = textureSample(input_texture, input_sampler, input.tex_coord - offset_uv).b;
    return vec4f(red, base.g, blue, base.a);
}
