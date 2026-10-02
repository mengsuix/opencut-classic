/**
 * Sandboxed iframe runtime for scripted HTML elements.
 *
 * The iframe is cross-origin (sandbox="allow-scripts", no allow-same-origin):
 * scripts run inside for JS-driven animation (GSAP timelines registered on
 * window.__timelines), but can never touch the editor page. Frames are
 * captured by seeking the iframe and serializing its DOM; the returned markup
 * is rasterized by html-node through the shared foreignObject path, where
 * scripts are inert again (SVG image sandbox).
 *
 * The injected service also freezes CSS animations into inline styles
 * (paused + delay shifted by the --opencut-html-time variable), so a single
 * serialization carries both GSAP state (inline styles) and CSS animation
 * state. Pseudo-element animations cannot be inlined; their authored delays
 * are reported back so the caller can emit seek rules.
 */

export interface ScriptedPseudoTarget {
	index: string;
	pseudo: "::before" | "::after";
	/** Author animation-delay per animation-name entry, in seconds. */
	delays: number[];
}

export interface ScriptedFrame {
	serialized: string;
	pseudoTargets: ScriptedPseudoTarget[];
}

const RUNTIME_READY_TIMEOUT_MS = 8000;
const SEEK_TIMEOUT_MS = 3000;
const MAX_RUNTIMES = 6;

const ANIM_INDEX_ATTR = "data-hfx-i";

/**
 * Runs inside the sandboxed iframe. Plain ES5: this source is injected
 * verbatim into the srcdoc, keep it free of template literals and ${}.
 */
const SEEK_SERVICE_SCRIPT = [
	"<script>(function(){",
	`var IDX="${ANIM_INDEX_ATTR}";`,
	"function parseTimeList(value){return value.split(',').map(function(part){var text=part.trim();var amount=parseFloat(text);if(!isFinite(amount))return 0;return text.slice(-2)==='ms'?amount/1000:amount;});}",
	// No rAF wait: hidden iframes throttle requestAnimationFrame, and the
	// serialization reads DOM/styles (GSAP seek writes inline styles
	// synchronously), not painted output.
	// Freeze every CSS animation into inline styles, once per element (new
	// elements added by scripts are picked up on later seeks). The delay is
	// rewritten to calc(authored - var(--opencut-html-time)): the serialized
	// markup carries the expression, and the rasterizing document sets the
	// variable per frame — identical to the static probe pipeline.
	"function freeze(){",
	"var pseudo=[];",
	"var els=document.querySelectorAll('*');",
	"for(var i=0;i<els.length;i++){",
	"var el=els[i];",
	"el.setAttribute(IDX,String(i));",
	"if(el.tagName==='SCRIPT'){el.parentNode.removeChild(el);continue;}",
	"if(!el.hasAttribute('data-hfx-frozen')){",
	"var cs=getComputedStyle(el);",
	"var names=cs.animationName.split(',');",
	"var has=false;for(var n=0;n<names.length;n++){var name=names[n].replace(/^\\s+|\\s+$/g,'');if(name&&name!=='none')has=true;}",
	"if(has){",
	"var authored=parseTimeList(cs.animationDelay);",
	"var shifted=[];for(var j=0;j<names.length;j++){shifted.push('calc('+(authored[j%authored.length]||0)+'s - var(--opencut-html-time))');}",
	"el.style.setProperty('animation-delay',shifted.join(','),'important');",
	"el.style.setProperty('animation-play-state','paused','important');",
	"}",
	"el.setAttribute('data-hfx-frozen','1');",
	"}",
	"for(var p=0;p<2;p++){",
	"var pe=p===0?'::before':'::after';",
	"var pcs=getComputedStyle(el,pe);",
	"var pnames=pcs.animationName.split(',');",
	"var phas=false;for(var m=0;m<pnames.length;m++){var pn=pnames[m].replace(/^\\s+|\\s+$/g,'');if(pn&&pn!=='none')phas=true;}",
	"if(!phas)continue;",
	"var pauthored=parseTimeList(pcs.animationDelay);",
	"var pdelays=[];for(var q=0;q<pnames.length;q++){pdelays.push(pauthored[q%pauthored.length]||0);}",
	"pseudo.push({index:String(i),pseudo:pe,delays:pdelays});",
	"}",
	"}",
	"return pseudo;",
	"}",
	"onmessage=function(e){",
	"var d=e.data||{};",
	"if(d.cmd!=='seek')return;",
	"(async function(){",
	"if(window.__timelines){for(var k in window.__timelines){var tl=window.__timelines[k];if(tl&&typeof tl.seek==='function')tl.seek(d.t);}}",
	"var pseudo=freeze();",
	"var target=document.body.firstElementChild||document.body;",
	"var serialized=new XMLSerializer().serializeToString(target);",
	"parent.postMessage({type:'frame',id:d.id,serialized:serialized,pseudoTargets:pseudo},'*');",
	"})().catch(function(err){parent.postMessage({type:'frame',id:d.id,error:String(err&&err.message||err)},'*');});",
	"};",
	"window.addEventListener('load',function(){parent.postMessage({type:'ready'},'*');});",
	"})();</script>",
].join("");

/**
 * Wrap the prepared body markup into a srcdoc. Scripts are allowed (inline +
 * HTTPS CDN) so GSAP can run; everything else stays locked down, matching what
 * foreignObject rasterization can paint (data: images/fonts only).
 */
export function buildRuntimeSrcdoc({ bodyHtml }: { bodyHtml: string }): string {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' https:; style-src \'unsafe-inline\'; img-src data:; font-src data:; base-uri \'none\'; form-action \'none\'">',
		"<style>html,body{margin:0;padding:0;width:100%;height:100%}:root{--opencut-html-time:0s}</style>",
		"</head><body>",
		bodyHtml,
		SEEK_SERVICE_SCRIPT,
		"</body></html>",
	].join("");
}

interface PendingSeek {
	resolve: (frame: ScriptedFrame) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

class HtmlRuntime {
	private iframe: HTMLIFrameElement;
	private readyPromise: Promise<void>;
	private chain: Promise<unknown> = Promise.resolve();
	private nextSeekId = 0;
	private pending = new Map<number, PendingSeek>();

	constructor({ srcdoc, width, height }: { srcdoc: string; width: number; height: number }) {
		this.iframe = document.createElement("iframe");
		this.iframe.setAttribute("sandbox", "allow-scripts");
		this.iframe.setAttribute("aria-hidden", "true");
		this.iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;visibility:hidden;border:0;`;
		this.iframe.srcdoc = srcdoc;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("HTML runtime timed out while loading")),
				RUNTIME_READY_TIMEOUT_MS,
			);
			const onMessage = (event: MessageEvent) => {
				if (event.source !== this.iframe.contentWindow) return;
				const data = event.data || {};
				if (data.type === "ready") {
					clearTimeout(timeout);
					window.removeEventListener("message", onMessage);
					resolve();
				}
			};
			window.addEventListener("message", onMessage);
		});
		window.addEventListener("message", this.onFrameMessage);
		document.body.appendChild(this.iframe);
	}

	private onFrameMessage = (event: MessageEvent) => {
		if (event.source !== this.iframe.contentWindow) return;
		const data = event.data || {};
		if (data.type !== "frame") return;
		const entry = this.pending.get(data.id);
		if (!entry) return;
		this.pending.delete(data.id);
		clearTimeout(entry.timeout);
		if (data.error) {
			entry.reject(new Error(data.error));
		} else {
			entry.resolve({ serialized: data.serialized, pseudoTargets: data.pseudoTargets });
		}
	};

	/** Seeks are serialized per runtime: one in flight, the rest queued. */
	seek(seconds: number): Promise<ScriptedFrame> {
		const run = this.chain.then(() => this.seekNow(seconds));
		this.chain = run.catch(() => {});
		return run;
	}

	private async seekNow(seconds: number): Promise<ScriptedFrame> {
		await this.readyPromise;
		const id = this.nextSeekId++;
		return new Promise<ScriptedFrame>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("HTML runtime seek timed out"));
			}, SEEK_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timeout });
			this.iframe.contentWindow?.postMessage({ cmd: "seek", id, t: seconds }, "*");
		});
	}

	dispose(): void {
		window.removeEventListener("message", this.onFrameMessage);
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timeout);
			entry.reject(new Error("HTML runtime disposed"));
		}
		this.pending.clear();
		this.iframe.remove();
	}
}

const runtimes = new Map<string, HtmlRuntime>();

/** Runtimes are keyed by raster content, so editing a param gets a fresh iframe. */
export function acquireHtmlRuntime({
	key,
	srcdoc,
	width,
	height,
}: {
	key: string;
	srcdoc: string;
	width: number;
	height: number;
}): HtmlRuntime {
	const existing = runtimes.get(key);
	if (existing) {
		runtimes.delete(key);
		runtimes.set(key, existing);
		return existing;
	}
	const runtime = new HtmlRuntime({ srcdoc, width, height });
	runtimes.set(key, runtime);
	while (runtimes.size > MAX_RUNTIMES) {
		const oldest = runtimes.keys().next().value;
		if (oldest === undefined || oldest === key) break;
		runtimes.get(oldest)?.dispose();
		runtimes.delete(oldest);
	}
	return runtime;
}
