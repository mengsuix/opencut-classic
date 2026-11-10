const HTML_EFFECT_FORBIDDEN: Array<[RegExp, string]> = [
	[/<link[\s/>]/i, "external stylesheets are not supported; use inline <style>"],
	[/@import\b/i, "@import is not supported; use inline <style>"],
	[
		/url\(\s*['"]?https?:/i,
		"external url() assets are not supported; embed data: URLs",
	],
	[
		/<(img|image|source)[^>]*\bsrc\s*=\s*['"]?https?:/i,
		"images must be data: URLs",
	],
	[
		/<script[^>]*\bsrc\s*=\s*['"]?http:\/\//i,
		"script src must be HTTPS",
	],
	[
		/\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/,
		"timers do not follow the timeline; use CSS @keyframes or ONE paused GSAP timeline on window.__timelines.main",
	],
	[
		/\b(?:Date\.now|Math\.random|performance\.now)\s*\(/,
		"wall-clock and random break deterministic seeking; use fixed seeds and time-driven state",
	],
];

const GSAP_TWEEN_RE = /\.(?:to|from|fromTo)\s*\(([^)]*)\)/gs;

function gsapTweenBodies(html: string): string[] {
	if (!/\bgsap\b/.test(html)) return [];
	return [...html.matchAll(GSAP_TWEEN_RE)].map((match) => match[1]);
}

export function validateHtmlEffectSource({ html }: { html: string }): void {
	if (!/data-width="\d+"/.test(html) || !/data-height="\d+"/.test(html)) {
		throw new Error(
			'root element must declare data-width="<px>" and data-height="<px>"',
		);
	}
	for (const [pattern, reason] of HTML_EFFECT_FORBIDDEN) {
		if (pattern.test(html)) {
			throw new Error(`Invalid HTML effect: ${reason}`);
		}
	}
	for (const tween of gsapTweenBodies(html)) {
		if (/\b(?:width|height|top|left)\s*:/.test(tween)) {
			throw new Error(
				"Invalid HTML animation: do not tween layout properties (width/height/top/left); use GSAP x/y/scale/rotation",
			);
		}
	}
}

export function htmlAnimationWarnings({ html }: { html: string }): string[] {
	const tweens = gsapTweenBodies(html);
	if (tweens.length === 0) return [];
	const warnings: string[] = [];
	if (
		/transform\s*:\s*translate\(\s*-50%\s*,\s*-50%\s*\)/.test(html) &&
		tweens.some((tween) => /\b[xy]\s*:/.test(tween))
	) {
		warnings.push(
			"CSS translate(-50%,-50%) conflicts with GSAP x/y; center with flex/inset and set the initial position in fromTo",
		);
	}
	if (/\btransition\s*:/.test(html)) {
		warnings.push(
			"Ensure GSAP-animated elements do not use CSS transition; it bypasses deterministic seeking",
		);
	}
	if (tweens.some((tween) => /\bstagger\s*:/.test(tween))) {
		warnings.push("Keep element count × stagger at or below 0.5s");
	}
	if (
		!/\bwill-change\s*:/.test(html) &&
		(/\bstagger\s*:/.test(html) || (html.match(/<[a-zA-Z]/g) ?? []).length > 20)
	) {
		warnings.push("Consider will-change: transform for many simultaneously animated elements");
	}
	if (/\b(?:getBoundingClientRect|getComputedStyle)\s*\(/.test(html)) {
		warnings.push(
			"Measure DOM only once during construction; do not measure inside tween callbacks",
		);
	}
	return warnings;
}
