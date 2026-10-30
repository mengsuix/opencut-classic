import { Command, type CommandResult } from "./base-command";

export class BatchCommand extends Command {
	constructor(private commands: Command[]) {
		super();
		// A batch prunes the union of its children's prunable tracks — a batch
		// containing a delete still prunes the tracks that delete touched.
		const pruneTrackIds = [
			...new Set(
				commands.flatMap((command) => command.pruneTrackIds ?? []),
			),
		];
		if (pruneTrackIds.length > 0) {
			this.pruneTrackIds = pruneTrackIds;
		}
	}

	execute(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;

		for (const command of this.commands) {
			const result = command.execute();
			if (result?.selection !== undefined) {
				latestSelectionResult = result;
			}
		}

		return latestSelectionResult;
	}

	undo(): void {
		for (const command of [...this.commands].reverse()) {
			command.undo();
		}
	}

	redo(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;

		for (const command of this.commands) {
			const result = command.redo();
			if (result?.selection !== undefined) {
				latestSelectionResult = result;
			}
		}

		return latestSelectionResult;
	}
}
