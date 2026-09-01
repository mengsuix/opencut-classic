import type {
	AnimationInterpolation,
	AnimationPath,
	NumericSpec,
} from "@/animation/types";
import {
	parseEffectParamPath,
} from "@/animation/effect-param-channel";
import {
	parseGraphicParamPath,
} from "@/animation/graphic-param-channel";
import {
	parseMaskParamPath,
} from "@/animation/mask-param-channel";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { getGraphicDefinition } from "@/graphics";
import { getMaskDefinition, registerDefaultMasks } from "@/masks";
import type { Mask } from "@/masks/types";
import {
	coerceParamValue,
	getParamDefaultInterpolation,
	getParamChannelLayout,
	getParamNumericRange,
	type ParamChannelLayout,
	type ParamDefinition,
	type ParamValue,
	type ParamValues,
} from "@/params";
import {
	getElementParam,
} from "@/params/registry";
import { NUMBER_CHANNEL_LAYOUT } from "@/params";
import { TIME_REMAP_PATH } from "@/retime/resolve";
import type { TimelineElement } from "@/timeline";
import { isMaskableElement, isVisualElement } from "@/timeline/element-utils";

export interface AnimationPathDescriptor {
	channelLayout: ParamChannelLayout;
	defaultInterpolation: AnimationInterpolation;
	numericRanges?: Partial<Record<string, NumericSpec>>;
	coerceValue: ({ value }: { value: ParamValue }) => ParamValue | null;
	getBaseValue: () => ParamValue | null;
	setBaseValue: ({ value }: { value: ParamValue }) => TimelineElement;
}

// Leaf params expose a single component named "value". Composite params don't
// carry numeric ranges yet — revisit when one does.
function paramNumericRanges({
	param,
}: {
	param: ParamDefinition;
}): Partial<Record<string, NumericSpec>> | undefined {
	const range = getParamNumericRange({ param });
	return range ? { value: range } : undefined;
}

function buildParamDescriptor({
	param,
	baseParams,
	setParams,
}: {
	param: ParamDefinition;
	baseParams: ParamValues;
	setParams: (params: ParamValues) => TimelineElement;
}): AnimationPathDescriptor | null {
	if (param.keyframable === false) {
		return null;
	}

	return {
		channelLayout: getParamChannelLayout({ param }),
		defaultInterpolation: getParamDefaultInterpolation({ param }),
		numericRanges: paramNumericRanges({ param }),
		coerceValue: ({ value }) => coerceParamValue({ param, value }),
		getBaseValue: () => baseParams[param.key] ?? param.default,
		setBaseValue: ({ value }) => {
			const coercedValue = coerceParamValue({ param, value });
			if (coercedValue === null) {
				return setParams(baseParams);
			}

			return setParams({
				...baseParams,
				[param.key]: coercedValue,
			});
		},
	};
}

function buildElementParamDescriptor({
	element,
	paramKey,
}: {
	element: TimelineElement;
	paramKey: string;
}): AnimationPathDescriptor | null {
	const param = getElementParam({ element, key: paramKey });
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: element.params,
		setParams: (params) => ({
			...element,
			params,
		}),
	});
}

function buildGraphicParamDescriptor({
	element,
	paramKey,
}: {
	element: TimelineElement;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (element.type !== "graphic") {
		return null;
	}

	const definition = getGraphicDefinition({
		definitionId: element.definitionId,
	});
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: element.params,
		setParams: (params) => ({
			...element,
			params,
		}),
	});
}

function buildEffectParamDescriptor({
	element,
	effectId,
	paramKey,
}: {
	element: TimelineElement;
	effectId: string;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (!isVisualElement(element)) {
		return null;
	}

	const effect = element.effects?.find((candidate) => candidate.id === effectId);
	if (!effect) {
		return null;
	}

	registerDefaultEffects();
	const definition = effectsRegistry.get(effect.type);
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: effect.params,
		setParams: (params) => ({
			...element,
			effects:
				element.effects?.map((candidate) =>
					candidate.id !== effectId
						? candidate
						: {
								...candidate,
								params,
							},
				) ?? element.effects,
		}),
	});
}

function buildMaskParamDescriptor({
	element,
	maskId,
	paramKey,
}: {
	element: TimelineElement;
	maskId: string;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (!isMaskableElement(element)) {
		return null;
	}

	const mask = element.masks?.find((candidate) => candidate.id === maskId);
	if (!mask) {
		return null;
	}

	registerDefaultMasks();
	const definition = getMaskDefinition(mask.type);
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: mask.params as unknown as ParamValues,
		setParams: (params) => ({
			...element,
			masks: element.masks?.map((candidate): Mask =>
				candidate.id !== maskId
					? candidate
					: ({ ...candidate, params }) as unknown as Mask,
			),
		}),
	});
}

export function resolveAnimationTarget({
	element,
	path,
}: {
	element: TimelineElement;
	path: AnimationPath;
}): AnimationPathDescriptor | null {
	const elementParamTarget = buildElementParamDescriptor({
		element,
		paramKey: path,
	});
	if (elementParamTarget) {
		return elementParamTarget;
	}

	const graphicParamTarget = parseGraphicParamPath({ propertyPath: path });
	if (graphicParamTarget) {
		return buildGraphicParamDescriptor({
			element,
			paramKey: graphicParamTarget.paramKey,
		});
	}

	const effectParamTarget = parseEffectParamPath({ propertyPath: path });
	if (effectParamTarget) {
		return buildEffectParamDescriptor({
			element,
			effectId: effectParamTarget.effectId,
			paramKey: effectParamTarget.paramKey,
		});
	}

	const maskParamTarget = parseMaskParamPath({ propertyPath: path });
	if (maskParamTarget) {
		return buildMaskParamDescriptor({
			element,
			maskId: maskParamTarget.maskId,
			paramKey: maskParamTarget.paramKey,
		});
	}

	if (path === TIME_REMAP_PATH) {
		return buildTimeRemapDescriptor({ element });
	}

	return null;
}

// Time remapping maps element-local time to a source offset in seconds. There
// is no static base value: removing the channel restores constant-rate mapping.
function buildTimeRemapDescriptor({
	element,
}: {
	element: TimelineElement;
}): AnimationPathDescriptor | null {
	if (element.type !== "video") {
		return null;
	}

	return {
		channelLayout: NUMBER_CHANNEL_LAYOUT,
		defaultInterpolation: "bezier",
		coerceValue: ({ value }) =>
			typeof value === "number" && Number.isFinite(value) && value >= 0
				? value
				: null,
		getBaseValue: () => null,
		setBaseValue: () => element,
	};
}
