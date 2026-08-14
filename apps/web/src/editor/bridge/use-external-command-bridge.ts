import { useEffect } from "react";
import { startEditorCommandBridge } from "./client";

export function useExternalCommandBridge(): void {
	useEffect(() => startEditorCommandBridge(), []);
}
