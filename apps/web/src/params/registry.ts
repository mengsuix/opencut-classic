import { t } from "@/i18n";
import type {
	ParamDefinition,
	ParamValue,
	ParamValues,
} from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { BlendMode } from "@/rendering";
import type {
	ElementType,
	TimelineElement,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
} from "@/text/background";

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({
		key,
		definition,
	}: {
		key: TKey;
		definition: TDefinition;
	}): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			throw new Error(`Unknown ${this.entityName}: ${key}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; label: string }> = [
	{ value: "normal", get label() { return t("properties.blendNormal"); } },
	{ value: "darken", get label() { return t("properties.blendDarken"); } },
	{ value: "multiply", get label() { return t("properties.blendMultiply"); } },
	{ value: "color-burn", get label() { return t("properties.blendColorBurn"); } },
	{ value: "lighten", get label() { return t("properties.blendLighten"); } },
	{ value: "screen", get label() { return t("properties.blendScreen"); } },
	{ value: "plus-lighter", get label() { return t("properties.blendPlusLighter"); } },
	{ value: "color-dodge", get label() { return t("properties.blendColorDodge"); } },
	{ value: "overlay", get label() { return t("properties.blendOverlay"); } },
	{ value: "soft-light", get label() { return t("properties.blendSoftLight"); } },
	{ value: "hard-light", get label() { return t("properties.blendHardLight"); } },
	{ value: "difference", get label() { return t("properties.blendDifference"); } },
	{ value: "exclusion", get label() { return t("properties.blendExclusion"); } },
	{ value: "hue", get label() { return t("properties.blendHue"); } },
	{ value: "saturation", get label() { return t("properties.blendSaturation"); } },
	{ value: "color", get label() { return t("properties.blendColor"); } },
	{ value: "luminosity", get label() { return t("properties.blendLuminosity"); } },
];

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		get label() { return t("properties.positionX"); },
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.positionY",
		get label() { return t("properties.positionY"); },
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.scaleX",
		get label() { return t("properties.scaleX"); },
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.scaleY",
		get label() { return t("properties.scaleY"); },
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.rotate",
		get label() { return t("properties.rotate"); },
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
	},
	{
		key: "opacity",
		get label() { return t("properties.opacity"); },
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "blendMode",
		get label() { return t("properties.blendMode"); },
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		get label() { return t("properties.volume"); },
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
	},
	{
		key: "muted",
		get label() { return t("properties.muted"); },
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		get label() { return t("properties.content"); },
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		get label() { return t("properties.fontFamily"); },
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		get label() { return t("properties.fontSize"); },
		type: "number",
		default: 15,
		min: 1,
		step: 1,
	},
	{
		key: "color",
		get label() { return t("properties.color"); },
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textAlign",
		get label() { return t("properties.textAlign"); },
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", get label() { return t("properties.alignLeft"); } },
			{ value: "center", get label() { return t("properties.alignCenter"); } },
			{ value: "right", get label() { return t("properties.alignRight"); } },
		],
	},
	{
		key: "fontWeight",
		get label() { return t("properties.fontWeight"); },
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", get label() { return t("properties.weightNormal"); } },
			{ value: "bold", get label() { return t("properties.weightBold"); } },
		],
	},
	{
		key: "fontStyle",
		get label() { return t("properties.fontStyle"); },
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", get label() { return t("properties.styleNormal"); } },
			{ value: "italic", get label() { return t("properties.styleItalic"); } },
		],
	},
	{
		key: "textDecoration",
		get label() { return t("properties.textDecoration"); },
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", get label() { return t("properties.decorationNone"); } },
			{ value: "underline", get label() { return t("properties.decorationUnderline"); } },
			{ value: "line-through", get label() { return t("properties.decorationLineThrough"); } },
		],
	},
	{
		key: "letterSpacing",
		get label() { return t("properties.letterSpacing"); },
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
	},
	{
		key: "lineHeight",
		get label() { return t("properties.lineHeight"); },
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
	},
	{
		key: "background.enabled",
		get label() { return t("properties.backgroundEnabled"); },
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		get label() { return t("properties.backgroundColor"); },
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		get label() { return t("properties.backgroundRadius"); },
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		get label() { return t("properties.backgroundPaddingX"); },
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		get label() { return t("properties.backgroundPaddingY"); },
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		get label() { return t("properties.backgroundOffsetX"); },
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		get label() { return t("properties.backgroundOffsetY"); },
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

export const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [...visualElementParams, ...audioElementParams],
});
elementParamRegistry.register({ key: "image", definition: visualElementParams });
elementParamRegistry.register({
	key: "text",
	definition: [...textElementParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "sticker",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "graphic",
	definition: visualElementParams,
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}

export function buildElementParamValues({
	element,
}: {
	element: TimelineElement;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of getElementParams({ element })) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

