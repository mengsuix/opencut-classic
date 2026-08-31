struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_amount: vec4f,
    u_time: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let time = uniforms.u_time.x;
    let seed = input.tex_coord * uniforms.resolution.xy
        + vec2f(fract(time * 61.7) * 100.0, fract(time * 83.3) * 100.0);
    let grain = fract(sin(dot(seed, vec2f(12.9898, 78.233))) * 43758.5453);
    let rgb = color.rgb + vec3f((grain - 0.5) * uniforms.u_amount.x);
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), color.a);
}
