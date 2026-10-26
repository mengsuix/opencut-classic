import { t } from "@/i18n";
import type { ParamValues } from "@/params";

export interface TextPreset {
	key: string;
	name: string;
	params: ParamValues;
}

export const TEXT_PRESETS: TextPreset[] = [
	{
		key: "subtitle-outline",
		get name() {
			return t("assets.textPresetSubtitleOutline");
		},
		params: {
			color: "#ffffff",
			"stroke.enabled": true,
			"stroke.color": "#000000",
			"stroke.width": 2,
		},
	},
	{
		key: "subtitle-box",
		get name() {
			return t("assets.textPresetSubtitleBox");
		},
		params: {
			color: "#ffffff",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 20,
		},
	},
];

export function getTextPreset({ key }: { key: string }): TextPreset | null {
	return TEXT_PRESETS.find((preset) => preset.key === key) ?? null;
}
