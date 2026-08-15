const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;

export function thumbnailSize({
	width,
	height,
	maxWidth = THUMBNAIL_MAX_WIDTH,
	maxHeight = THUMBNAIL_MAX_HEIGHT,
}: {
	width: number;
	height: number;
	maxWidth?: number;
	maxHeight?: number;
}): { width: number; height: number } {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > maxWidth) {
		targetWidth = maxWidth;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > maxHeight) {
		targetHeight = maxHeight;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
}

export function renderThumbnailDataUrl({
	width,
	height,
	maxWidth,
	maxHeight,
	draw,
}: {
	width: number;
	height: number;
	maxWidth?: number;
	maxHeight?: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
}): string {
	const size = thumbnailSize({ width, height, maxWidth, maxHeight });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });
	return canvas.toDataURL("image/jpeg", 0.8);
}
