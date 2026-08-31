import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber, scalePx } from "./utils";

export const pixelateEffectDefinition: EffectDefinition = {
	type: "pixelate",
	get name() { return t("properties.effectPixelate"); },
	keywords: ["pixelate", "mosaic", "马赛克", "像素"],
	params: [
		{
			key: "size",
			get label() { return t("properties.size"); },
			type: "number",
			default: 12,
			min: 1,
			max: 200,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "pixelate",
				uniforms: ({ effectParams, height }) => ({
					u_size: scalePx({
						value: readEffectNumber({ params: effectParams, key: "size", fallback: 12 }),
						resolution: height,
						reference: 1080,
					}),
				}),
			},
		],
	},
};
