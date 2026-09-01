import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber, scalePx } from "./utils";

export const swirlEffectDefinition: EffectDefinition = {
	type: "swirl",
	get name() { return t("properties.effectSwirl"); },
	keywords: ["swirl", "twirl", "vortex", "漩涡", "旋涡", "扭曲"],
	params: [
		{
			key: "angle",
			get label() { return t("properties.effectSwirlAngle"); },
			type: "number",
			default: 90,
			min: -360,
			max: 360,
			step: 1,
		},
		{
			key: "radius",
			get label() { return t("properties.effectSwirlRadius"); },
			type: "number",
			default: 300,
			min: 0,
			max: 2000,
			step: 1,
		},
		{
			key: "centerX",
			get label() { return t("properties.effectCenterX"); },
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: "centerY",
			get label() { return t("properties.effectCenterY"); },
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "swirl",
				uniforms: ({ effectParams, width }) => ({
					u_angle:
						(readEffectNumber({ params: effectParams, key: "angle", fallback: 90 }) *
							Math.PI) /
						180,
					u_radius: scalePx({
						value: readEffectNumber({ params: effectParams, key: "radius", fallback: 300 }),
						resolution: width,
						reference: 1920,
					}),
					u_center: [
						readEffectNumber({ params: effectParams, key: "centerX", fallback: 0.5 }),
						readEffectNumber({ params: effectParams, key: "centerY", fallback: 0.5 }),
					],
				}),
			},
		],
	},
};
