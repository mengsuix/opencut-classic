"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useT } from "@/i18n";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Input } from "@/components/ui/input";
import { extractHtmlParams } from "@/services/renderer/nodes/html-node";
import type { HtmlElement } from "@/timeline";

function HtmlParamField({
	element,
	trackId,
	paramKey,
}: {
	element: HtmlElement;
	trackId: string;
	paramKey: string;
}) {
	const editor = useEditor();
	const current = element.params[paramKey];
	const initialValue = typeof current === "string" ? current : "";
	const [value, setValue] = useState(initialValue);

	const commit = () => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: { [paramKey]: value } },
				},
			],
		});
	};

	return (
		<Input
			value={value}
			onChange={(event) => setValue(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

export function HtmlParamsTab({
	element,
	trackId,
}: {
	element: HtmlElement;
	trackId: string;
}) {
	const t = useT();
	const keys = extractHtmlParams({ html: element.html });

	return (
		<div className="flex flex-col">
			<Section collapsible sectionKey={`${element.id}:html`}>
				<SectionHeader>
					<SectionTitle>{t("properties.tabHtml")}</SectionTitle>
				</SectionHeader>
				<SectionContent>
					{keys.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							{t("properties.htmlNoParams")}
						</p>
					) : (
						<SectionFields>
							{keys.map((paramKey) => (
								<div key={paramKey} className="flex flex-col gap-1">
									<span className="text-muted-foreground text-xs">
										{paramKey}
									</span>
									<HtmlParamField
										element={element}
										trackId={trackId}
										paramKey={paramKey}
									/>
								</div>
							))}
						</SectionFields>
					)}
				</SectionContent>
			</Section>
		</div>
	);
}
