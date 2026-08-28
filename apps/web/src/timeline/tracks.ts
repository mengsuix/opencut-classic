import type { TrackType } from "@/timeline";
import { t } from "@/i18n";

export const DEFAULT_TRACK_NAMES: Record<TrackType, string> = {
	get video() {
		return t("timeline.videoTrack");
	},
	get text() {
		return t("timeline.textTrack");
	},
	get audio() {
		return t("timeline.audioTrack");
	},
	get graphic() {
		return t("timeline.graphicTrack");
	},
	get effect() {
		return t("timeline.effectTrack");
	},
};
