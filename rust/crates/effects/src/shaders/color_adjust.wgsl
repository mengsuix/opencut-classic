struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_brightness: vec4f,
    u_contrast: vec4f,
    u_saturation: vec4f,
    u_temperature: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_WEIGHTS = vec3f(0.2126, 0.7152, 0.0722);

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let brightness = uniforms.u_brightness.x;
    let contrast = uniforms.u_contrast.x;
    let saturation = uniforms.u_saturation.x;
    let temperature = uniforms.u_temperature.x;

    var rgb = color.rgb + vec3f(brightness);
    rgb = (rgb - vec3f(0.5)) * (1.0 + contrast) + vec3f(0.5);
    let luma = dot(rgb, LUMA_WEIGHTS);
    rgb = mix(vec3f(luma), rgb, 1.0 + saturation);
    rgb = rgb + vec3f(temperature * 0.1, 0.0, -temperature * 0.1);

    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), color.a);
}
