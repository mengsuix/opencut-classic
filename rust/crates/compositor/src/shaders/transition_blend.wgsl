struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct TransitionUniforms {
    progress: f32,
    kind: u32,
    feather: f32,
    aspect: f32,
}

@group(0) @binding(0) var from_texture: texture_2d<f32>;
@group(0) @binding(1) var from_sampler: sampler;
@group(1) @binding(0) var to_texture: texture_2d<f32>;
@group(1) @binding(1) var to_sampler: sampler;
@group(2) @binding(0) var<uniform> uniforms: TransitionUniforms;

const KIND_IRIS: u32 = 0u;
const KIND_WIPE_LEFT: u32 = 1u;
const KIND_WIPE_RIGHT: u32 = 2u;
const KIND_WIPE_UP: u32 = 3u;
const KIND_WIPE_DOWN: u32 = 4u;
const KIND_STAR: u32 = 5u;

const STAR_INNER_RADIUS_RATIO: f32 = 0.45;

// Boundary radius of a 5-pointed star at polar angle `theta` (radians),
// normalized so the outer vertices sit at radius 1.
fn star_boundary_radius(theta: f32) -> f32 {
    let sector = radians(36.0);
    // Shift so a vertex (outer) is centered at -90 degrees like the DOM mask.
    let shifted = theta + radians(90.0);
    let wrapped = shifted - floor(shifted / sector) * sector;
    let t = wrapped / sector;
    // Alternate outer (1.0) / inner (0.45) vertices every 36 degrees.
    let start_outer = (floor(shifted / sector) % 2.0) == 0.0;
    let r0 = select(STAR_INNER_RADIUS_RATIO, 1.0, start_outer);
    let r1 = select(1.0, STAR_INNER_RADIUS_RATIO, start_outer);
    return mix(r0, r1, t);
}

// Returns coverage of the incoming texture in 0..1 for canvas uv (bottom-left origin).
fn incoming_coverage(uv: vec2f) -> f32 {
    let p = uv - vec2f(0.5);
    let p_aspect = vec2f(p.x * uniforms.aspect, p.y);
    let feather = max(uniforms.feather, 1e-5);
    // Half-diagonal of the aspect-corrected canvas: shape grows until it covers it.
    let max_radius = length(vec2f(uniforms.aspect * 0.5, 0.5)) + feather;

    switch uniforms.kind {
        case KIND_WIPE_LEFT {
            let edge = (uniforms.progress - 0.5) * uniforms.aspect;
            return smoothstep(edge + feather, edge - feather, p_aspect.x);
        }
        case KIND_WIPE_RIGHT {
            let edge = (0.5 - uniforms.progress) * uniforms.aspect;
            return smoothstep(edge - feather, edge + feather, p_aspect.x);
        }
        case KIND_WIPE_UP {
            let edge = (uniforms.progress - 0.5);
            return smoothstep(edge + feather, edge - feather, p.y);
        }
        case KIND_WIPE_DOWN {
            let edge = (0.5 - uniforms.progress);
            return smoothstep(edge - feather, edge + feather, p.y);
        }
        case KIND_STAR {
            let theta = atan2(p_aspect.y, p_aspect.x);
            let boundary = star_boundary_radius(theta);
            let radius = max(uniforms.progress, 1e-5) * max_radius;
            let d = length(p_aspect) / max(boundary * radius, 1e-5);
            return 1.0 - smoothstep(1.0 - feather / radius, 1.0 + feather / radius, d);
        }
        default {
            let radius = uniforms.progress * max_radius;
            let d = length(p_aspect);
            return smoothstep(radius + feather, radius - feather, d);
        }
    }
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let from_color = textureSample(from_texture, from_sampler, input.tex_coord);
    let to_color = textureSample(to_texture, to_sampler, input.tex_coord);
    let m = clamp(incoming_coverage(input.tex_coord), 0.0, 1.0);
    let rgb = mix(from_color.rgb, to_color.rgb, m);
    let alpha = mix(from_color.a, to_color.a, m);
    return vec4f(rgb, alpha);
}
