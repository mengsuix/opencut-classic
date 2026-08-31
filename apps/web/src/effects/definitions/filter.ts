import { t } from "@/i18n";
import type { EffectDefinition } from "@/effects/types";
import { readEffectNumber } from "./utils";

export const FILTER_STYLES = [
	"none",
	"film",
	"teal-orange",
	"faded",
	"bw",
	"warm",
	"cool",
] as const;

export type FilterStyle = (typeof FILTER_STYLES)[number];

const FILTER_STYLE_INDEX: Record<FilterStyle, number> = {
	none: 0,
	film: 1,
	"teal-orange": 2,
	faded: 3,
	bw: 4,
	warm: 5,
	cool: 6,
};

const FILTER_STYLE_LABEL_KEYS = {
	none: "properties.effectFilterNone",
	film: "properties.effectFilterFilm",
	"teal-orange": "properties.effectFilterTealOrange",
	faded: "properties.effectFilterFaded",
	bw: "properties.effectFilterBW",
	warm: "properties.effectFilterWarm",
	cool: "properties.effectFilterCool",
} as const;

function readStyleIndex({
	params,
}: {
	params: Record<string, unknown>;
}): number {
	const raw = params.style;
	const style = FILTER_STYLES.find((known) => known === raw) ?? "film";
	return FILTER_STYLE_INDEX[style];
}

export const filterEffectDefinition: EffectDefinition = {
	type: "filter",
	get name() {
		return t("properties.effectFilter");
	},
	keywords: ["filter", "lut", "style", "grade", "滤镜", "风格"],
	params: [
		{
			key: "style",
			get label() {
				return t("properties.effectFilterStyle");
			},
			type: "select",
			default: "film",
			keyframable: false,
			options: FILTER_STYLES.map((style) => ({
				value: style,
				get label() {
					return t(FILTER_STYLE_LABEL_KEYS[style]);
				},
			})),
		},
		{
			key: "intensity",
			get label() {
				return t("properties.effectFilterIntensity");
			},
			type: "number",
			default: 1,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "filter",
				uniforms: ({ effectParams }) => ({
					u_style: readStyleIndex({ params: effectParams }),
					u_intensity: readEffectNumber({
						params: effectParams,
						key: "intensity",
						fallback: 1,
					}),
				}),
			},
		],
	},
};
