import type { DiagnosticsManager } from "@/core/managers/diagnostics-manager";
import { t } from "@/i18n";
import { timelineHasAudio } from "@/media/audio";

export const TRANSCRIPTION_DIAGNOSTICS_SCOPE = "transcription";

export function registerTranscriptionDiagnostics({
	diagnostics,
}: {
	diagnostics: DiagnosticsManager;
}): void {
	diagnostics.register({
		id: "transcription.no_audio",
		scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE,
		severity: "caution",
		get message() {
			return t("assets.noAudioDetected");
		},
		check: (editor) => {
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!scene) return false;
			return !timelineHasAudio({
				tracks: scene.tracks,
				mediaAssets: editor.media.getAssets(),
			});
		},
	});
}
