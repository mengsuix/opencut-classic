import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { colorToRgbVec, readEffectNumber, scalePx } from "./utils";

export const glowEffectDefinition: EffectDefinition = {
	type: "glow",
	get name() { return t("properties.effectGlow"); },
	keywords: ["glow", "bloom", "halation", "neon", "发光", "光晕", "霓虹"],
	params: [
		{
			key: "intensity",
			get label() { return t("properties.effectIntensity"); },
			type: "number",
			default: 2,
			min: 0,
			max: 10,
			step: 0.1,
		},
		{
			key: "radius",
			get label() { return t("properties.effectRadius"); },
			type: "number",
			default: 20,
			min: 0,
			max: 200,
			step: 1,
		},
		{
			key: "color",
			get label() { return t("properties.effectGlowColor"); },
			type: "color",
			default: "#ffffff",
			keyframable: false,
		},
	],
	renderer: {
		passes: [
			{
				shader: "glow",
				uniforms: ({ effectParams, height }) => ({
					u_intensity: readEffectNumber({ params: effectParams, key: "intensity", fallback: 2 }),
					u_radius: scalePx({
						value: readEffectNumber({ params: effectParams, key: "radius", fallback: 20 }),
						resolution: height,
						reference: 1080,
					}),
					u_color: colorToRgbVec({
						color: effectParams.color,
						fallback: [1, 1, 1],
					}),
				}),
			},
		],
	},
};
