import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber } from "./utils";

export const colorAdjustEffectDefinition: EffectDefinition = {
	type: "color-adjust",
	get name() { return t("properties.effectColorAdjust"); },
	keywords: ["color", "grade", "brightness", "contrast", "saturation", "temperature", "调色"],
	params: [
		{
			key: "brightness",
			get label() { return t("properties.effectBrightness"); },
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "contrast",
			get label() { return t("properties.effectContrast"); },
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "saturation",
			get label() { return t("properties.effectSaturation"); },
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "temperature",
			get label() { return t("properties.effectTemperature"); },
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "color-adjust",
				uniforms: ({ effectParams }) => ({
					u_brightness: readEffectNumber({ params: effectParams, key: "brightness", fallback: 0 }),
					u_contrast: readEffectNumber({ params: effectParams, key: "contrast", fallback: 0 }),
					u_saturation: readEffectNumber({ params: effectParams, key: "saturation", fallback: 0 }),
					u_temperature: readEffectNumber({ params: effectParams, key: "temperature", fallback: 0 }),
				}),
			},
		],
	},
};
