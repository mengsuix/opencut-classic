#[cfg(test)]
mod tests {
    use gpu::wgpu;

    const SHADER_SOURCES: &[(&str, &str)] = &[
        ("layer", include_str!("shaders/layer.wgsl")),
        ("blend", include_str!("shaders/blend.wgsl")),
        ("mask", include_str!("shaders/mask.wgsl")),
        ("transition_blend", include_str!("shaders/transition_blend.wgsl")),
    ];

    #[test]
    fn all_shaders_pass_naga_validation() {
        for (id, source) in SHADER_SOURCES {
            let module = wgpu::naga::front::wgsl::parse_str(source)
                .unwrap_or_else(|error| panic!("shader '{id}' failed to parse: {error}"));
            let mut validator = wgpu::naga::valid::Validator::new(
                wgpu::naga::valid::ValidationFlags::all(),
                wgpu::naga::valid::Capabilities::all(),
            );
            validator
                .validate(&module)
                .unwrap_or_else(|error| panic!("shader '{id}' failed validation: {error:?}"));
        }
    }
}
