import type { ElementType, TrackType } from "@/timeline";
import { t, type MessageKey } from "@/i18n";

const ELEMENT_TYPE_LABEL_KEYS: Record<ElementType, MessageKey> = {
	audio: "timeline.typeAudio",
	text: "timeline.typeText",
	sticker: "timeline.typeSticker",
	graphic: "timeline.typeGraphic",
	effect: "timeline.typeEffect",
	video: "timeline.typeVideo",
	image: "timeline.typeImage",
};

const TRACK_TYPE_LABEL_KEYS: Record<TrackType, MessageKey> = {
	video: "timeline.typeVideo",
	text: "timeline.typeText",
	audio: "timeline.typeAudio",
	graphic: "timeline.typeGraphic",
	effect: "timeline.typeEffect",
};

const ELEMENT_TRACK_MAP: Record<ElementType, TrackType> = {
	audio: "audio",
	text: "text",
	sticker: "graphic",
	graphic: "graphic",
	effect: "effect",
	video: "video",
	image: "video",
};

export function getTrackTypeForElementType({
	elementType,
}: {
	elementType: ElementType;
}): TrackType {
	return ELEMENT_TRACK_MAP[elementType];
}

export function canElementGoOnTrack({
	elementType,
	trackType,
}: {
	elementType: ElementType;
	trackType: TrackType;
}): boolean {
	return getTrackTypeForElementType({ elementType }) === trackType;
}

export function validateElementTrackCompatibility({
	element,
	track,
}: {
	element: { type: ElementType };
	track: { type: TrackType };
}): { isValid: boolean; errorMessage?: string } {
	const isValid = canElementGoOnTrack({
		elementType: element.type,
		trackType: track.type,
	});

	if (!isValid) {
		return {
			isValid: false,
			errorMessage: t("timeline.elementCannotBePlaced", {
				elementType: t(ELEMENT_TYPE_LABEL_KEYS[element.type]),
				trackType: t(TRACK_TYPE_LABEL_KEYS[track.type]),
			}),
		};
	}

	return { isValid: true };
}
