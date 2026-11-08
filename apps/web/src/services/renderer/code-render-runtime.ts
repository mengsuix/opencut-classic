import type { ParamValues } from "@/params";

const READY_TIMEOUT_MS = 5_000;
const RENDER_TIMEOUT_MS = 2_000;
const MAX_RUNTIMES = 4;
const MAX_FAILED_RUNTIMES = 32;

const HOST_SRCDOC = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script>
let worker;
let activeId = null;
const send = (message, transfer = []) => parent.postMessage(message, "*", transfer);
onmessage = (event) => {
	if (event.source !== parent) return;
	const data = event.data || {};
	if (data.type === "code-render-init") {
		worker?.terminate();
		const url = URL.createObjectURL(new Blob([data.source], { type: "text/javascript" }));
		worker = new Worker(url);
		URL.revokeObjectURL(url);
		worker.onmessage = (message) => {
			const value = message.data || {};
			if (value.type === "ready") send({ type: "code-render-ready" });
			if (value.type === "result") {
				activeId = null;
				send({ type: "code-render-result", id: value.id, bitmap: value.bitmap, error: value.error }, value.bitmap ? [value.bitmap] : []);
			}
		};
		worker.onerror = (event) => {
			if (activeId === null) return;
			send({ type: "code-render-result", id: activeId, error: event.message || "Worker failed" });
			activeId = null;
		};
		return;
	}
	if (data.type === "code-render-render" && worker) {
		activeId = data.id;
		worker.postMessage({ type: "render", id: data.id, inputs: data.inputs, time: data.time, duration: data.duration, progress: data.progress, params: data.params }, data.inputs);
	}
};
send({ type: "code-render-host-ready" });
</script></body></html>`;

function buildWorkerSource({
	code,
	width,
	height,
}: {
	code: string;
	width: number;
	height: number;
}): string {
	return `"use strict";
const __hostPostMessage = self.postMessage.bind(self);
self.postMessage = undefined;
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;
self.Worker = undefined;
self.importScripts = undefined;
const __canvas = new OffscreenCanvas(${width}, ${height});
const __ctx = __canvas.getContext("2d");
if (!__ctx) throw new Error("Canvas 2D is unavailable");
const __userRender = (() => {
${code}
;return render;
})();
if (typeof __userRender !== "function") throw new Error("Code render must define function render(ctx, frame)");
self.onmessage = (event) => {
	const data = event.data || {};
	if (data.type !== "render") return;
	try {
		if (__ctx.reset) __ctx.reset();
		else {
			__ctx.setTransform(1, 0, 0, 1, 0, 0);
			__ctx.globalAlpha = 1;
			__ctx.globalCompositeOperation = "source-over";
			__ctx.clearRect(0, 0, ${width}, ${height});
		}
		__ctx.save();
		let returned;
		try {
			returned = __userRender(__ctx, { inputs: data.inputs, time: data.time, duration: data.duration, progress: data.progress, width: ${width}, height: ${height}, params: data.params });
		} finally {
			__ctx.restore();
		}
		if (returned && typeof returned.then === "function") throw new Error("render() must be synchronous");
		const bitmap = __canvas.transferToImageBitmap();
		__hostPostMessage({ type: "result", id: data.id, bitmap }, [bitmap]);
	} catch (error) {
		__hostPostMessage({ type: "result", id: data.id, error: error instanceof Error ? error.message : String(error) });
	} finally {
		for (const input of data.inputs) input.close();
	}
};
__hostPostMessage({ type: "ready" });`;
}

type PendingRender = {
	resolve: (result: { canvas: OffscreenCanvas; contentHash: string }) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

export type CodeRenderFrame = {
	inputs: OffscreenCanvas[];
	time: number;
	duration: number;
	progress: number;
	params: ParamValues;
};

let nextRuntimeId = 0;

class CodeRenderRuntime {
	private iframe: HTMLIFrameElement;
	private readyPromise: Promise<void>;
	private chain: Promise<unknown> = Promise.resolve();
	private pending = new Map<number, PendingRender>();
	private nextRenderId = 0;
	private instanceId = nextRuntimeId++;
	private disposed = false;

	constructor({
		key,
		code,
		width,
		height,
		onDispose,
	}: {
		key: string;
		code: string;
		width: number;
		height: number;
		onDispose: (key: string) => void;
	}) {
		this.key = key;
		this.onDispose = onDispose;
		this.iframe = document.createElement("iframe");
		this.iframe.setAttribute("sandbox", "allow-scripts");
		this.iframe.setAttribute("aria-hidden", "true");
		this.iframe.style.cssText =
			"position:fixed;left:-100000px;top:0;width:1px;height:1px;visibility:hidden;border:0;";
		this.iframe.srcdoc = HOST_SRCDOC;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Code render runtime timed out while loading"));
				this.dispose();
			}, READY_TIMEOUT_MS);
			const onMessage = (event: MessageEvent) => {
				if (event.source !== this.iframe.contentWindow) return;
				if (event.data?.type === "code-render-host-ready") {
					this.iframe.contentWindow?.postMessage(
						{
							type: "code-render-init",
							source: buildWorkerSource({ code, width, height }),
						},
						"*",
					);
				}
				if (event.data?.type === "code-render-ready") {
					clearTimeout(timeout);
					window.removeEventListener("message", onMessage);
					resolve();
				}
			};
			window.addEventListener("message", onMessage);
		});
		window.addEventListener("message", this.onMessage);
		document.body.appendChild(this.iframe);
	}

	private key: string;
	private onDispose: (key: string) => void;

	private onMessage = (event: MessageEvent) => {
		if (event.source !== this.iframe.contentWindow) return;
		const data = event.data || {};
		if (data.type !== "code-render-result") return;
		const entry = this.pending.get(data.id);
		if (!entry) {
			data.bitmap?.close();
			return;
		}
		this.pending.delete(data.id);
		clearTimeout(entry.timeout);
		if (data.error) {
			data.bitmap?.close();
			entry.reject(new Error(data.error));
			return;
		}
		if (!(data.bitmap instanceof ImageBitmap)) {
			entry.reject(new Error("Code render returned an invalid frame"));
			return;
		}
		const canvas = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			data.bitmap.close();
			entry.reject(new Error("Canvas 2D is unavailable"));
			return;
		}
		ctx.drawImage(data.bitmap, 0, 0);
		data.bitmap.close();
		entry.resolve({
			canvas,
			contentHash: `code-render:${this.instanceId}:${data.id}`,
		});
	};

	render(frame: CodeRenderFrame): Promise<{
		canvas: OffscreenCanvas;
		contentHash: string;
	}> {
		const run = this.chain.then(() => this.renderNow(frame));
		this.chain = run.catch(() => {});
		return run;
	}

	private async renderNow(
		frame: CodeRenderFrame,
	): Promise<{ canvas: OffscreenCanvas; contentHash: string }> {
		if (this.disposed) throw new Error("Code render runtime is disposed");
		await this.readyPromise;
		const id = this.nextRenderId++;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const error = new Error("Code render timed out");
				this.pending.delete(id);
				this.dispose();
				reject(error);
			}, RENDER_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timeout });
			const inputs = frame.inputs.map((input) => input.transferToImageBitmap());
			this.iframe.contentWindow?.postMessage(
				{
					type: "code-render-render",
					id,
					inputs,
					time: frame.time,
					duration: frame.duration,
					progress: frame.progress,
					params: frame.params,
				},
				"*",
				inputs,
			);
		});
	}

	dispose(markFailed = true): void {
		if (this.disposed) return;
		this.disposed = true;
		if (markFailed) this.onDispose(this.key);
		else runtimes.delete(this.key);
		window.removeEventListener("message", this.onMessage);
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timeout);
			entry.reject(new Error("Code render runtime disposed"));
		}
		this.pending.clear();
		this.iframe.remove();
	}
}

const runtimes = new Map<string, CodeRenderRuntime>();
const failedRuntimes = new Set<string>();

export async function renderCode({
	code,
	width,
	height,
	...frame
}: {
	code: string;
	width: number;
	height: number;
} & CodeRenderFrame): Promise<{
	canvas: OffscreenCanvas;
	contentHash: string;
}> {
	const key = `${width}x${height}:${code}`;
	if (failedRuntimes.has(key)) {
		throw new Error("Code render is disabled after a previous failure");
	}
	let runtime = runtimes.get(key);
	if (!runtime) {
		runtime = new CodeRenderRuntime({
			key,
			code,
			width,
			height,
			onDispose: (disposedKey) => {
				runtimes.delete(disposedKey);
				failedRuntimes.add(disposedKey);
				while (failedRuntimes.size > MAX_FAILED_RUNTIMES) {
					const oldest = failedRuntimes.values().next().value;
					if (oldest === undefined) break;
					failedRuntimes.delete(oldest);
				}
			},
		});
		runtimes.set(key, runtime);
		while (runtimes.size > MAX_RUNTIMES) {
			const oldest = runtimes.keys().next().value;
			if (oldest === undefined || oldest === key) break;
			runtimes.get(oldest)?.dispose(false);
			runtimes.delete(oldest);
		}
	}
	try {
		return await runtime.render(frame);
	} catch (error) {
		runtime.dispose();
		throw error;
	}
}

export function disposeCodeRenderRuntimes(): void {
	for (const runtime of runtimes.values()) runtime.dispose(false);
	runtimes.clear();
	failedRuntimes.clear();
}
