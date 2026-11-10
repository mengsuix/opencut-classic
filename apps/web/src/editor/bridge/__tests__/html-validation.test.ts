import { describe, expect, test } from "bun:test";
import { htmlAnimationWarnings, validateHtmlEffectSource } from "../html-validation";

const validHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><div data-width="320" data-height="180">Hello</div></body></html>`;

describe("validateHtmlEffectSource", () => {
	test("accepts a self-contained document with a declared size", () => {
		expect(() => validateHtmlEffectSource({ html: validHtml })).not.toThrow();
	});

	test("requires width and height declarations", () => {
		expect(() =>
			validateHtmlEffectSource({ html: "<div>Hello</div>" }),
		).toThrow(/data-width/);
	});

	test.each([
		["external stylesheet", '<link rel="stylesheet" href="https://example.com/a.css">'],
		["CSS import", "<style>@import url('https://example.com/a.css');</style>"],
		["external CSS asset", "<style>div { background: url(https://example.com/a.png); }</style>"],
		["external image", '<img src="https://example.com/a.png">'],
		["insecure script", '<script src="http://example.com/a.js"></script>'],
		["timer", "<script>setTimeout(() => {}, 100)</script>"],
		["wall clock", "<script>Date.now()</script>"],
		["randomness", "<script>Math.random()</script>"],
		["performance clock", "<script>performance.now()</script>"],
	])("rejects %s", (_, fragment) => {
		expect(() =>
			validateHtmlEffectSource({
				html: validHtml.replace("</body>", `${fragment}</body>`),
			}),
		).toThrow(/Invalid HTML effect/);
	});

	test.each(["width", "height", "top", "left"])(
		"rejects GSAP layout property %s",
		(property) => {
			const script = `<script>gsap.to('#box', { ${property}: 100, duration: 1 })</script>`;
			expect(() =>
				validateHtmlEffectSource({
					html: validHtml.replace("</body>", `${script}</body>`),
				}),
			).toThrow(/do not tween layout properties/);
		},
	);

	test("accepts GSAP transform animation", () => {
		const script = `<script>gsap.to('#box', { x: 100, scale: 1.2, duration: 1 })</script>`;
		expect(() =>
			validateHtmlEffectSource({
				html: validHtml.replace("</body>", `${script}</body>`),
			}),
		).not.toThrow();
	});
});

describe("htmlAnimationWarnings", () => {
	const withScript = ({ script, style = "" }: { script: string; style?: string }) =>
		validHtml
			.replace("</head>", `<style>${style}</style></head>`)
			.replace("</body>", `<script>${script}</script></body>`);

	test("returns no warnings without GSAP animation", () => {
		expect(htmlAnimationWarnings({ html: validHtml })).toEqual([]);
	});

	test("warns about centering transform mixed with GSAP x/y", () => {
		const html = withScript({
			script: "gsap.to('#box', { x: 10 })",
			style: "#box { transform: translate(-50%, -50%); }",
		});
		expect(htmlAnimationWarnings({ html })).toContain(
			"CSS translate(-50%,-50%) conflicts with GSAP x/y; center with flex/inset and set the initial position in fromTo",
		);
	});

	test("warns about CSS transition", () => {
		const html = withScript({
			script: "gsap.to('#box', { x: 10 })",
			style: "#box { transition: opacity 1s; }",
		});
		expect(htmlAnimationWarnings({ html })[0]).toMatch(/CSS transition/);
	});

	test("warns about stagger budget", () => {
		const html = withScript({ script: "gsap.to('.item', { x: 10, stagger: 0.1 })" });
		expect(htmlAnimationWarnings({ html })).toContain(
			"Keep element count × stagger at or below 0.5s",
		);
	});

	test("warns about missing will-change for staggered animation", () => {
		const html = withScript({ script: "gsap.to('.item', { x: 10, stagger: 0.1 })" });
		expect(htmlAnimationWarnings({ html })).toContain(
			"Consider will-change: transform for many simultaneously animated elements",
		);
	});

	test("warns about DOM measurement in scripted animation", () => {
		const html = withScript({
			script: "const width = document.querySelector('#box').getBoundingClientRect().width; gsap.to('#box', { x: 10 })",
		});
		expect(htmlAnimationWarnings({ html })).toContain(
			"Measure DOM only once during construction; do not measure inside tween callbacks",
		);
	});
});
