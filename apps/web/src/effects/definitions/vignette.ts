import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber } from "./utils";

export const vignetteEffectDefinition: EffectDefinition = {
	type: "vignette",
	get name() { return t("properties.effectVignette"); },
	keywords: ["vignette", "darken", "corners", "暗角", "四角压暗"],
	params: [
		{
			key: "amount",
			get label() { return t("properties.effectIntensity"); },
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: "softness",
			get label() { return t("properties.effectSoftness"); },
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
				shader: "vignette",
				uniforms: ({ effectParams }) => ({
					u_amount: readEffectNumber({ params: effectParams, key: "amount", fallback: 0.5 }),
					u_softness: readEffectNumber({ params: effectParams, key: "softness", fallback: 0.5 }),
				}),
			},
		],
	},
};
