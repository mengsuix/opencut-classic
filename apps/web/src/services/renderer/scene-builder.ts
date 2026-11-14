import type { SceneTracks, TimelineTrack } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { HtmlNode, resolveHtmlSize } from "./nodes/html-node";
import { CodeRenderNode } from "./nodes/code-render-node";
import { buildCodeEffectFromParams } from "@/code-render";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { buildVisualAnimConfig } from "@/animation/visual-anim";
import {
	buildTransitionFromParams,
	computeTrackTransitions,
	getCustomTransitionWindow,
	isActiveTransition,
} from "@/timeline/transition";
import { TICKS_PER_SECOND } from "@/wasm";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

/** Max gap (~1 frame at 30fps) between two elements for a transition. */
const MAX_TRANSITION_GAP_TICKS = Math.round(TICKS_PER_SECOND / 30);

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function codeContainerParams({
	startTime,
	duration,
}: {
	startTime: number;
	duration: number;
}) {
	return {
		duration,
		timeOffset: startTime,
		trimStart: 0,
		trimEnd: 0,
		transform: buildTransformFromParams({ params: {} }),
		opacity: 1,
	};
}

function wrapCodeEffects({
	nodes,
	elements,
	visualNodes,
}: {
	nodes: AnyBaseNode[];
	elements: ReturnType<typeof getVisibleSortedElements>;
	visualNodes: Map<string, AnyBaseNode>;
}) {
	for (const element of elements) {
		const { code, codeParams } = buildCodeEffectFromParams({
			params: element.params,
		});
		if (!code.trim()) continue;
		const source = visualNodes.get(element.id);
		if (!source) continue;
		const sourceIndex = nodes.indexOf(source);
		if (sourceIndex < 0) continue;
		const effect = new CodeRenderNode({
			...codeContainerParams({
				startTime: element.startTime,
				duration: element.duration,
			}),
			mode: "effect",
			code,
			codeParams,
			inputs: [source],
		});
		nodes[sourceIndex] = effect;
		visualNodes.set(element.id, effect);
	}
}

function wrapCustomTransitions({
	nodes,
	elements,
	visualNodes,
}: {
	nodes: AnyBaseNode[];
	elements: ReturnType<typeof getVisibleSortedElements>;
	visualNodes: Map<string, AnyBaseNode>;
}) {
	for (let index = elements.length - 2; index >= 0; index--) {
		const current = elements[index];
		const next = elements[index + 1];
		const config = buildTransitionFromParams({ params: current.params });
		const gap = next.startTime - (current.startTime + current.duration);
		if (
			config.type !== "custom" || !config.code || !isActiveTransition(config) ||
			gap < 0 || gap > MAX_TRANSITION_GAP_TICKS
		) continue;
		const outgoing = visualNodes.get(current.id);
		const incoming = visualNodes.get(next.id);
		if (!outgoing || !incoming) continue;
		const outgoingIndex = nodes.indexOf(outgoing);
		const incomingIndex = nodes.indexOf(incoming);
		if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1) continue;
		const duration = config.duration * TICKS_PER_SECOND;
		const { startTime } = getCustomTransitionWindow({
			outgoingStartTime: current.startTime,
			outgoingDuration: current.duration,
			duration,
			layout: config.layout,
		});
		const custom = new CodeRenderNode({
			...codeContainerParams({ startTime, duration }),
			mode: "transition",
			code: config.code,
			codeParams: config.codeParams ?? {},
			inputTimeRanges: [current, next].map((element) => ({
				startTime: element.startTime,
				endTime: element.startTime + element.duration,
			})),
			inputs: [outgoing, incoming],
		});
		nodes[outgoingIndex] = custom;
		nodes.splice(incomingIndex, 1);
		visualNodes.set(current.id, custom);
	}
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		const visualNodes = new Map<string, AnyBaseNode>();
		const transitions =
			track.type === "video"
				? computeTrackTransitions({
						elements,
						maxGapTicks: MAX_TRANSITION_GAP_TICKS,
					})
				: null;

		for (const element of elements) {
			const previousNodeCount = nodes.length;
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset?.file || !mediaAsset?.url) {
					continue;
				}

				if (element.type === "video" && mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							file: mediaAsset.file,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							freeze: element.freeze,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							animIn: buildVisualAnimConfig({
								params: element.params,
								phase: "in",
							}),
							animOut: buildVisualAnimConfig({
								params: element.params,
								phase: "out",
							}),
							transitionIn: transitions?.get(element.id)?.transitionIn,
							transitionOut: transitions?.get(element.id)?.transitionOut,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
						}),
					);
				}
				if (element.type === "image" && mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							animIn: buildVisualAnimConfig({
								params: element.params,
								phase: "in",
							}),
							animOut: buildVisualAnimConfig({
								params: element.params,
								phase: "out",
							}),
							transitionIn: transitions?.get(element.id)?.transitionIn,
							transitionOut: transitions?.get(element.id)?.transitionOut,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
				if (mediaAsset.type === element.type) {
					visualNodes.set(element.id, nodes[nodes.length - 1]);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						animIn: buildVisualAnimConfig({
							params: element.params,
							phase: "in",
						}),
						animOut: buildVisualAnimConfig({
							params: element.params,
							phase: "out",
						}),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						animIn: buildVisualAnimConfig({
							params: element.params,
							phase: "in",
						}),
						animOut: buildVisualAnimConfig({
							params: element.params,
							phase: "out",
						}),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}

			if (element.type === "html") {
				const htmlSize = resolveHtmlSize({ html: element.html });
				nodes.push(
					new HtmlNode({
						html: element.html,
						params: element.params,
						intrinsicWidth: element.intrinsicWidth ?? htmlSize.width,
						intrinsicHeight: element.intrinsicHeight ?? htmlSize.height,
						pixelExact: true,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						animIn: buildVisualAnimConfig({
							params: element.params,
							phase: "in",
						}),
						animOut: buildVisualAnimConfig({
							params: element.params,
							phase: "out",
						}),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}

			if (element.type === "code") {
				nodes.push(
					new CodeRenderNode({
						mode: "generator",
						code: element.code,
						codeParams: element.codeParams,
						inputs: [],
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						animIn: buildVisualAnimConfig({
							params: element.params,
							phase: "in",
						}),
						animOut: buildVisualAnimConfig({
							params: element.params,
							phase: "out",
						}),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}

			if (nodes.length > previousNodeCount) {
				visualNodes.set(element.id, nodes[nodes.length - 1]);
			}
		}
		wrapCodeEffects({ nodes, elements, visualNodes });
		wrapCustomTransitions({ nodes, elements, visualNodes });
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				freeze: element.type === "video" ? element.freeze : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
