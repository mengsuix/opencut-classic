import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber, scalePx } from "./utils";

export const channelShiftEffectDefinition: EffectDefinition = {
	type: "channel-shift",
	get name() { return t("properties.effectChannelShift"); },
	keywords: ["rgb", "split", "glitch", "chromatic", "故障", "色差"],
	params: [
		{
			key: "offsetX",
			get label() { return t("properties.effectOffsetX"); },
			type: "number",
			default: 4,
			min: -100,
			max: 100,
			step: 0.1,
		},
		{
			key: "offsetY",
			get label() { return t("properties.effectOffsetY"); },
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 0.1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "channel-shift",
				uniforms: ({ effectParams, width, height }) => ({
					u_offset: [
						scalePx({
							value: readEffectNumber({ params: effectParams, key: "offsetX", fallback: 4 }),
							resolution: width,
							reference: 1920,
						}),
						scalePx({
							value: readEffectNumber({ params: effectParams, key: "offsetY", fallback: 0 }),
							resolution: height,
							reference: 1080,
						}),
					],
				}),
			},
		],
	},
};
