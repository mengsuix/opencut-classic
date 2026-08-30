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
		key: "subtitle-yellow",
		get name() {
			return t("assets.textPresetSubtitleYellow");
		},
		params: {
			color: "#ffe234",
			fontWeight: "bold",
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
	{
		key: "title-gradient",
		get name() {
			return t("assets.textPresetTitleGradient");
		},
		params: {
			fontSize: 24,
			fontWeight: "bold",
			color: "#ffffff",
			"gradient.enabled": true,
			"gradient.color": "#ffd700",
			"gradient.angle": 90,
		},
	},
	{
		key: "title-shadow",
		get name() {
			return t("assets.textPresetTitleShadow");
		},
		params: {
			fontSize: 24,
			fontWeight: "bold",
			color: "#ffffff",
			"shadow.enabled": true,
			"shadow.color": "#000000",
			"shadow.blur": 3,
			"shadow.offsetY": 1.5,
		},
	},
	{
		key: "typewriter",
		get name() {
			return t("assets.textPresetTypewriter");
		},
		params: {
			"animIn.type": "typewriter",
			"animIn.duration": 1.5,
		},
	},
	{
		key: "pop-in",
		get name() {
			return t("assets.textPresetPopIn");
		},
		params: {
			fontSize: 24,
			fontWeight: "bold",
			"animIn.type": "pop",
			"animIn.duration": 0.5,
		},
	},
];

export function getTextPreset({ key }: { key: string }): TextPreset | null {
	return TEXT_PRESETS.find((preset) => preset.key === key) ?? null;
}
