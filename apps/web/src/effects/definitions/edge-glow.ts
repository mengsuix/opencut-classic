import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { colorToRgbVec, readEffectNumber } from "./utils";

export const edgeGlowEffectDefinition: EffectDefinition = {
	type: "edge-glow",
	get name() { return t("properties.effectEdgeGlow"); },
	keywords: ["edge", "outline", "glow", "轮廓", "描边", "发光"],
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
			key: "threshold",
			get label() { return t("properties.effectThreshold"); },
			type: "number",
			default: 0.2,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: "color",
			get label() { return t("properties.effectGlowColor"); },
			type: "color",
			default: "#66ccff",
			keyframable: false,
		},
	],
	renderer: {
		passes: [
			{
				shader: "edge-glow",
				uniforms: ({ effectParams }) => ({
					u_intensity: readEffectNumber({ params: effectParams, key: "intensity", fallback: 2 }),
					u_threshold: readEffectNumber({ params: effectParams, key: "threshold", fallback: 0.2 }),
					u_color: colorToRgbVec({
						color: effectParams.color,
						fallback: [0.4, 0.8, 1],
					}),
				}),
			},
		],
	},
};
