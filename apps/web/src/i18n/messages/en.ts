import type { MessageKey } from "../index";
import { common } from "./en/common";
import { header } from "./en/header";
import { assets } from "./en/assets";
import { properties } from "./en/properties";
import { timeline } from "./en/timeline";
import { shell } from "./en/shell";
import { toasts } from "./en/toasts";

export const en: Record<MessageKey, string> = {
	...common,
	...header,
	...assets,
	...properties,
	...timeline,
	...shell,
	...toasts,
};
