struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_amount: vec4f,
    u_softness: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let amount = clamp(uniforms.u_amount.x, 0.0, 1.0);
    // keep smoothstep edge0 strictly below edge1
    let softness = clamp(uniforms.u_softness.x, 0.02, 1.0);

    let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
    let centered = (input.tex_coord - vec2f(0.5)) * vec2f(aspect, 1.0);
    let max_dist = 0.5 * length(vec2f(aspect, 1.0));
    let dist = length(centered) / max(max_dist, 0.0001);

    let start = 1.0 - softness;
    let falloff = smoothstep(start, 1.0, dist) * amount;

    return vec4f(color.rgb * (1.0 - falloff), color.a);
}
