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
 * Cache keyed by resolved content (params injected), so editing a variable
 * re-rasterizes while repeated renders of unchanged HTML reuse the canvas.
 */
const htmlSourceCache = new Map<string, Promise<CachedHtmlSource>>();

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
	const cacheKey = JSON.stringify({ html, params, width, height });
	const cached = htmlSourceCache.get(cacheKey);
	if (cached) return cached;

	const promise = rasterizeHtml({ html, params, width, height });
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
	return { source: canvas, width, height };
}

export class HtmlNode extends VisualNode<
	HtmlNodeParams,
	ResolvedVisualSourceNodeState
> {}
