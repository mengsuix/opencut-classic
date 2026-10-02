/**
 * Shared registry of canvases that are known to be origin-clean.
 *
 * WebGPU refuses canvases tainted by cross-origin content, and wgpu's unwrap
 * turns that error into a panic that wedges the whole compositor — so before
 * the first upload every canvas is probed with a 1×1 getImageData. On a busy
 * GPU queue that probe synchronizes with the GPU and stalls the main thread
 * for several milliseconds (measured 3–25ms per frame during animated-HTML
 * playback), so producers that can vouch for their pixels register the canvas
 * up front instead of paying the probe.
 *
 * Contract: only register a canvas whose pixels are guaranteed to come from
 * same-origin sources (a canvas painted from a `data:` image, a pooled frame
 * canvas). Registering a canvas that later receives cross-origin pixels would
 * let a tainted upload reach wgpu and permanently break the compositor.
 */
const uploadableCanvases = new WeakSet<OffscreenCanvas>();

export function markCanvasUploadable(canvas: OffscreenCanvas): void {
	uploadableCanvases.add(canvas);
}

export function isCanvasUploadable(canvas: OffscreenCanvas): boolean {
	if (uploadableCanvases.has(canvas)) return true;
	const context = canvas.getContext("2d");
	if (!context) return true;
	try {
		context.getImageData(0, 0, 1, 1);
		uploadableCanvases.add(canvas);
		return true;
	} catch {
		return false;
	}
}
