import { Command, type CommandResult } from "./base-command";

export class BatchCommand extends Command {
	constructor(private commands: Command[]) {
		super();
		// A batch preserves empty tracks only if every child does — a batch
		// containing a delete still prunes.
		this.preserveEmptyTracks = commands.every(
			(command) => command.preserveEmptyTracks,
		);
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
