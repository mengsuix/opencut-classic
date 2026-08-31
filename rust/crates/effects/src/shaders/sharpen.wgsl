struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_amount: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let texel_size = vec2f(1.0, 1.0) / uniforms.resolution.xy;
    let amount = uniforms.u_amount.x;

    let center = textureSample(input_texture, input_sampler, input.tex_coord);
    let left = textureSample(input_texture, input_sampler, input.tex_coord - vec2f(texel_size.x, 0.0));
    let right = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(texel_size.x, 0.0));
    let top = textureSample(input_texture, input_sampler, input.tex_coord - vec2f(0.0, texel_size.y));
    let bottom = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(0.0, texel_size.y));

    let rgb = center.rgb * (1.0 + 4.0 * amount)
        - (left.rgb + right.rgb + top.rgb + bottom.rgb) * amount;
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), center.a);
}
