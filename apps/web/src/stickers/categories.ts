import { t } from "@/i18n";

export const STICKER_CATEGORIES = {
	get all() {
		return t("assets.stickerCategoryAll");
	},
	// v0.4.0
	// logos: "Logos",
	get flags() {
		return t("assets.stickerCategoryFlags");
	},
	get shapes() {
		return t("assets.stickerCategoryShapes");
	},
};
