import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { colorToRgbVec, readEffectNumber } from "./utils";

export const chromaKeyEffectDefinition: EffectDefinition = {
	type: "chroma-key",
	get name() { return t("properties.effectChromaKey"); },
	keywords: ["chroma", "key", "green screen", "抠像", "绿幕"],
	params: [
		{
			key: "keyColor",
			get label() { return t("properties.effectKeyColor"); },
			type: "color",
			default: "#00ff00",
			keyframable: false,
		},
		{
			key: "tolerance",
			get label() { return t("properties.effectTolerance"); },
			type: "number",
			default: 0.4,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: "softness",
			get label() { return t("properties.effectSoftness"); },
			type: "number",
			default: 0.1,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "chroma-key",
				uniforms: ({ effectParams }) => ({
					u_key_color: colorToRgbVec({
						color: effectParams.keyColor,
						fallback: [0, 1, 0],
					}),
					u_tolerance: readEffectNumber({ params: effectParams, key: "tolerance", fallback: 0.4 }),
					u_softness: readEffectNumber({ params: effectParams, key: "softness", fallback: 0.1 }),
				}),
			},
		],
	},
};
