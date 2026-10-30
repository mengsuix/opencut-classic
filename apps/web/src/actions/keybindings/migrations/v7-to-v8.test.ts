import { describe, expect, test } from "bun:test";
import { v7ToV8 } from "./v7-to-v8";

describe("v7ToV8", () => {
	test("adds the ripple shortcut to default keybindings", () => {
		const result = v7ToV8({
			state: {
				keybindings: { space: "toggle-play" },
				isCustomized: false,
			},
		});

		expect(result).toEqual({
			keybindings: { space: "toggle-play", r: "toggle-ripple-editing" },
			isCustomized: false,
		});
	});

	test("does not overwrite customized keybindings", () => {
		const state = {
			keybindings: { r: "split" },
			isCustomized: true,
		};

		expect(v7ToV8({ state })).toEqual(state);
	});

	test("preserves an existing R binding in a default configuration", () => {
		const state = {
			keybindings: { r: "split" },
			isCustomized: false,
		};

		expect(v7ToV8({ state })).toEqual(state);
	});
});
