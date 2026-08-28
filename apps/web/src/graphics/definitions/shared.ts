import { t } from "@/i18n";
import type { ParamDefinition } from "@/params";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

export const STROKE_ALIGN_PARAM: ParamDefinition<"strokeAlign"> = {
	key: "strokeAlign",
	get label() { return t("properties.strokeAlign"); },
	type: "select",
	default: "center",
	group: "stroke",
	options: [
		{ value: "inside", get label() { return t("properties.strokeInside"); } },
		{ value: "center", get label() { return t("properties.strokeCenter"); } },
		{ value: "outside", get label() { return t("properties.strokeOutside"); } },
	],
};
