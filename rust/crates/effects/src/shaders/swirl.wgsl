struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_angle: vec4f,
    u_radius: vec4f,
    u_center: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let center = uniforms.u_center.xy;
    let aspect = uniforms.resolution.x / uniforms.resolution.y;
    let radius_uv = uniforms.u_radius.x / uniforms.resolution.y;
    if (radius_uv <= 0.0) {
        return textureSample(input_texture, input_sampler, input.tex_coord);
    }

    let delta = input.tex_coord - center;
    let delta_fixed = vec2f(delta.x * aspect, delta.y);
    let dist = length(delta_fixed);
    if (dist >= radius_uv) {
        return textureSample(input_texture, input_sampler, input.tex_coord);
    }

    let strength = 1.0 - dist / radius_uv;
    let angle = uniforms.u_angle.x * strength * strength;
    let s = sin(angle);
    let c = cos(angle);
    let rotated = vec2f(
        delta_fixed.x * c - delta_fixed.y * s,
        delta_fixed.x * s + delta_fixed.y * c
    );
    let sample_uv = center + vec2f(rotated.x / aspect, rotated.y);
    return textureSample(input_texture, input_sampler, sample_uv);
}
