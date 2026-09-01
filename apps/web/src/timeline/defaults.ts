import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type { TTimelineViewState } from "@/project/types";
import type { BlendMode, Transform } from "@/rendering";
import { ZERO_MEDIA_TIME } from "@/wasm";
import type { TextElement } from "./types";
import { t } from "@/i18n";

const defaultTransform: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

const defaultOpacity = 1;
const defaultBlendMode: BlendMode = "normal";
const defaultVolume = 0;

const defaultTextLetterSpacing = 0;
const defaultTextLineHeight = 1.2;

const defaultTextBackground = {
	enabled: false,
	color: "#000000",
	cornerRadius: 0,
	paddingX: 30,
	paddingY: 42,
	offsetX: 0,
	offsetY: 0,
};

const defaultTextStroke = {
	enabled: false,
	color: "#000000",
	width: 2,
};

const defaultTextShadow = {
	enabled: false,
	color: "#000000",
	blur: 2,
	offsetX: 0,
	offsetY: 1,
};

const defaultTextGradient = {
	enabled: false,
	color: "#ffd700",
	angle: 90,
};

const defaultTextAnimIn = {
	type: "none",
	duration: 0.5,
};

const defaultTextAnimOut = {
	type: "none",
	duration: 0.5,
};

const defaultTextAnimLoop = {
	type: "none",
	duration: 1,
};

const defaultTextElement: Omit<TextElement, "id"> = {
	type: "text",
	get name() {
		return t("timeline.defaultTextName");
	},
	duration: DEFAULT_NEW_ELEMENT_DURATION,
	startTime: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {
		get content() {
			return t("timeline.defaultTextContent");
		},
		fontSize: 15,
		fontFamily: "Arial",
		color: "#ffffff",
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		"background.enabled": defaultTextBackground.enabled,
		"background.color": defaultTextBackground.color,
		"background.cornerRadius": defaultTextBackground.cornerRadius,
		"background.paddingX": defaultTextBackground.paddingX,
		"background.paddingY": defaultTextBackground.paddingY,
		"background.offsetX": defaultTextBackground.offsetX,
		"background.offsetY": defaultTextBackground.offsetY,
		"stroke.enabled": defaultTextStroke.enabled,
		"stroke.color": defaultTextStroke.color,
		"stroke.width": defaultTextStroke.width,
		"shadow.enabled": defaultTextShadow.enabled,
		"shadow.color": defaultTextShadow.color,
		"shadow.blur": defaultTextShadow.blur,
		"shadow.offsetX": defaultTextShadow.offsetX,
		"shadow.offsetY": defaultTextShadow.offsetY,
		"gradient.enabled": defaultTextGradient.enabled,
		"gradient.color": defaultTextGradient.color,
		"gradient.angle": defaultTextGradient.angle,
		"animIn.type": defaultTextAnimIn.type,
		"animIn.duration": defaultTextAnimIn.duration,
		"animOut.type": defaultTextAnimOut.type,
		"animOut.duration": defaultTextAnimOut.duration,
		"animLoop.type": defaultTextAnimLoop.type,
		"animLoop.duration": defaultTextAnimLoop.duration,
		"transform.positionX": defaultTransform.position.x,
		"transform.positionY": defaultTransform.position.y,
		"transform.scaleX": defaultTransform.scaleX,
		"transform.scaleY": defaultTransform.scaleY,
		"transform.rotate": defaultTransform.rotate,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
	},
};

const defaultTimelineViewState: TTimelineViewState = {
	zoomLevel: 1,
	scrollLeft: 0,
	playheadTime: ZERO_MEDIA_TIME,
};

export const DEFAULTS = {
	element: {
		transform: defaultTransform,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
		volume: defaultVolume,
	},
	text: {
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		background: defaultTextBackground,
		stroke: defaultTextStroke,
		shadow: defaultTextShadow,
		gradient: defaultTextGradient,
		animIn: defaultTextAnimIn,
		animOut: defaultTextAnimOut,
		animLoop: defaultTextAnimLoop,
		element: defaultTextElement,
	},
	timeline: {
		viewState: defaultTimelineViewState,
	},
};
