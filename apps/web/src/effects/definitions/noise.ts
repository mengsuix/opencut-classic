import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber } from "./utils";

export const noiseEffectDefinition: EffectDefinition = {
	type: "noise",
	get name() { return t("properties.effectNoise"); },
	keywords: ["noise", "grain", "film", "噪点", "颗粒"],
	params: [
		{
			key: "amount",
			get label() { return t("properties.effectIntensity"); },
			type: "number",
			default: 0.15,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "noise",
				uniforms: ({ effectParams, time }) => ({
					u_amount: readEffectNumber({ params: effectParams, key: "amount", fallback: 0.15 }),
					u_time: time,
				}),
			},
		],
	},
};
