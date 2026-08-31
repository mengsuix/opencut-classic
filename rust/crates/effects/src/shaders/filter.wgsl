struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec4f,
    u_style: vec4f,
    u_intensity: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_WEIGHTS = vec3f(0.2126, 0.7152, 0.0722);

// film: smoothstep S-curve, lifted blacks, slightly reduced saturation.
fn style_film(rgb: vec3f) -> vec3f {
    var c = rgb * rgb * (vec3f(3.0) - 2.0 * rgb);
    c = c * 0.92 + vec3f(0.04);
    let luma = dot(c, LUMA_WEIGHTS);
    return mix(vec3f(luma), c, 0.85);
}

// teal-orange: split toning, teal shadows / orange highlights.
fn style_teal_orange(rgb: vec3f) -> vec3f {
    let luma = dot(rgb, LUMA_WEIGHTS);
    let shadows = vec3f(-0.02, 0.03, 0.06) * (1.0 - luma);
    let highlights = vec3f(0.06, 0.02, -0.03) * luma;
    return rgb + shadows + highlights;
}

// faded: lifted blacks, reduced saturation, slight warm cast.
fn style_faded(rgb: vec3f) -> vec3f {
    let c = rgb * 0.85 + vec3f(0.06, 0.05, 0.04);
    let luma = dot(c, LUMA_WEIGHTS);
    return mix(vec3f(luma), c, 0.7);
}

// bw: luminance with a slight contrast push.
fn style_bw(rgb: vec3f) -> vec3f {
    let luma = dot(rgb, LUMA_WEIGHTS);
    return (vec3f(luma) - vec3f(0.5)) * 1.1 + vec3f(0.5);
}

// warm: red up, blue down, slight saturation boost.
fn style_warm(rgb: vec3f) -> vec3f {
    let c = rgb + vec3f(0.08, 0.02, -0.06);
    let luma = dot(c, LUMA_WEIGHTS);
    return mix(vec3f(luma), c, 1.1);
}

// cool: blue up, red down, slight contrast push.
fn style_cool(rgb: vec3f) -> vec3f {
    let c = rgb + vec3f(-0.05, 0.01, 0.07);
    let luma = dot(c, LUMA_WEIGHTS);
    return mix(vec3f(luma), c, 1.05);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let style = i32(uniforms.u_style.x + 0.5);
    let intensity = clamp(uniforms.u_intensity.x, 0.0, 1.0);

    var styled = color.rgb;
    switch style {
        case 1: { styled = style_film(color.rgb); }
        case 2: { styled = style_teal_orange(color.rgb); }
        case 3: { styled = style_faded(color.rgb); }
        case 4: { styled = style_bw(color.rgb); }
        case 5: { styled = style_warm(color.rgb); }
        case 6: { styled = style_cool(color.rgb); }
        default: {}
    }

    let rgb = mix(color.rgb, clamp(styled, vec3f(0.0), vec3f(1.0)), intensity);
    return vec4f(rgb, color.a);
}
