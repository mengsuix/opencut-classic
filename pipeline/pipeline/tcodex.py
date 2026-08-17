from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class TcodexResult:
    exit_code: int
    session_id: str | None
    text: str
    stdout: str
    stderr: str
    error_events: list[dict]


class TcodexClient:
    def __init__(
        self,
        *,
        cwd: Path,
        schema_path: Path,
        timeout: int = 600,
        executable: str | None = None,
    ) -> None:
        self.cwd = cwd
        self.schema_path = schema_path
        self.timeout = timeout
        self.executable = executable or os.environ.get("TCODEX_BIN", "tcodex")

    def run(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        search: bool = False,
    ) -> TcodexResult:
        command = [self.executable, "--", "--ask-for-approval", "never", "--sandbox", "read-only"]
        if search:
            command.append("--search")
        command.extend(["exec"])
        if session_id:
            command.extend(["resume", session_id])
        command.extend(["--output-schema", str(self.schema_path), "--json", "-"])

        try:
            completed = subprocess.run(
                command,
                cwd=self.cwd,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _as_text(exc.stdout)
            stderr = _as_text(exc.stderr)
            return TcodexResult(
                exit_code=124,
                session_id=None,
                text="",
                stdout=stdout,
                stderr=stderr,
                error_events=[{"type": "timeout", "message": f"tcodex 超时（{self.timeout} 秒）"}],
            )
        except OSError as exc:
            return TcodexResult(
                exit_code=127,
                session_id=None,
                text="",
                stdout="",
                stderr=str(exc),
                error_events=[{"type": "process_error", "message": str(exc)}],
            )

        return _parse_result(completed.returncode, completed.stdout, completed.stderr)


def _as_text(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _parse_result(exit_code: int, stdout: str, stderr: str) -> TcodexResult:
    session_id: str | None = None
    messages: list[str] = []
    error_events: list[dict] = []

    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = event.get("type")
        if event_type == "thread.started":
            session_id = event.get("thread_id") or event.get("session_id")
        if event_type in {"error", "turn.failed"}:
            error_events.append(event)
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str):
                messages.append(text)

    return TcodexResult(
        exit_code=exit_code,
        session_id=session_id,
        text=messages[-1] if messages else "",
        stdout=stdout,
        stderr=stderr,
        error_events=error_events,
    )
