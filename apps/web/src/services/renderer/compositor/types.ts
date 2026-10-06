import type { BlendMode } from "@/rendering";
import type { EffectPass } from "@/effects/types";
import type { TransitionBlendKind } from "@/timeline/transition";

export type FrameDescriptor = {
	width: number;
	height: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type FrameItemDescriptor =
	| {
			type: "layer";
			textureId: string;
			transform: QuadTransformDescriptor;
			opacity: number;
			blendMode: BlendMode;
			effectPassGroups: EffectPass[][];
			mask: LayerMaskDescriptor | null;
	  }
	| {
			type: "sceneEffect";
			effectPassGroups: EffectPass[][];
	  }
	| {
			type: "transitionBlend";
			textureIdFrom: string;
			textureIdTo: string;
			progress: number;
			kind: TransitionBlendKind;
			feather: number;
	  };

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};

export type TextureCanvasDrawFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => void;

/**
 * A layer texture whose pixels come from somewhere outside the renderer —
 * typically a decoded video/image frame or a sticker. Cached by reference
 * identity of the source object plus an optional `contentHash`: pool-backed
 * video frames REUSE the same canvas object across frames, so a changing
 * `contentHash` (e.g. the decoded frame's source timestamp) is what forces
 * the re-upload; static sources omit it and keep the identity fast path.
 */
export type ExternalTextureDescriptor = {
	kind: "external";
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
	contentHash?: string;
};

/**
 * A layer texture that the renderer rasterizes from scene state (color fill,
 * text layout, mask shape, blur backdrop). Cached by `contentHash`: when it
 * matches the previous frame's hash for this id, the upload is skipped
 * entirely and the persistent canvas is not even cleared.
 */
export type RenderedTextureDescriptor = {
	kind: "rendered";
	id: string;
	contentHash: string;
	width: number;
	height: number;
	draw: TextureCanvasDrawFn;
};

export type TextureUploadDescriptor =
	| ExternalTextureDescriptor
	| RenderedTextureDescriptor;
