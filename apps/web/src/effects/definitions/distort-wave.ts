import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber, scalePx } from "./utils";

export const distortWaveEffectDefinition: EffectDefinition = {
	type: "distort-wave",
	get name() { return t("properties.effectDistortWave"); },
	keywords: ["wave", "distort", "warp", "波浪", "扭曲"],
	params: [
		{
			key: "amplitude",
			get label() { return t("properties.effectAmplitude"); },
			type: "number",
			default: 10,
			min: 0,
			max: 100,
			step: 0.5,
		},
		{
			key: "frequency",
			get label() { return t("properties.effectFrequency"); },
			type: "number",
			default: 10,
			min: 0.1,
			max: 100,
			step: 0.1,
		},
		{
			key: "phase",
			get label() { return t("properties.effectPhase"); },
			type: "number",
			default: 0,
			min: -360,
			max: 360,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "distort-wave",
				uniforms: ({ effectParams, width }) => ({
					u_amplitude: scalePx({
						value: readEffectNumber({ params: effectParams, key: "amplitude", fallback: 10 }),
						resolution: width,
						reference: 1920,
					}),
					u_frequency: readEffectNumber({ params: effectParams, key: "frequency", fallback: 10 }),
					u_phase:
						(readEffectNumber({ params: effectParams, key: "phase", fallback: 0 }) *
							Math.PI) /
						180,
				}),
			},
		],
	},
};
