import { PlaybackManager } from "./managers/playback-manager";
import { TimelineManager } from "./managers/timeline-manager";
import { ScenesManager } from "./managers/scenes-manager";
import { ProjectManager } from "./managers/project-manager";
import { MediaManager } from "./managers/media-manager";
import { RendererManager } from "./managers/renderer-manager";
import { CommandManager } from "./managers/commands";
import { SaveManager } from "./managers/save-manager";
import { AudioManager } from "./managers/audio-manager";
import { SelectionManager } from "./managers/selection-manager";
import { ClipboardManager } from "./managers/clipboard-manager";
import { DiagnosticsManager } from "./managers/diagnostics-manager";
import { registerDefaultEffects } from "@/effects";
import { registerDefaultMasks } from "@/masks";
import { registerTranscriptionDiagnostics } from "@/transcription/diagnostics";
import { pruneEmptyTracksByIds } from "./prune-empty-tracks";

export class EditorCore {
	private static instance: EditorCore | null = null;
	public readonly timeline: TimelineManager;
	public readonly command: CommandManager;
	public readonly playback: PlaybackManager;
	public readonly scenes: ScenesManager;
	public readonly project: ProjectManager;
	public readonly media: MediaManager;
	public readonly renderer: RendererManager;
	public readonly save: SaveManager;
	public readonly audio: AudioManager;
	public readonly selection: SelectionManager;
	public readonly clipboard: ClipboardManager;
	public readonly diagnostics: DiagnosticsManager;

	private constructor() {
		registerDefaultEffects();
		registerDefaultMasks();
		this.command = new CommandManager(this);
		this.timeline = new TimelineManager(this);
		this.playback = new PlaybackManager(this);
		this.scenes = new ScenesManager(this);
		this.project = new ProjectManager(this);
		this.media = new MediaManager(this);
		this.renderer = new RendererManager(this);
		this.save = new SaveManager({ editor: this });
		this.audio = new AudioManager(this);
		this.selection = new SelectionManager(this);
		this.clipboard = new ClipboardManager(this);
		this.diagnostics = new DiagnosticsManager(this);
		registerTranscriptionDiagnostics({ diagnostics: this.diagnostics });
		this.playback.bindTimelineScope();
		this.command.registerReactor((command) => {
			const pruneTrackIds = command.pruneTrackIds;
			if (!pruneTrackIds || pruneTrackIds.length === 0) {
				return;
			}

			const activeScene = this.scenes.getActiveSceneOrNull();
			if (!activeScene) {
				return;
			}

			// Only tracks the command touched are eligible for pruning — a
			// manually added empty track elsewhere must survive.
			const tracks = activeScene.tracks;
			const prunedTracks = pruneEmptyTracksByIds({
				tracks,
				trackIds: pruneTrackIds,
			});
			if (prunedTracks !== tracks) {
				this.timeline.updateTracks(prunedTracks);
			}
		});
		this.save.start();
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
		}
		return EditorCore.instance;
	}

	static reset(): void {
		EditorCore.instance = null;
	}
}
