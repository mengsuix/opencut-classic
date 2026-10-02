import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const browser = Bun.which("agent-browser");
const session = `html-renderer-${process.pid}`;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: string[] = [];

async function browserCommand(args: string[]): Promise<unknown> {
	const proc = Bun.spawn([browser!, "--session", session, "--json", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
	const result = JSON.parse(stdout);
	if (!result.success) throw new Error(result.error);
	return result.data?.result;
}

async function evaluate(source: string) {
	return browserCommand([
		"eval",
		`(async () => {
			const { loadHtmlSource, getCachedHtmlContentSize } = await import('/html-node.js');
			const pixel = (frame, x, y) => [...frame.source.getContext('2d').getImageData(x, y, 1, 1).data];
			${source}
		})()`,
	]);
}

const movingHtml = `<style>
@keyframes move { from { transform: translateX(0); } to { transform: translateX(100px); } }
#box { position:absolute; width:20px; height:20px; background:red; animation:move 1s linear both; }
</style><div id="box"></div>`;

// These tests need real SVG/foreignObject painting, not a DOM emulator.
describe.skipIf(!browser)("HTML renderer in Chromium", () => {
	beforeAll(async () => {
		const build = await Bun.build({
			entrypoints: [new URL("../html-node.ts", import.meta.url).pathname],
			target: "browser",
			format: "esm",
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const code = await build.outputs[0].text();
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				requests.push(path);
				return path === "/html-node.js"
					? new Response(code, { headers: { "Content-Type": "text/javascript" } })
					: new Response("<!doctype html><html><body>HTML renderer tests</body></html>", {
							headers: { "Content-Type": "text/html" },
						});
			},
		});
		await browserCommand(["open", server.url.toString()]);
		await browserCommand(["snapshot", "-i"]);
	}, 60_000);

	afterAll(async () => {
		try {
			await browserCommand(["close"]);
		} finally {
			server?.stop(true);
		}
	}, 30_000);

	test("static HTML still crops and reuses the same pixels at every time", async () => {
		const result = await evaluate(`
			const args = {html:'<div style="position:absolute;left:10px;top:8px;width:20px;height:12px;background:red"></div>',params:{},width:160,height:60};
			const first = await loadHtmlSource({...args,seconds:0});
			const later = await loadHtmlSource({...args,seconds:10});
			return {width:first.width,height:first.height,same:first===later,pixel:pixel(first,0,0),bounds:getCachedHtmlContentSize(args)};
		`);
		expect(result).toEqual({
			width: 20,
			height: 12,
			same: true,
			pixel: [255, 0, 0, 255],
			bounds: { width: 20, height: 12 },
		});
	}, 15_000);

	test("CSS animation seeks forward/backward without cropping or wall-clock drift", async () => {
		const result = await evaluate(`
			const args = {html:${JSON.stringify(movingHtml)},params:{},width:160,height:60};
			const points = [];
			for (const seconds of [0,0.5,1,0.25]) {
				const frame = await loadHtmlSource({...args,seconds});
				points.push({size:[frame.width,frame.height],rgba:pixel(frame,seconds*100+5,5)});
			}
			const a = await loadHtmlSource({...args,seconds:0.5});
			await new Promise(resolve=>setTimeout(resolve,80));
			const b = await loadHtmlSource({...args,seconds:0.5});
			return {points,same:a===b,bounds:getCachedHtmlContentSize(args),iframes:document.querySelectorAll('iframe').length};
		`);
		expect(result).toEqual({
			points: Array.from({ length: 4 }, () => ({ size: [160, 60], rgba: [255, 0, 0, 255] })),
			same: true,
			bounds: { width: 160, height: 60 },
			iframes: 0,
		});
	}, 15_000);

	test("staggered delays, pseudo elements and multiple animations keep their timing", async () => {
		const html = `<style>
@keyframes move { from {transform:translateX(0)} to {transform:translateX(100px)} }
@keyframes fade { from {opacity:0} to {opacity:1} }
#box {position:absolute;width:10px;height:10px;background:red;--wait:500ms;animation:move 1s linear var(--wait) both}
#box::before {content:"";position:absolute;top:20px;width:10px;height:10px;background:blue;animation:move 1s linear 250ms both}
#other {position:absolute;top:40px;width:10px;height:10px;background:lime;animation:move 1s linear 100ms both,fade 1s linear 200ms both}
</style><div id="box"></div><div id="other"></div>`;
		const result = await evaluate(`
			const frame = await loadHtmlSource({html:${JSON.stringify(html)},params:{},width:200,height:80,seconds:0.5});
			return [pixel(frame,5,5),pixel(frame,30,25),pixel(frame,45,45)];
		`);
		expect(result).toEqual([[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 77]]);
	}, 15_000);

	test("steps, reverse iterations and the final fill state are deterministic", async () => {
		const html = movingHtml.replace("1s linear both", "1s steps(4,end) 0s 2 alternate both");
		const result = await evaluate(`
			const args = {html:${JSON.stringify(html)},params:{},width:160,height:60};
			const points=[];
			for(const [seconds,x] of [[0.24,0],[0.25,25],[1.25,75],[2,0]]) {
				points.push(pixel(await loadHtmlSource({...args,seconds}),x+5,5));
			}
			return points;
		`);
		expect(result).toEqual(Array.from({ length: 4 }, () => [255, 0, 0, 255]));
	}, 15_000);

	test("authored important animation declarations cannot override timeline seeking", async () => {
		const html = movingHtml
			.replace("animation:move 1s linear both;", "animation:move 1s linear both !important;")
			.replace('<div id="box">', '<div id="box" style="animation-delay:0s!important;animation-play-state:running!important">');
		const result = await evaluate(`
			const frame = await loadHtmlSource({html:${JSON.stringify(html)},params:{},width:160,height:60,seconds:0.5});
			return pixel(frame,55,5);
		`);
		expect(result).toEqual([255, 0, 0, 255]);
	}, 15_000);

	test("editable text invalidates cached frames, transform-only changes do not", async () => {
		const html = movingHtml.replace("<div id=\"box\"></div>", '<div id="box"></div><span data-param="title" style="position:absolute;top:30px;font:18px monospace">A</span>');
		const result = await evaluate(`
			const args = {html:${JSON.stringify(html)},width:160,height:60,seconds:0.5};
			const a = await loadHtmlSource({...args,params:{title:'A'}});
			const b = await loadHtmlSource({...args,params:{title:'BBBB'}});
			const c = await loadHtmlSource({...args,params:{title:'BBBB','transform.positionX':40}});
			const bytes = frame => [...frame.source.getContext('2d').getImageData(0,30,160,30).data].join(',');
			return {changed:a!==b&&bytes(a)!==bytes(b),same:b===c};
		`);
		expect(result).toEqual({ changed: true, same: true });
	}, 15_000);

	test("animation probing does not execute scripts, navigate or request external resources", async () => {
		const html = movingHtml + `<meta http-equiv="refresh" content="0;url=/must-not-navigate"><img src="/must-not-fetch" onerror="parent.htmlProbeExecuted=true"><iframe src="/must-not-frame"></iframe><style>@import url('/must-not-import');</style>`;
		const result = await evaluate(`
			const frame = await loadHtmlSource({html:${JSON.stringify(html)},params:{},width:160,height:60,seconds:0.5});
			await new Promise(resolve=>setTimeout(resolve,100));
			return {pixel:pixel(frame,55,5),executed:window.htmlProbeExecuted===true,iframes:document.querySelectorAll('iframe').length};
		`);
		expect(result).toEqual({ pixel: [255, 0, 0, 255], executed: false, iframes: 0 });
		expect(requests.filter((path) => path.startsWith("/must-not-"))).toEqual([]);
	}, 15_000);

	test("scripted HTML seeks JS timelines and freezes CSS animations in the same frame", async () => {
		const html = `<style>
@keyframes fade { from {opacity:0} to {opacity:1} }
#css {position:absolute;top:30px;width:10px;height:10px;background:lime;animation:fade 1s linear both}
</style><div id="box" style="position:absolute;width:20px;height:20px;background:red"></div><div id="css"></div><script>window.__timelines={main:{seek:function(t){document.getElementById('box').style.transform='translateX('+(t*100)+'px)';}}};</script>`;
		const result = await evaluate(`
			const args = {html:${JSON.stringify(html)},params:{},width:200,height:80};
			const a = await loadHtmlSource({...args,seconds:0.5});
			const again = await loadHtmlSource({...args,seconds:0.5});
			const moved = await loadHtmlSource({...args,seconds:1});
			return {half:[pixel(a,55,5),pixel(a,5,35)],end:pixel(moved,105,5),same:a===again,iframes:document.querySelectorAll('iframe').length};
		`);
		expect(result).toEqual({
			half: [
				[255, 0, 0, 255],
				[0, 255, 0, 128],
			],
			end: [255, 0, 0, 255],
			same: true,
			iframes: 1,
		});
	}, 15_000);

	test("sandboxed scripts run but cannot reach the editor page, navigate or fetch", async () => {
		const html = `<meta http-equiv="refresh" content="0;url=/must-not-navigate"><div id="flag" style="width:10px;height:10px;background:red"></div><img src="/must-not-fetch"><script>try{parent.document.title;}catch(e){document.getElementById('flag').style.background='blue';}window.__timelines={main:{seek:function(t){}}};</script>`;
		const result = await evaluate(`
			const frame = await loadHtmlSource({html:${JSON.stringify(html)},params:{},width:40,height:20,seconds:0});
			await new Promise(resolve=>setTimeout(resolve,100));
			return {pixel:pixel(frame,5,5),executed:window.htmlProbeExecuted===true,hasIframe:document.querySelectorAll('iframe').length>0};
		`);
		expect(result).toEqual({ pixel: [0, 0, 255, 255], executed: false, hasIframe: true });
		expect(requests.filter((path) => path.startsWith("/must-not-"))).toEqual([]);
	}, 15_000);

	test("scripted HTML sustains playback-rate seeking (30fps x 60 frames)", async () => {
		const html = `<div id="box" style="position:absolute;width:20px;height:20px;background:red"></div><script>window.__timelines={main:{seek:function(t){document.getElementById('box').style.transform='translateX('+(t*80)+'px)';}}};</script>`;
		const result = await evaluate(`
			const args = {html:${JSON.stringify(html)},params:{},width:640,height:360};
			const t0 = performance.now();
			for (let i=0;i<60;i++) await loadHtmlSource({...args,seconds:i/30});
			const total = performance.now()-t0;
			return {totalMs:Math.round(total),perFrame:+(total/60).toFixed(1)};
		`);
		const { perFrame } = result as { totalMs: number; perFrame: number };
		console.log(`scripted playback seek: ${perFrame}ms/frame`);
		expect(perFrame).toBeLessThan(33);
	}, 30_000);
});
