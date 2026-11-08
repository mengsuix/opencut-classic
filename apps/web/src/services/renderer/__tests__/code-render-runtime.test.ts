import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const browser = Bun.which("agent-browser");
const session = `code-render-${process.pid}`;
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
			const { renderCode, disposeCodeRenderRuntimes } = await import('/runtime.js');
			const source = (color) => {
				const canvas = new OffscreenCanvas(80, 40);
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, 80, 40);
				return canvas;
			};
			const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
			const draw = (code, progress = 0.5, params = {}, inputs = [source('red'), source('blue')]) => renderCode({ code, width: 80, height: 40, inputs, time: progress * 2, duration: 2, progress, params });
			${source}
		})()`,
	]);
}

function isTimeoutResult(value: unknown): value is {
	first: string;
	second: string;
	elapsed: number;
	iframes: number;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"first" in value &&
		typeof value.first === "string" &&
		"second" in value &&
		typeof value.second === "string" &&
		"elapsed" in value &&
		typeof value.elapsed === "number" &&
		"iframes" in value &&
		typeof value.iframes === "number"
	);
}

describe.skipIf(!browser)("Code render runtime in Chromium", () => {
	beforeAll(async () => {
		const build = await Bun.build({
			entrypoints: [
				new URL("../code-render-runtime.ts", import.meta.url).pathname,
			],
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
				return path === "/runtime.js"
					? new Response(code, {
							headers: { "Content-Type": "text/javascript" },
						})
					: new Response(
							"<!doctype html><html><body>Canvas runtime tests</body></html>",
							{
								headers: { "Content-Type": "text/html" },
							},
						);
			},
		});
		await browserCommand(["open", server.url.toString()]);
		await browserCommand(["snapshot", "-i"]);
	}, 60_000);

	afterAll(async () => {
		try {
			await evaluate("disposeCodeRenderRuntimes(); return true;");
			await browserCommand(["close"]);
		} finally {
			server?.stop(true);
		}
	}, 30_000);

	test("renders A/B frames with progress and params, including backward seeks", async () => {
		const result = await evaluate(`
			const code = ${JSON.stringify(`function render(ctx, { inputs, progress, width, height, params }) {
				const [a, b] = inputs;
				ctx.drawImage(a, 0, 0, width, height);
				ctx.save();
				ctx.beginPath();
				ctx.rect(0, 0, width * progress, height);
				ctx.clip();
				ctx.globalAlpha = params.alpha;
				ctx.drawImage(b, 0, 0, width, height);
				ctx.restore();
			}`)};
			const half = await draw(code, 0.5, { alpha: 1 });
			const halfPixels = [pixel(half.canvas, 5, 5), pixel(half.canvas, 70, 5)];
			const quarter = await draw(code, 0.25, { alpha: 1 });
			const quarterPixels = [pixel(quarter.canvas, 5, 5), pixel(quarter.canvas, 30, 5)];
			const halfAgain = await draw(code, 0.5, { alpha: 1 });
			return {
				half: halfPixels,
				quarter: quarterPixels,
				deterministic: pixel(halfAgain.canvas, 5, 5).join(',') === halfPixels[0].join(','),
				iframes: document.querySelectorAll('iframe').length,
			};
		`);
		expect(result).toEqual({
			half: [
				[0, 0, 255, 255],
				[255, 0, 0, 255],
			],
			quarter: [
				[0, 0, 255, 255],
				[255, 0, 0, 255],
			],
			deterministic: true,
			iframes: 1,
		});
	}, 20_000);

	test("supports generator and single-source effect with unified time fields", async () => {
		const result = await evaluate(`
			const generatorCode = ${JSON.stringify(`function render(ctx, { inputs, time, duration, progress, width, height }) {
				const valid = inputs.length === 0 && time === 0.5 && duration === 2 && progress === 0.25;
				ctx.fillStyle = valid ? 'lime' : 'red';
				ctx.fillRect(0, 0, width, height);
			}`)};
			const generated = await draw(generatorCode, 0.25, {}, []);
			const effectCode = ${JSON.stringify(`function render(ctx, { inputs, width, height }) {
				ctx.drawImage(inputs[0], 0, 0, width, height);
				ctx.fillStyle = 'blue';
				ctx.fillRect(0, 0, 10, height);
			}`)};
			const effected = await draw(effectCode, 0.5, {}, [source('red')]);
			return {
				generator: pixel(generated.canvas, 5, 5),
				effect: [pixel(effected.canvas, 5, 5), pixel(effected.canvas, 30, 5)],
			};
		`);
		expect(result).toEqual({
			generator: [0, 255, 0, 255],
			effect: [
				[0, 0, 255, 255],
				[255, 0, 0, 255],
			],
		});
	}, 20_000);

	test("sandbox blocks editor access and network", async () => {
		const result = await evaluate(`
			const code = ${JSON.stringify(`function render(ctx, { inputs, width, height }) {
				ctx.drawImage(inputs[0], 0, 0, width, height);
				try { fetch('/must-not-fetch'); } catch (_) {}
				try { parent.document.title; } catch (_) {}
			}`)};
			const frame = await draw(code);
			await new Promise(resolve => setTimeout(resolve, 100));
			return pixel(frame.canvas, 5, 5);
		`);
		expect(result).toEqual([255, 0, 0, 255]);
		expect(requests.filter((path) => path.startsWith("/must-not-"))).toEqual(
			[],
		);
	}, 20_000);

	test("infinite loops are terminated and the same code is not retried", async () => {
		const result = await evaluate(`
			disposeCodeRenderRuntimes();
			const code = 'function render() { while (true) {} }';
			let first = '';
			let second = '';
			try { await draw(code); } catch (error) { first = error.message; }
			const started = performance.now();
			try { await draw(code); } catch (error) { second = error.message; }
			return { first, second, elapsed: performance.now() - started, iframes: document.querySelectorAll('iframe').length };
		`);
		if (!isTimeoutResult(result)) throw new Error("Invalid timeout result");
		expect(result.first).toContain("timed out");
		expect(result.second).toContain("disabled");
		expect(result.elapsed).toBeLessThan(500);
		expect(result.iframes).toBe(0);
	}, 20_000);
});
