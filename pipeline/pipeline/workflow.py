from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .tcodex import TcodexClient, TcodexResult
from .validation import validate_stage

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"
SCHEMA_DIR = PIPELINE_DIR / "config" / "schemas"

STAGE_SCHEMAS = {
    "deconstruction": SCHEMA_DIR / "deconstruction.json",
    "judge": SCHEMA_DIR / "judge.json",
    "plan": SCHEMA_DIR / "plan.json",
}
STAGE_DIRS = {
    stage: PIPELINE_DIR / "stages" / stage
    for stage in STAGE_SCHEMAS
}


class StageFailed(RuntimeError):
    pass


def run_selected_plans(
    items: list[dict],
    context: str,
    *,
    source_file: Path,
    max_attempts: int = 3,
    timeout: int = 600,
) -> tuple[list[dict], list[dict]]:
    results: list[dict] = []
    failures: list[dict] = []
    for item in items:
        print(f"\n开始策划：[{item['id']}] {item['title']}")
        try:
            result = run_hotspot(item, context, source_file=source_file, max_attempts=max_attempts, timeout=timeout)
        except StageFailed as exc:
            failures.append({"hotspot_id": item["id"], "title": item["title"], "error": str(exc)})
            print(f"  [FAIL] {exc}")
            continue
        results.append(result)
        print(f"  [ ok ] {item['id']} 策划完成")
    return results, failures


def run_hotspot(
    item: dict,
    context: str,
    *,
    source_file: Path,
    max_attempts: int,
    timeout: int,
) -> dict:
    work_dir = DATA_DIR / "plans" / _safe_name(item["id"])
    work_dir.mkdir(parents=True, exist_ok=True)
    state_path = work_dir / "state.json"
    state = _load_state(state_path, item, source_file)

    deconstruction = _run_stage(
        "deconstruction",
        item,
        context,
        state=state,
        state_path=state_path,
        work_dir=work_dir,
        max_attempts=max_attempts,
        timeout=timeout,
    )
    judge = _run_stage(
        "judge",
        item,
        context,
        previous={"deconstruction": deconstruction},
        state=state,
        state_path=state_path,
        work_dir=work_dir,
        max_attempts=max_attempts,
        timeout=timeout,
    )
    plan = _run_stage(
        "plan",
        item,
        context,
        previous={"deconstruction": deconstruction, "judge": judge},
        state=state,
        state_path=state_path,
        work_dir=work_dir,
        max_attempts=max_attempts,
        timeout=timeout,
    )
    return {
        "hotspot": item,
        "deconstruction": deconstruction,
        "judge": judge,
        "plan": plan,
    }


def _run_stage(
    stage: str,
    item: dict,
    context: str,
    *,
    state: dict,
    state_path: Path,
    work_dir: Path,
    max_attempts: int,
    timeout: int,
    previous: dict | None = None,
) -> dict:
    stage_state = state["stages"][stage]
    stage_dir = STAGE_DIRS[stage]
    expected_cwd = str(stage_dir)
    if stage_state.get("session_id") and stage_state.get("cwd") != expected_cwd:
        stage_state.update({"status": "pending", "session_id": None, "attempt": 0, "last_errors": []})
    stage_state["cwd"] = expected_cwd
    result_path = work_dir / f"{stage}.json"
    if stage_state.get("status") == "succeeded" and result_path.exists():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            errors = validate_stage(stage, result)
        except (OSError, json.JSONDecodeError) as exc:
            errors = [{"path": "$", "code": "invalid_saved_result", "message": str(exc)}]
        if not errors:
            _save_state(state_path, state)
            return result
        stage_state["status"] = "pending"

    session_id = stage_state.get("session_id")
    attempt = int(stage_state.get("attempt", 0))
    if not (stage_dir / "AGENTS.md").is_file():
        raise StageFailed(f"{stage} 阶段缺少 AGENTS.md：{stage_dir / 'AGENTS.md'}")
    client = TcodexClient(cwd=stage_dir, schema_path=STAGE_SCHEMAS[stage], timeout=timeout)

    if max_attempts < 1:
        raise StageFailed(f"{stage} 阶段的 max_attempts 必须大于 0")
    for local_attempt in range(1, max_attempts + 1):
        attempt += 1
        prompt = _build_prompt(stage, item, context, previous, stage_state.get("last_errors"))
        progress = f"本次第 {local_attempt}/{max_attempts} 次，累计第 {attempt} 次"
        print(f"  {stage}：{progress}" + ("（续接同一会话）" if session_id else ""))
        response = client.run(prompt, session_id=session_id, search=stage == "judge")
        if response.session_id:
            if session_id and response.session_id != session_id:
                errors = [{"path": "$", "code": "session_changed", "message": "resume 返回了不同的会话 ID"}]
            else:
                session_id = response.session_id
                errors = _validate_response(stage, response)
        else:
            errors = _response_errors(response)

        _save_attempt(work_dir, stage, attempt, response, errors)
        stage_state.update({"session_id": session_id, "attempt": attempt, "last_errors": errors})
        if not errors:
            result = _parse_response(response)
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            stage_state.update({"status": "succeeded", "last_errors": []})
            _save_state(state_path, state)
            return result

        stage_state["status"] = "retrying" if local_attempt < max_attempts else "failed"
        _save_state(state_path, state)

    raise StageFailed(f"{stage} 阶段失败，已重试 {max_attempts} 次；详情：{work_dir}")


def _build_prompt(stage: str, item: dict, context: str, previous: dict | None, errors: list[dict] | None) -> str:
    payload = {"hotspot": item, "product_context": context}
    if previous:
        payload["previous_stage_results"] = previous
    feedback = ""
    if errors:
        feedback = (
            "\n上一轮输出未通过本地确定性校验。请根据以下错误重新生成完整结果，不能只输出修补片段：\n"
            + json.dumps(errors, ensure_ascii=False, indent=2)
        )
    return (
        f"当前工作目录中的 AGENTS.md 是 {stage} 阶段的唯一角色规则，必须严格遵守。\n"
        "不要修改任何文件，不要执行与任务无关的命令。最终只输出符合阶段 JSON Schema 的一个 JSON 对象，不能输出 Markdown、解释、代码围栏或额外文字。\n"
        f"输入数据：\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n"
        f"{feedback}"
    )


def _validate_response(stage: str, response: TcodexResult) -> list[dict]:
    if response.exit_code != 0:
        return _response_errors(response)
    if not response.text:
        return [{"path": "$", "code": "empty_output", "message": "没有收到最终 Agent 输出"}]
    try:
        value = json.loads(response.text)
    except json.JSONDecodeError as exc:
        return [{"path": "$", "code": "invalid_json", "message": str(exc)}]
    return validate_stage(stage, value)


def _parse_response(response: TcodexResult) -> dict:
    return json.loads(response.text)


def _response_errors(response: TcodexResult) -> list[dict]:
    errors = list(response.error_events)
    if response.stderr:
        errors.append({"type": "stderr", "message": response.stderr[-2000:]})
    if response.exit_code != 0:
        errors.append({"type": "exit_code", "message": f"tcodex 退出码：{response.exit_code}"})
    return errors or [{"type": "unknown", "message": "tcodex 未返回可解析结果"}]


def _save_attempt(work_dir: Path, stage: str, attempt: int, response: TcodexResult, errors: list[dict]) -> None:
    (work_dir / f"{stage}-attempt-{attempt}.raw").write_text(
        response.stdout or response.text or response.stderr, encoding="utf-8"
    )
    (work_dir / f"{stage}-attempt-{attempt}.errors.json").write_text(
        json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _load_state(path: Path, item: dict, source_file: Path) -> dict:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    state.setdefault("hotspot_id", item["id"])
    state.setdefault("source_file", str(source_file))
    state.setdefault("stages", {})
    for stage in STAGE_SCHEMAS:
        state["stages"].setdefault(stage, {"status": "pending", "attempt": 0})
    return state


def _save_state(path: Path, state: dict) -> None:
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    return value.strip("._") or "hotspot"


def save_workflow_summary(results: list[dict], failures: list[dict], source_file: Path) -> Path:
    out_dir = DATA_DIR / "plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    path = out_dir / f"{timestamp}-selected.json"
    path.write_text(
        json.dumps(
            {"createdAt": timestamp, "source": str(source_file), "results": results, "failures": failures},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
