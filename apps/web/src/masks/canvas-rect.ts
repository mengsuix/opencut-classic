import type { ElementBounds } from "@/preview/element-bounds";

export interface CanvasFractionRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Convert a canvas-fraction rect (0~1, top-left origin — e.g. estimated from a
 * preview screenshot) into box-mask params (element-center origin, element-size
 * units). The returned rotation cancels the element's own rotation so the rect
 * stays axis-aligned on canvas.
 */
export function canvasRectToMaskParams({
	rect,
	bounds,
	canvasSize,
}: {
	rect: CanvasFractionRect;
	bounds: Pick<ElementBounds, "cx" | "cy" | "width" | "height" | "rotation">;
	canvasSize: { width: number; height: number };
}): {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotation: number;
} {
	const elementWidth = Math.abs(bounds.width);
	const elementHeight = Math.abs(bounds.height);
	if (elementWidth === 0 || elementHeight === 0) {
		throw new Error("Element has zero size on canvas");
	}

	const rectCenterX = ((rect.left + rect.right) / 2) * canvasSize.width;
	const rectCenterY = ((rect.top + rect.bottom) / 2) * canvasSize.height;
	// Undo the element's rotation so the offset lands in the mask's
	// element-local space.
	const rotRad = (bounds.rotation * Math.PI) / 180;
	const dx = rectCenterX - bounds.cx;
	const dy = rectCenterY - bounds.cy;
	const localDx = dx * Math.cos(rotRad) + dy * Math.sin(rotRad);
	const localDy = -dx * Math.sin(rotRad) + dy * Math.cos(rotRad);

	return {
		centerX: localDx / elementWidth,
		centerY: localDy / elementHeight,
		width: ((rect.right - rect.left) * canvasSize.width) / elementWidth,
		height: ((rect.bottom - rect.top) * canvasSize.height) / elementHeight,
		rotation: ((-bounds.rotation % 360) + 360) % 360,
	};
}
