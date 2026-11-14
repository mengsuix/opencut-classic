"""独立选型裁判：在自定义视觉/转场实施前，评判并推荐实现路径。

与视觉评委一样走单独的 LLM 调用，但不看图片、不评最终画面，也不负责写实现。
主 agent 只提供用户需求与已知约束，不预先拟选路径；裁判独立给出路径与理由。
"""

from openai import AsyncOpenAI

from . import config

ROUTE_PATHS = {"builtin", "html", "code_render", "mask", "add_media", "mixed"}

ROUTE_JUDGE_SYSTEM_PROMPT = """\
你是实现路径选型裁判，根据用户需求独立选择实现路径并给出理由。
输入只有用户需求与已知约束，没有主 agent 的预选方案。你不评估最终画面，不写实现代码。

# 可选路径与能力边界
- builtin：内置特效、内置转场或现成编辑器命令已经能直接表达
- html：timeline.add_html 活 DOM 特效，适合可编辑文字、DOM 排版、CSS/GSAP 动画
- code_render：code_render.apply 实时 Canvas2D，适合像素合成、程序动画、单源 effect，
  以及 inputs=[a,b] 的相邻双画面 transition
- mask：masks.* + 参数关键帧，只负责下一段自身的几何窗口/入场，不负责 A/B 双画面像素合成
- add_media：把 HTML/CSS/视频窗口无头渲染成固定图片或视频素材，文字和动画不再保持活参数
- mixed：确有必要时组合上述路径；必须说明主路径和分工

# 选型原则
- 按任务类型直接选合适后端，不要求每条路径都先试失败一次
- 现成能力优先，其次实时自定义；只有实时路径存在明确能力缺口或实测性能不足，才推荐 add_media
- “效果看起来复杂”“想省事”“想做 3D”本身不是烘焙理由；没有提供的实测数据或失败经历不得臆造
- 自定义 A/B 双画面转场优先 code_render(mode='transition')；HTML 活元素不能直接读取实时 A/B 帧，
  不应作为双画面合成主路径。mask 只适用于不需要 A/B 合成的单侧几何窗口
- 可编辑文字、DOM 排版、CSS/GSAP 动画优先 html；像素合成、程序动画优先 code_render
- Canvas/WebGL/shader 等 DOM 序列化留不住的像素，或用户明确要固定视频/图片素材时，可选 add_media
- 严格按用户需求判，不自行增加视觉要求或把方案升级成更复杂形态

# 输出协议（严格遵守）
- 第一行：PATH: builtin / html / code_render / mask / add_media / mixed（只选一个实际值）
- 第二行起：REASON: 先给结论，再用 2~4 条说明为什么该路径最符合需求
- 推荐 add_media 时，必须列出具体能力缺口、用户明确的素材交付要求或实测性能依据；
  依据不足就改推实时路径
"""


def _parse_path(text: str) -> str:
    for line in text.splitlines()[:5]:
        stripped = line.strip()
        if stripped.upper().startswith("PATH:"):
            path = stripped.split(":", 1)[1].strip().lower()
            if path in ROUTE_PATHS:
                return path
            raise RuntimeError(f"选型裁判返回了未知路径: {path}")
    raise RuntimeError("选型裁判未按协议返回 PATH")


async def judge(requirement: str) -> tuple[str, str]:
    """根据需求独立选型，返回 (推荐路径, 完整理由)。"""
    client = AsyncOpenAI(
        base_url=config.JUDGE_BASE_URL,
        api_key=config.JUDGE_API_KEY,
        timeout=300.0,
    )
    try:
        resp = await client.chat.completions.create(
            model=config.JUDGE_MODEL,
            messages=[
                {"role": "system", "content": ROUTE_JUDGE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"用户需求与约束：\n{requirement}\n\n"
                        "请独立选择实现路径，并按输出协议给出路径与理由。"
                    ),
                },
            ],
            stream=False,
            reasoning_effort=config.JUDGE_REASONING_EFFORT,
            extra_body={"thinking": {"type": "enabled"}},
        )
        text = resp.choices[0].message.content or ""
    finally:
        await client.close()

    verdict = text.strip()
    if not verdict:
        raise RuntimeError("选型裁判未返回任何内容")
    return _parse_path(verdict), verdict
