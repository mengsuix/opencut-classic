import { mediaTimeToSeconds, roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { getElementLocalTime } from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	combineVisualAnimStates,
	resolveVisualAnimAtTime,
} from "@/animation/visual-anim";
import {
	resolveElementTransitionAtTime,
	transitionLeadInTicks,
} from "@/timeline/transition";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import type { Effect, EffectPass } from "@/effects/types";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	buildTextStyleFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { readStringParam } from "@/text/param-readers";
import { resolveTextStyle } from "@/text/style";
import {
	buildTextEntranceFromElement,
	countTextChars,
	resolveTextEntranceAtTime,
	truncateTextContent,
} from "@/text/entrance";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import type { TextElement } from "@/timeline";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { videoCache } from "@/services/video-cache/service";
import type { CanvasRenderer } from "./canvas-renderer";
import type { AnyBaseNode } from "./nodes/base-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { StickerNode, loadStickerSource } from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";

type ResolveContext = {
	renderer: CanvasRenderer;
	time: number;
	signal?: AbortSignal;
	cancelVideoDecode: boolean;
	requestId: symbol;
};

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("Render aborted", "AbortError");
}

export async function resolveRenderTree({
	node,
	renderer,
	time,
	signal,
	cancelVideoDecode = false,
	requestId,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	time: number;
	signal?: AbortSignal;
	cancelVideoDecode?: boolean;
	requestId: symbol;
}): Promise<void> {
	await resolveNode({
		node,
		context: {
			renderer,
			time,
			signal,
			cancelVideoDecode,
			requestId,
		},
	});
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	throwIfAborted(context.signal);
	if (node instanceof VideoNode) {
		node.resolved = await resolveVideoNode({ node, context });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}

	throwIfAborted(context.signal);
	await Promise.all(
		node.children.map((child) => resolveNode({ node: child, context })),
	);
	throwIfAborted(context.signal);
}

function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	width: number;
	height: number;
}): EffectPass[][] {
	return (effects ?? [])
		.filter((effect) => effect.enabled)
		.map((effect) => {
			const resolvedParams = resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime,
			});
			const definition = effectsRegistry.get(effect.type);
			return resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
				time: localTime,
			});
		});
}

function resolveVisualState({
	params,
	context,
	sourceWidth,
	sourceHeight,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	sourceWidth: number;
	sourceHeight: number;
}): ResolvedVisualNodeState | null {
	const clipTime = context.time - params.timeOffset;
	const leadIn = transitionLeadInTicks({
		transitionIn: params.transitionIn,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	if (clipTime < -leadIn || clipTime >= params.duration) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const baseTransform = resolveTransformAtTime({
		baseTransform: params.transform,
		animations: params.animations,
		localTime,
	});
	const baseOpacity = resolveOpacityAtTime({
		baseOpacity: params.opacity,
		animations: params.animations,
		localTime,
	});
	const anim = resolveVisualAnimAtTime({
		animIn: params.animIn,
		animOut: params.animOut,
		localTime: localTime / TICKS_PER_SECOND,
		elementDuration: params.duration / TICKS_PER_SECOND,
		canvasWidth: context.renderer.width,
		canvasHeight: context.renderer.height,
	});
	const transition = resolveElementTransitionAtTime({
		transitionIn: params.transitionIn,
		transitionOut: params.transitionOut,
		time: context.time,
		timeOffset: params.timeOffset,
		duration: params.duration,
		canvasWidth: context.renderer.width,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	const motion = combineVisualAnimStates({ a: anim, b: transition });
	const transform =
		motion.scaleFactor === 1 && motion.offsetX === 0 && motion.offsetY === 0
			? baseTransform
			: {
					...baseTransform,
					scaleX: baseTransform.scaleX * motion.scaleFactor,
					scaleY: baseTransform.scaleY * motion.scaleFactor,
					position: {
						x: baseTransform.position.x + motion.offsetX,
						y: baseTransform.position.y + motion.offsetY,
					},
				};
	const opacity = baseOpacity * motion.opacityFactor;
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
	);
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);

	return {
		localTime,
		transform,
		opacity,
		effectPasses: resolveEffectPassGroups({
			effects: params.effects,
			animations: params.animations,
			localTime,
			width: effectWidth,
			height: effectHeight,
		}),
	};
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	const leadIn = transitionLeadInTicks({
		transitionIn: node.params.transitionIn,
		ticksPerSecond: TICKS_PER_SECOND,
	});
	if (clipTime < -leadIn || clipTime >= node.params.duration) {
		return null;
	}

	// During the transition lead-in (clipTime < 0) the video consumes
	// trimStart handles, holding the source's first frame when they run out.
	const sourceOffsetTicks =
		clipTime >= 0
			? getSourceTimeAtClipTime({
					clipTime,
					retime: node.params.retime,
				})
			: clipTime;
	const sourceTimeTicks = Math.max(
		node.params.trimStart + sourceOffsetTicks,
		0,
	);
	const frame = await videoCache.getFrameAt({
		mediaId: node.params.mediaId,
		file: node.params.file,
		time: mediaTimeToSeconds({
			time: roundMediaTime({ time: sourceTimeTicks }),
		}),
		signal: context.signal,
		prefetch: !context.cancelVideoDecode,
		requestId: context.requestId,
	});
	if (!frame) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: frame.canvas,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	};
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth: source.width,
		sourceHeight: source.height,
	};
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadStickerSource({ stickerId: node.params.stickerId });
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): ResolvedGraphicNodeState | null {
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
		sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		resolvedParams: resolveGraphicElementParamsAtTime({
			element: node.params,
			localTime: visualState.localTime,
		}),
	};
}

function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): ResolvedTextNodeState | null {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });

	const entrance = resolveTextEntranceAtTime({
		config: buildTextEntranceFromElement({ element: node.params }),
		localTime: localTime / TICKS_PER_SECOND,
	});

	let elementForMeasure: TextElement = node.params;
	if (entrance.visibleRatio !== null) {
		const content = readStringParam({
			params: node.params.params,
			key: "content",
			fallback: "Default text",
		});
		const totalChars = countTextChars({ content });
		const visibleChars = Math.floor(entrance.visibleRatio * totalChars);
		if (visibleChars <= 0) {
			return null;
		}
		if (visibleChars < totalChars) {
			elementForMeasure = {
				...node.params,
				params: {
					...node.params.params,
					content: truncateTextContent({ content, visibleChars }),
				},
			};
		}
	}

	const baseTransform = resolveTransformAtTime({
		baseTransform: node.params.transform,
		animations: node.params.animations,
		localTime,
	});
	const transform =
		entrance.scaleFactor === 1
			? baseTransform
			: {
					...baseTransform,
					scaleX: baseTransform.scaleX * entrance.scaleFactor,
					scaleY: baseTransform.scaleY * entrance.scaleFactor,
				};

	return {
		transform,
		opacity:
			resolveOpacityAtTime({
				baseOpacity: node.params.opacity,
				animations: node.params.animations,
				localTime,
			}) * entrance.opacityFactor,
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		textStyle: resolveTextStyle({
			style: buildTextStyleFromElement({ element: node.params }),
			scale: node.params.canvasHeight / FONT_SIZE_SCALE_REFERENCE,
		}),
		effectPasses: resolveEffectPassGroups({
			effects: node.params.effects,
			animations: node.params.animations,
			localTime,
			width: context.renderer.width,
			height: context.renderer.height,
		}),
		measuredText: measureTextElement({
			element: elementForMeasure,
			canvasHeight: node.params.canvasHeight,
			localTime,
			ctx: getTextMeasurementContext(),
		}),
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const backdropSource = await resolveBackdropSource({
		node,
		clipTime,
		signal: context.signal,
		prefetch: !context.cancelVideoDecode,
		requestId: context.requestId,
	});
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.height,
				reference: 1080,
			}),
		}),
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
	signal,
	prefetch,
	requestId,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
	signal?: AbortSignal;
	prefetch: boolean;
	requestId: symbol;
}): Promise<BackdropSource | null> {
	if (node.params.mediaType === "video") {
		const sourceTimeTicks =
			node.params.trimStart +
			getSourceTimeAtClipTime({
				clipTime,
				retime: node.params.retime,
			});
		const frame = await videoCache.getFrameAt({
			mediaId: node.params.mediaId,
			file: node.params.file,
			time: mediaTimeToSeconds({
				time: roundMediaTime({ time: sourceTimeTicks }),
			}),
			signal,
			prefetch,
			requestId,
		});
		if (!frame) {
			return null;
		}

		return {
			source: frame.canvas,
			width: frame.canvas.width,
			height: frame.canvas.height,
		};
	}

	const source = await loadImageSource({ url: node.params.url });
	return {
		source: source.source,
		width: source.width,
		height: source.height,
	};
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const definition = effectsRegistry.get(node.params.effectType);
	const passes = resolveEffectPasses({
		definition,
		effectParams: node.params.effectParams,
		width: context.renderer.width,
		height: context.renderer.height,
		time: time - node.params.timeOffset,
	});
	if (passes.length === 0) {
		return null;
	}

	return {
		passes,
	};
}
