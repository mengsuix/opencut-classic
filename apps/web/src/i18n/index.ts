import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { zh } from "./messages/zh";
import { en } from "./messages/en";

export type Locale = "zh" | "en";

export type MessageKey = keyof typeof zh;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { zh, en };

interface I18nStore {
	locale: Locale;
	setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nStore>()(
	persist(
		(set) => ({
			locale: "zh",
			setLocale: (locale) => set({ locale }),
		}),
		{
			name: "opencut-locale",
			skipHydration: true,
		},
	),
);

export function getLocale(): Locale {
	return useI18nStore.getState().locale;
}

export function t(
	key: MessageKey,
	params?: Record<string, string | number>,
): string {
	const dictionary = dictionaries[getLocale()] ?? dictionaries.zh;
	let message = dictionary[key] ?? dictionaries.zh[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			message = message.replaceAll(`{${name}}`, String(value));
		}
	}
	return message;
}

export function useLocale(): Locale {
	useEffect(() => {
		useI18nStore.persist.rehydrate();
	}, []);
	return useI18nStore((state) => state.locale);
}

export function useT(): typeof t {
	useLocale();
	return t;
}
