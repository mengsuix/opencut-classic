import type { ParamValues } from "@/params";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface HtmlNodeParams extends VisualNodeParams {
	html: string;
	params: ParamValues;
	intrinsicWidth: number;
	intrinsicHeight: number;
}

export interface CachedHtmlSource {
	source: OffscreenCanvas;
	width: number;
	height: number;
}

const DEFAULT_HTML_SIZE = { width: 1280, height: 720 };

/**
 * Cache keyed by the rasterized content (markup + injected slot values), so
 * editing a variable re-rasterizes while repeated renders of unchanged HTML
 * reuse the canvas.
 */
const htmlSourceCache = new Map<string, Promise<CachedHtmlSource>>();

/**
 * Cropped content size per cache key. Readable synchronously so UI geometry
 * (selection bounds, drag) can match the element without re-rasterizing.
 */
const htmlContentSizeCache = new Map<
	string,
	{ width: number; height: number }
>();

type HtmlContentSizeListener = () => void;
const contentSizeListeners = new Set<HtmlContentSizeListener>();

/**
 * Notified whenever a rasterization reveals the real (cropped) content size.
 * The renderer fills that cache asynchronously, off React's render path, so
 * without this nudge the selection overlay would keep drawing the declared box
 * until something else happened to re-render it.
 */
export function onHtmlContentSizeResolved(
	listener: HtmlContentSizeListener,
): () => void {
	contentSizeListeners.add(listener);
	return () => {
		contentSizeListeners.delete(listener);
	};
}

/**
 * Keyed on what actually changes the raster: the markup, the data-param slot
 * values injected into it, and the layout box. Transform params change on
 * every drag tick, so keying the whole params object dropped the cropped
 * content size mid-drag — the selection box fell back to the declared layout
 * box and the HTML was re-rasterized on every pointer move.
 */
function htmlCacheKey({
	html,
	params,
	width,
	height,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
}): string {
	const slots: Record<string, string | number> = {};
	for (const key of extractHtmlParams({ html })) {
		const value = params[key];
		if (typeof value === "string" || typeof value === "number") {
			slots[key] = value;
		}
	}
	return JSON.stringify({ html, slots, width, height });
}

export function getCachedHtmlContentSize({
	html,
	params,
	width,
	height,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
}): { width: number; height: number } | null {
	return htmlContentSizeCache.get(htmlCacheKey({ html, params, width, height })) ?? null;
}

export function resolveHtmlSize({
	html,
}: {
	html: string;
}): { width: number; height: number } {
	const width = /data-width="(\d+)"/.exec(html)?.[1];
	const height = /data-height="(\d+)"/.exec(html)?.[1];
	return {
		width: width ? Number(width) : DEFAULT_HTML_SIZE.width,
		height: height ? Number(height) : DEFAULT_HTML_SIZE.height,
	};
}

/** Slots declared by the HTML: elements carrying data-param="key". */
export function extractHtmlParams({ html }: { html: string }): string[] {
	const keys = new Set<string>();
	const attribute = /data-param\s*=\s*"([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = attribute.exec(html)) !== null) {
		keys.add(match[1]);
	}
	return [...keys];
}

/**
 * Prepare the HTML for foreignObject rasterization: inject param values into
 * data-param slots, move <head> styles into the rendered subtree (they would
 * otherwise be dropped), and serialize via XMLSerializer so the SVG payload is
 * always well-formed XML.
 */
function prepareHtml({
	html,
	params,
}: {
	html: string;
	params: ParamValues;
}): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const node of Array.from(doc.querySelectorAll("[data-param]"))) {
		const key = node.getAttribute("data-param");
		if (!key) continue;
		const value = params[key];
		if (typeof value === "string" || typeof value === "number") {
			node.textContent = String(value);
		}
	}
	for (const style of Array.from(doc.querySelectorAll("head style"))) {
		doc.body.appendChild(style);
	}
	const wrapper = doc.createElement("div");
	// The foreignObject has no layout box of its own, so percentage heights in
	// the HTML would collapse to zero unless the wrapper carries the size.
	wrapper.setAttribute("style", "margin:0;padding:0;width:100%;height:100%;");
	while (doc.body.firstChild) {
		wrapper.appendChild(doc.body.firstChild);
	}
	doc.body.appendChild(wrapper);
	return new XMLSerializer().serializeToString(wrapper);
}

export function loadHtmlSource({
	html,
	params,
	width,
	height,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
}): Promise<CachedHtmlSource> {
	const cacheKey = htmlCacheKey({ html, params, width, height });
	const cached = htmlSourceCache.get(cacheKey);
	if (cached) return cached;

	const promise = rasterizeHtml({ html, params, width, height }).then(
		(result) => {
			htmlContentSizeCache.set(cacheKey, {
				width: result.width,
				height: result.height,
			});
			contentSizeListeners.forEach((listener) => listener());
			return result;
		},
	);
	htmlSourceCache.set(cacheKey, promise);
	return promise;
}

async function rasterizeHtml({
	html,
	params,
	width,
	height,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
}): Promise<CachedHtmlSource> {
	const bodyHtml = prepareHtml({ html, params });

	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
		`<foreignObject width="100%" height="100%">`,
		bodyHtml,
		`</foreignObject>`,
		`</svg>`,
	].join("");

	// A blob: URL makes Chrome treat the SVG image as cross-origin: drawing it
	// taints the canvas, so WebGPU refuses the upload (SecurityError) and wgpu's
	// unwrap panics, which permanently wedges the compositor. A data: URL keeps
	// the canvas origin-clean and uploads fine.
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

	const image = new Image();
	image.decoding = "sync";
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("HTML rasterization failed"));
		image.src = url;
	});

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("OffscreenCanvas 2d context unavailable");
	}
	ctx.drawImage(image, 0, 0, width, height);

	// The declared canvas is only a layout box: the element should be exactly
	// the painted content, so crop to the painted pixels. The renderer then
	// places it 1:1 (pixelExact) instead of contain-fitting the declared box.
	const bounds = findPaintedBounds({ ctx, width, height });
	if (!bounds) {
		return { source: canvas, width: 1, height: 1 };
	}
	if (bounds.width === width && bounds.height === height) {
		return { source: canvas, width, height };
	}

	const cropped = new OffscreenCanvas(bounds.width, bounds.height);
	const croppedContext = cropped.getContext("2d");
	if (!croppedContext) {
		return { source: canvas, width, height };
	}
	croppedContext.drawImage(
		canvas,
		bounds.left,
		bounds.top,
		bounds.width,
		bounds.height,
		0,
		0,
		bounds.width,
		bounds.height,
	);
	return { source: cropped, width: bounds.width, height: bounds.height };
}

/** Tight bounding box of the non-transparent pixels. */
function findPaintedBounds({
	ctx,
	width,
	height,
}: {
	ctx: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
}): { left: number; top: number; width: number; height: number } | null {
	const { data } = ctx.getImageData(0, 0, width, height);
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		const rowOffset = y * width * 4;
		for (let x = 0; x < width; x++) {
			if (data[rowOffset + x * 4 + 3] === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < 0) return null;
	return {
		left: minX,
		top: minY,
		width: maxX - minX + 1,
		height: maxY - minY + 1,
	};
}

export class HtmlNode extends VisualNode<
	HtmlNodeParams,
	ResolvedVisualSourceNodeState
> {}
