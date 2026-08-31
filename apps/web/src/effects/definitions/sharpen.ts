import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber } from "./utils";

export const sharpenEffectDefinition: EffectDefinition = {
	type: "sharpen",
	get name() { return t("properties.effectSharpen"); },
	keywords: ["sharpen", "clarity", "detail", "锐化", "清晰"],
	params: [
		{
			key: "amount",
			get label() { return t("properties.effectIntensity"); },
			type: "number",
			default: 0.5,
			min: 0,
			max: 5,
			step: 0.05,
		},
	],
	renderer: {
		passes: [
			{
				shader: "sharpen",
				uniforms: ({ effectParams }) => ({
					u_amount: readEffectNumber({ params: effectParams, key: "amount", fallback: 0.5 }),
				}),
			},
		],
	},
};
