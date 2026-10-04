import { BaseNode } from "./base-node";
import type { VisualAnimConfig } from "@/animation/visual-anim";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline";
import type {
	TransitionBlendKind,
	TransitionConfig,
} from "@/timeline/transition";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	freeze?: boolean;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	animIn?: VisualAnimConfig;
	animOut?: VisualAnimConfig;
	transitionIn?: TransitionConfig;
	transitionOut?: TransitionConfig;
	/** Draw the source at its own pixel size instead of contain-fitting it to the canvas (html effects). */
	pixelExact?: boolean;
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	/**
	 * Set while this element is inside a dual-source blend transition window
	 * (iris/wipe/star). The frame-descriptor pass pairs the outgoing and
	 * incoming layers (arrival order: from below, then to above) into one
	 * compositor transition-blend item.
	 */
	transitionBlend?: { progress: number; kind: TransitionBlendKind } | null;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
