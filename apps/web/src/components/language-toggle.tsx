"use client";

import { Button } from "./ui/button";
import { useI18nStore, useLocale } from "@/i18n";

export function LanguageToggle() {
	const locale = useLocale();
	const setLocale = useI18nStore((state) => state.setLocale);

	return (
		<Button
			variant="text"
			size="sm"
			onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
			aria-label="切换语言 / Switch language"
		>
			{locale === "zh" ? "EN" : "中文"}
		</Button>
	);
}
