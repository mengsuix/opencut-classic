use std::collections::HashMap;

use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

/// Uniform buffer ABI shared by every effect shader: a vec4<f32> resolution
/// slot (xy = pixel size) followed by one vec4<f32> slot per declared uniform,
/// in declaration order. Numbers land in .x, vectors in .xy(zw).
struct ShaderSpec {
    id: &'static str,
    source: &'static str,
    /// Ordered uniform names; each occupies one vec4<f32> buffer slot and one
    /// vec4f field in the shader's `EffectUniforms` struct.
    uniforms: &'static [&'static str],
}

const SHADER_SPECS: &[ShaderSpec] = &[
    ShaderSpec {
        id: "gaussian-blur",
        source: include_str!("shaders/gaussian_blur.wgsl"),
        uniforms: &["u_sigma", "u_step", "u_direction"],
    },
    ShaderSpec {
        id: "color-adjust",
        source: include_str!("shaders/color_adjust.wgsl"),
        uniforms: &["u_brightness", "u_contrast", "u_saturation", "u_temperature"],
    },
    ShaderSpec {
        id: "chroma-key",
        source: include_str!("shaders/chroma_key.wgsl"),
        uniforms: &["u_key_color", "u_tolerance", "u_softness"],
    },
    ShaderSpec {
        id: "channel-shift",
        source: include_str!("shaders/channel_shift.wgsl"),
        uniforms: &["u_offset"],
    },
    ShaderSpec {
        id: "sharpen",
        source: include_str!("shaders/sharpen.wgsl"),
        uniforms: &["u_amount"],
    },
    ShaderSpec {
        id: "pixelate",
        source: include_str!("shaders/pixelate.wgsl"),
        uniforms: &["u_size"],
    },
    ShaderSpec {
        id: "edge-glow",
        source: include_str!("shaders/edge_glow.wgsl"),
        uniforms: &["u_intensity", "u_threshold", "u_color"],
    },
    ShaderSpec {
        id: "distort-wave",
        source: include_str!("shaders/distort_wave.wgsl"),
        uniforms: &["u_amplitude", "u_frequency", "u_phase"],
    },
    ShaderSpec {
        id: "noise",
        source: include_str!("shaders/noise.wgsl"),
        uniforms: &["u_amount", "u_time"],
    },
    ShaderSpec {
        id: "glow",
        source: include_str!("shaders/glow.wgsl"),
        uniforms: &["u_intensity", "u_radius", "u_color"],
    },
    ShaderSpec {
        id: "vignette",
        source: include_str!("shaders/vignette.wgsl"),
        uniforms: &["u_amount", "u_softness"],
    },
    ShaderSpec {
        id: "filter",
        source: include_str!("shaders/filter.wgsl"),
        uniforms: &["u_style", "u_intensity"],
    },
];

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    uniform_layouts: HashMap<String, Vec<String>>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        let mut pipelines = HashMap::new();
        let mut uniform_layouts = HashMap::new();
        for spec in SHADER_SPECS {
            let fragment_module =
                context
                    .device()
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some(spec.id),
                        source: wgpu::ShaderSource::Wgsl(spec.source.into()),
                    });
            let pipeline =
                context
                    .device()
                    .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some(spec.id),
                        layout: Some(&pipeline_layout),
                        vertex: wgpu::VertexState {
                            module: &vertex_shader_module,
                            entry_point: Some("vertex_main"),
                            buffers: &[wgpu::VertexBufferLayout {
                                array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x2,
                                    offset: 0,
                                    shader_location: 0,
                                }],
                            }],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        },
                        fragment: Some(wgpu::FragmentState {
                            module: &fragment_module,
                            entry_point: Some("fragment_main"),
                            targets: &[Some(wgpu::ColorTargetState {
                                format: context.texture_format(),
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        }),
                        primitive: wgpu::PrimitiveState::default(),
                        depth_stencil: None,
                        multisample: wgpu::MultisampleState::default(),
                        multiview_mask: None,
                        cache: None,
                    });
            pipelines.insert(spec.id.to_string(), pipeline);
            uniform_layouts.insert(
                spec.id.to_string(),
                spec.uniforms.iter().map(|name| name.to_string()).collect(),
            );
        }

        Self {
            uniform_bind_group_layout,
            pipelines,
            uniform_layouts,
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let packed_uniforms = self.pack_effect_uniforms(pass, width, height)?;
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::cast_slice(&packed_uniforms),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }

    fn pack_effect_uniforms(
        &self,
        pass: &EffectPass,
        width: u32,
        height: u32,
    ) -> Result<Vec<f32>, EffectsError> {
        let layout =
            self.uniform_layouts
                .get(&pass.shader)
                .ok_or_else(|| EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                })?;
        pack_effect_uniforms(layout, pass, width, height)
    }
}

fn pack_effect_uniforms(
    layout: &[String],
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<Vec<f32>, EffectsError> {
    for uniform in pass.uniforms.keys() {
        if !layout.iter().any(|name| name == uniform) {
            return Err(EffectsError::UnsupportedUniform {
                shader: pass.shader.clone(),
                uniform: uniform.clone(),
            });
        }
    }

    let mut data = Vec::with_capacity(4 * (1 + layout.len()));
    data.extend_from_slice(&[width as f32, height as f32, 0.0, 0.0]);
    for name in layout {
        match pass.uniforms.get(name) {
            Some(UniformValue::Number(value)) => {
                data.extend_from_slice(&[*value, 0.0, 0.0, 0.0]);
            }
            Some(UniformValue::Vector(values)) => {
                let mut slot = [0.0_f32; 4];
                for (index, value) in values.iter().take(4).enumerate() {
                    slot[index] = *value;
                }
                data.extend_from_slice(&slot);
            }
            None => {
                return Err(EffectsError::MissingUniform {
                    shader: pass.shader.clone(),
                    uniform: name.clone(),
                });
            }
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass(uniforms: &[(&str, UniformValue)]) -> EffectPass {
        EffectPass {
            shader: "test".to_string(),
            uniforms: uniforms
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect(),
        }
    }

    #[test]
    fn packs_resolution_slot_then_uniforms_in_layout_order() {
        let layout = vec!["u_b".to_string(), "u_a".to_string()];
        let effect_pass = pass(&[
            ("u_a", UniformValue::Number(2.0)),
            ("u_b", UniformValue::Vector(vec![3.0, 4.0])),
        ]);

        let packed = pack_effect_uniforms(&layout, &effect_pass, 1920, 1080).unwrap();

        assert_eq!(
            packed,
            vec![1920.0, 1080.0, 0.0, 0.0, 3.0, 4.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0]
        );
    }

    #[test]
    fn errors_on_missing_uniform() {
        let layout = vec!["u_a".to_string()];
        let effect_pass = pass(&[]);

        let result = pack_effect_uniforms(&layout, &effect_pass, 100, 100);

        assert!(matches!(result, Err(EffectsError::MissingUniform { .. })));
    }

    #[test]
    fn errors_on_undeclared_uniform() {
        let layout = vec!["u_a".to_string()];
        let effect_pass = pass(&[
            ("u_a", UniformValue::Number(1.0)),
            ("u_extra", UniformValue::Number(9.0)),
        ]);

        let result = pack_effect_uniforms(&layout, &effect_pass, 100, 100);

        assert!(matches!(
            result,
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }

    #[test]
    fn truncates_vectors_longer_than_four_components() {
        let layout = vec!["u_a".to_string()];
        let effect_pass = pass(&[("u_a", UniformValue::Vector(vec![1.0, 2.0, 3.0, 4.0, 5.0]))]);

        let packed = pack_effect_uniforms(&layout, &effect_pass, 1, 1).unwrap();

        assert_eq!(
            packed,
            vec![1.0, 1.0, 0.0, 0.0, 1.0, 2.0, 3.0, 4.0]
        );
    }

    #[test]
    fn all_builtin_shaders_pass_naga_validation() {
        for spec in SHADER_SPECS {
            let module = wgpu::naga::front::wgsl::parse_str(spec.source)
                .unwrap_or_else(|error| panic!("shader '{}' failed to parse: {error}", spec.id));
            let mut validator = wgpu::naga::valid::Validator::new(
                wgpu::naga::valid::ValidationFlags::all(),
                wgpu::naga::valid::Capabilities::all(),
            );
            validator
                .validate(&module)
                .unwrap_or_else(|error| panic!("shader '{}' failed validation: {error:?}", spec.id));
        }
    }

    #[test]
    fn shader_uniform_structs_match_declared_layouts() {
        for spec in SHADER_SPECS {
            let module = wgpu::naga::front::wgsl::parse_str(spec.source).unwrap();
            let uniforms_struct = module
                .types
                .iter()
                .find(|(_, ty)| ty.name.as_deref() == Some("EffectUniforms"))
                .unwrap_or_else(|| panic!("shader '{}' has no EffectUniforms struct", spec.id));
            let wgpu::naga::TypeInner::Struct { members, .. } = &uniforms_struct.1.inner else {
                panic!("shader '{}' EffectUniforms is not a struct", spec.id);
            };
            // resolution slot + one vec4 field per declared uniform
            assert_eq!(
                members.len(),
                1 + spec.uniforms.len(),
                "shader '{}' EffectUniforms field count mismatch with declared uniforms",
                spec.id,
            );
        }
    }
}
