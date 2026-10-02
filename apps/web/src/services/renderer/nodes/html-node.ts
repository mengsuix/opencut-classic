import type { ParamValues } from "@/params";
import { acquireHtmlRuntime, buildRuntimeSrcdoc } from "./html-runtime";
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
	if (isAnimatedHtml({ html }) || isScriptedHtml({ html })) return { width, height };
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
 * HTML declaring CSS @keyframes is animated: the editor seeks its CSS
 * animations to the element's local time on every frame. CSS animations never
 * run live — they are frozen at the seek time during rasterization.
 */
export function isAnimatedHtml({ html }: { html: string }): boolean {
	return /@keyframes\b/i.test(html);
}

/**
 * HTML carrying <script> is scripted: it renders through the sandboxed iframe
 * runtime (html-runtime.ts), where scripts run and JS animation state (GSAP
 * timelines on window.__timelines) is captured via DOM serialization on every
 * seek. Canvas/WebGL pixels do not survive serialization — those effects
 * still belong to server-side rendering.
 */
export function isScriptedHtml({ html }: { html: string }): boolean {
	return /<script[\s/>]/i.test(html);
}

const ANIM_INDEX_ATTR = "data-hfx-i";

/**
 * Prepare the HTML for foreignObject rasterization: inject param values into
 * data-param slots, move <head> styles into the rendered subtree (they would
 * otherwise be dropped), and serialize via XMLSerializer so the SVG payload is
 * always well-formed XML. Animated HTML additionally gets every element
 * tagged with an index so per-frame seek rules can target it.
 */
function prepareHtml({
	html,
	params,
	tagElements = false,
	stripEmbedded = false,
}: {
	html: string;
	params: ParamValues;
	tagElements?: boolean;
	/** Runtime mode: drop meta/base/link and nested browsing tags (a meta
	 * refresh would navigate the sandboxed iframe away from the srcdoc), but
	 * keep <script> — scripts are the point of the runtime. */
	stripEmbedded?: boolean;
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
	if (tagElements) {
		for (const node of Array.from(wrapper.querySelectorAll("script, iframe, frame, object, embed, meta, base, link"))) {
			node.remove();
		}
		Array.from(wrapper.querySelectorAll("*")).forEach((element, index) => {
			element.setAttribute(ANIM_INDEX_ATTR, String(index));
		});
	} else if (stripEmbedded) {
		for (const node of Array.from(wrapper.querySelectorAll("iframe, frame, object, embed, meta, base, link"))) {
			node.remove();
		}
	}
	return new XMLSerializer().serializeToString(wrapper);
}

interface AnimatedTarget {
	index: string;
	pseudo: "" | "::before" | "::after";
	/** Author animation-delay per animation-name entry, in seconds. */
	delays: number[];
}

interface AnimatedHtmlTemplate {
	bodyHtml: string;
	targets: AnimatedTarget[];
}

const animatedTemplateCache = new Map<string, Promise<AnimatedHtmlTemplate>>();

function parseCssTimeList(value: string): number[] {
	return value.split(",").map((part) => {
		const text = part.trim();
		const amount = Number.parseFloat(text);
		if (!Number.isFinite(amount)) return 0;
		return text.endsWith("ms") ? amount / 1000 : amount;
	});
}

/**
 * Seeking needs each animation's authored delay (staggered delays must
 * survive the seek), which only the cascade knows. Load the prepared markup
 * once into a script-less, network-less iframe and read the computed
 * animation lists; per-frame seeking then only rewrites delays.
 */
async function extractAnimatedTargets({
	bodyHtml,
	width,
	height,
}: {
	bodyHtml: string;
	width: number;
	height: number;
}): Promise<AnimatedHtmlTemplate> {
	const iframe = document.createElement("iframe");
	iframe.setAttribute("sandbox", "allow-same-origin");
	iframe.setAttribute("aria-hidden", "true");
	iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;visibility:hidden;border:0;`;
	iframe.srcdoc = [
		"<!doctype html><html><head><meta charset=\"utf-8\">",
		"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'\">",
		"<style>html,body{margin:0;padding:0;width:100%;height:100%}:root{--opencut-html-time:0s}</style>",
		"</head><body>",
		bodyHtml,
		"</body></html>",
	].join("");
	let timeout: ReturnType<typeof setTimeout>;
	const loaded = new Promise<void>((resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("HTML animation probe timed out")), 5000);
		iframe.onload = () => resolve();
		iframe.onerror = () => reject(new Error("HTML animation probe failed"));
	});
	document.body.appendChild(iframe);
	try {
		await loaded;
		const doc = iframe.contentDocument;
		const view = iframe.contentWindow;
		if (!doc?.body.firstElementChild || !view) throw new Error("HTML animation probe unavailable");
		const targets: AnimatedTarget[] = [];
		for (const element of Array.from(doc.querySelectorAll<HTMLElement>(`[${ANIM_INDEX_ATTR}]`))) {
			const index = element.getAttribute(ANIM_INDEX_ATTR) ?? "";
			for (const pseudo of ["::before", "::after", ""] as const) {
				const style = view.getComputedStyle(element, pseudo || null);
				const names = style.animationName.split(",").map((name) => name.trim());
				if (names.every((name) => name === "none" || name === "")) continue;
				const authored = parseCssTimeList(style.animationDelay);
				const delays = names.map((_, i) => authored[i % authored.length] ?? 0);
				if (pseudo) {
					targets.push({ index, pseudo, delays });
				} else {
					element.style.setProperty("animation-delay", delays.map((delay) => `calc(${delay}s - var(--opencut-html-time))`).join(","), "important");
					element.style.setProperty("animation-play-state", "paused", "important");
				}
			}
		}
		return { bodyHtml: new XMLSerializer().serializeToString(doc.body.firstElementChild), targets };
	} finally {
		clearTimeout(timeout!);
		iframe.remove();
	}
}

function loadAnimatedTemplate({
	html,
	params,
	width,
	height,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
}): Promise<AnimatedHtmlTemplate> {
	const cacheKey = htmlCacheKey({ html, params, width, height });
	const cached = animatedTemplateCache.get(cacheKey);
	if (cached) {
		animatedTemplateCache.delete(cacheKey);
		animatedTemplateCache.set(cacheKey, cached);
		return cached;
	}
	const bodyHtml = prepareHtml({ html, params, tagElements: true });
	const promise = extractAnimatedTargets({ bodyHtml, width, height });
	animatedTemplateCache.set(cacheKey, promise);
	if (animatedTemplateCache.size > 32) {
		const oldest = animatedTemplateCache.keys().next().value;
		if (oldest !== undefined) animatedTemplateCache.delete(oldest);
	}
	promise.catch(() => {
		if (animatedTemplateCache.get(cacheKey) === promise) animatedTemplateCache.delete(cacheKey);
	});
	return promise;
}

/**
 * Freeze every animation at `seconds`: pause it and shift its delay by
 * -seconds, so the first (and only) painted frame is the state at that time,
 * with authored delays, easing, iteration and fill-mode all honoured.
 */
function buildSeekStyle({
	targets,
	seconds,
}: {
	targets: AnimatedTarget[];
	seconds: number;
}): string {
	const rules = targets.map(({ index, pseudo, delays }) => {
		const shifted = delays
			.map((delay) => `${(delay - seconds).toFixed(4)}s`)
			.join(",");
		return `[${ANIM_INDEX_ATTR}="${index}"]${pseudo}{animation-delay:${shifted}!important;animation-play-state:paused!important;}`;
	});
	// The first layer wins among !important rules, including authored ID selectors.
	return `<style xmlns="http://www.w3.org/1999/xhtml">:root{--opencut-html-time:${seconds}s}@layer opencut-seek{${rules.join("")}}</style>`;
}

/** Rendered animated frames, LRU-bounded by pixel count (~200MB of RGBA). */
const ANIMATED_FRAME_PIXEL_BUDGET = 50_000_000;
const animatedFrameCache = new Map<string, Promise<CachedHtmlSource>>();
const animatedFramePixels = new Map<string, number>();
let animatedFramePixelTotal = 0;

function rememberAnimatedFrame(
	key: string,
	promise: Promise<CachedHtmlSource>,
	pixels: number,
): void {
	animatedFrameCache.set(key, promise);
	animatedFramePixels.set(key, pixels);
	animatedFramePixelTotal += pixels;
	for (const oldest of animatedFrameCache.keys()) {
		if (animatedFramePixelTotal <= ANIMATED_FRAME_PIXEL_BUDGET) break;
		if (oldest === key) break;
		animatedFrameCache.delete(oldest);
		animatedFramePixelTotal -= animatedFramePixels.get(oldest) ?? 0;
		animatedFramePixels.delete(oldest);
	}
}

/**
 * One frame of an animated HTML element. Unlike static HTML it is NOT cropped
 * to painted pixels: the painted area changes every frame, so cropping would
 * make the element jitter. The declared box is drawn 1:1 instead.
 */
function loadAnimatedHtmlFrame({
	html,
	params,
	width,
	height,
	seconds,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
	seconds: number;
}): Promise<CachedHtmlSource> {
	const key = `${htmlCacheKey({ html, params, width, height })}#${seconds}`;
	const cached = animatedFrameCache.get(key);
	if (cached) {
		animatedFrameCache.delete(key);
		animatedFrameCache.set(key, cached);
		return cached;
	}
	const promise = loadAnimatedTemplate({ html, params, width, height }).then(
		async ({ bodyHtml, targets }) => {
			const canvas = await drawHtmlToCanvas({
				bodyHtml: buildSeekStyle({ targets, seconds }) + bodyHtml,
				width,
				height,
			});
			return { source: canvas, width, height };
		},
	);
	promise.catch(() => {
		if (animatedFrameCache.get(key) === promise) {
			animatedFrameCache.delete(key);
			animatedFramePixelTotal -= animatedFramePixels.get(key) ?? 0;
			animatedFramePixels.delete(key);
		}
	});
	rememberAnimatedFrame(key, promise, width * height);
	return promise;
}

/**
 * One frame of a scripted HTML element: seek the sandboxed runtime, then
 * rasterize the serialized DOM through the shared path. CSS animation seek
 * rules (pseudo-element targets) are injected exactly like the script-less
 * animated pipeline. Scripted frames are never cropped — the painted area
 * changes as scripts animate, same as keyframes-driven frames.
 */
function loadScriptedHtmlFrame({
	html,
	params,
	width,
	height,
	seconds,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
	seconds: number;
}): Promise<CachedHtmlSource> {
	const key = `${htmlCacheKey({ html, params, width, height })}#${seconds}`;
	const cached = animatedFrameCache.get(key);
	if (cached) {
		animatedFrameCache.delete(key);
		animatedFrameCache.set(key, cached);
		return cached;
	}
	const promise = (async () => {
		const runtime = acquireHtmlRuntime({
			key: htmlCacheKey({ html, params, width, height }),
			srcdoc: buildRuntimeSrcdoc({
				bodyHtml: prepareHtml({ html, params, stripEmbedded: true }),
			}),
			width,
			height,
		});
		const frame = await runtime.seek(seconds);
		const canvas = await drawHtmlToCanvas({
			bodyHtml: buildSeekStyle({ targets: frame.pseudoTargets, seconds }) + frame.serialized,
			width,
			height,
		});
		return { source: canvas, width, height };
	})();
	promise.catch(() => {
		if (animatedFrameCache.get(key) === promise) {
			animatedFrameCache.delete(key);
			animatedFramePixelTotal -= animatedFramePixels.get(key) ?? 0;
			animatedFramePixels.delete(key);
		}
	});
	rememberAnimatedFrame(key, promise, width * height);
	return promise;
}

export function loadHtmlSource({
	html,
	params,
	width,
	height,
	seconds = 0,
}: {
	html: string;
	params: ParamValues;
	width: number;
	height: number;
	seconds?: number;
}): Promise<CachedHtmlSource> {
	if (isScriptedHtml({ html })) {
		return loadScriptedHtmlFrame({ html, params, width, height, seconds });
	}
	if (isAnimatedHtml({ html })) {
		return loadAnimatedHtmlFrame({ html, params, width, height, seconds });
	}
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
	const canvas = await drawHtmlToCanvas({
		bodyHtml: prepareHtml({ html, params }),
		width,
		height,
	});
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("OffscreenCanvas 2d context unavailable");
	}

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

async function drawHtmlToCanvas({
	bodyHtml,
	width,
	height,
}: {
	bodyHtml: string;
	width: number;
	height: number;
}): Promise<OffscreenCanvas> {
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
	return canvas;
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
