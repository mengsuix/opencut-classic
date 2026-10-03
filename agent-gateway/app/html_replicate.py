"""参考图复刻 HTML 的内层迭代循环（对齐 screenshot-to-code 的 agent 循环形态）。

主 agent 调 replicate_html 工具 → 本模块跑固定结构的迭代（OpenAI SDK 直连
DeepSeek 官方端点，https://api-docs.deepseek.com/zh-cn/api/create-chat-completion）：
参考图固定为首轮基线（不逐轮更新），每轮「模型写/改 HTML → fx_render snapshot
强制渲染 → 渲染图回传对比」，模型自报 STATUS: DONE 收敛，硬上限 REPLICATE_MAX_ROUNDS。
产出 HTML 经 html 句柄回到主 agent，由主 agent 走 add_html 原流程插入并终验。

与 STC 的两点刻意差异：
- 不用 tool_use，改文本协议（首行 STATUS + ```html 代码块，提取逻辑照搬
  STC extract_html_content）——输出协议简单、DeepSeek 指令遵循更稳；
- 渲染由代码每轮强制执行并回传渲染图，不靠模型自觉调截图工具——
  比 STC 的 prompt 约定（always call screenshot_preview）更强的硬保证。

HTML 规范取两个运行时的交集：fx_render 的 HyperFrames 无头渲染（迭代验证用）
与前端 add_html 的 iframe 沙箱（最终落地）——都认 window.__timelines 的 paused
GSAP timeline seek 协议，故统一要求注册 window.__timelines["main"]。
"""

import base64
import io
import logging
import re

from openai import AsyncOpenAI

from . import config, fx_render

logger = logging.getLogger("agent-gateway.html_replicate")

# 参考图进循环前统一压缩的长边上限（Anthropic 视觉推荐口径；DeepSeek 未公布，
# 与前端 preview.capture 的降采样量级一致，够看细节又不爆 token）
REFERENCE_MAX_EDGE = 1568
# 渲染失败回传给模型自愈的最多连续次数
MAX_CONSECUTIVE_RENDER_FAILURES = 2

SYSTEM_PROMPT = """\
你是视频特效复刻引擎。输入是参考图和需求描述，输出一个自包含 HTML 文档——
它将作为特效元素叠加在视频画面上渲染（先经无头渲染器迭代验证，最终进编辑器画布）。

# HTML 规范（两个运行时都要兼容，取交集）
- 完整 HTML 文档，含 <meta charset="utf-8">
- 完全自包含：禁止外部样式表/图片/字体；图标图形用 CSS/SVG 绘制（SVG 可作 data: URI）；
  脚本只允许内联或 HTTPS CDN
- 动画库用 GSAP：<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
- body 第一个子元素为 root，必须带：data-composition-id="main" data-start="0"
  data-duration="<秒>" data-width="<px>" data-height="<px>" data-fps="<fps>"
  （具体数值见每轮任务消息）
- 页面背景透明（除非需求明确要求底色）
- 动画一律注册 paused GSAP timeline：window.__timelines["main"] = gsap.timeline({paused: true})；
  禁 repeat: -1；禁 Math.random()/Date.now() 等非确定性 API（需要随机时用固定种子伪随机函数）；
  即使纯 CSS @keyframes 动画也必须注册该 timeline（可以是空 timeline），
  否则渲染器每轮空等约 45 秒
- 文字用系统字体栈（如 "PingFang SC","Microsoft YaHei",sans-serif），禁止外链字体
- 用户可能需要改文案的文字元素加 data-param="key" 属性并填默认文案

# 复刻方法
- 先逐字读出参考图里的全部文字（含标点与数字格式，如 $224,000 的逗号），复刻后逐字核对，
  不允许凭印象写
- 颜色/渐变/发光/描边/阴影尽量精确取色；看不清的小形状不猜，用最接近的简洁几何形
- 参考图可能包含周边画面（如整个视频帧），只复刻需求描述指定的主体，忽略其余
- 内容画在画布中它应出现的位置（与参考图中的相对位置/占比一致）
- 动态特效：动画在 data-duration 内完成并稳定收场

# 输出协议（严格遵守）
- 第一行固定为 STATUS: ITERATE 或 STATUS: DONE
- ITERATE：随后逐条列 DIFF（与参考图的差异、本轮改了什么），最后输出完整 HTML（```html 围栏）
- DONE：渲染结果与参考图已一致，一句话说明，最后输出最终完整 HTML（```html 围栏）
- 每轮都必须输出完整 HTML；修订时以上一轮为基础只改差异点，其余原样保留
"""


class ReplicateError(RuntimeError):
    """复刻循环失败（无产出 / 渲染连续失败 / API 异常）"""


def extract_html_content(text: str) -> str:
    """从模型输出提取 HTML（照搬 STC codegen/utils.py，去掉 file 标签与裸文本兜底）"""
    # 先剥 markdown 代码围栏
    stripped = re.sub(r"^```html?\s*\n?", "", text, flags=re.MULTILINE)
    stripped = re.sub(r"\n?```\s*$", "", stripped, flags=re.MULTILINE)
    # DOCTYPE + html 标签
    match = re.search(
        r"(<!DOCTYPE\s+html[^>]*>.*?</html>)", stripped, re.DOTALL | re.IGNORECASE
    )
    if match:
        return match.group(1)
    # 仅 html 标签
    match = re.search(r"(<html.*?>.*?</html>)", stripped, re.DOTALL)
    if match:
        return match.group(1)
    return ""


def _parse_done(text: str) -> bool:
    """首行 STATUS 协议解析：前 5 行内出现 STATUS: ... DONE 视为收敛"""
    for line in text.splitlines()[:5]:
        s = line.strip().upper()
        if s.startswith("STATUS:"):
            return "DONE" in s
    return False


def _shrink_reference(data: bytes, mime: str) -> tuple[str, str]:
    """参考图长边压到 REFERENCE_MAX_EDGE 以内，返回 (mime, base64)"""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as opened:
        img = opened.convert("RGBA") if opened.mode == "P" else opened.copy()
    longest = max(img.size)
    if longest > REFERENCE_MAX_EDGE:
        scale = REFERENCE_MAX_EDGE / longest
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.Resampling.LANCZOS,
        )
    if img.mode == "RGBA":
        out_mime, fmt = "image/png", "PNG"
    else:
        img = img.convert("RGB")
        out_mime, fmt = "image/jpeg", "JPEG"
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=90)
    return out_mime, base64.b64encode(buf.getvalue()).decode("ascii")


def _image_block(mime: str, b64_data: str) -> dict:
    """OpenAI/DeepSeek vision 图片块：data URL，detail=high 保留原图细节"""
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64_data}", "detail": "high"},
    }


async def _read_previews(paths: list[str]) -> list[bytes]:
    previews: list[bytes] = []
    for path in paths:
        try:
            with open(path, "rb") as f:
                previews.append(f.read())
        except OSError as e:
            logger.warning(f"读取复刻预览图失败: {e}")
    return previews


async def replicate_html(
    session_id: str,
    reference_images: list[tuple[bytes, str]],
    brief: str,
    *,
    width: int,
    height: int,
    duration: float,
    fps: int,
    animated: bool,
) -> dict:
    """参考图复刻迭代循环，返回 {html, previews, rounds, converged}"""
    client = AsyncOpenAI(
        base_url=config.REPLICATE_BASE_URL,
        api_key=config.REPLICATE_API_KEY,
        timeout=300.0,
    )
    max_rounds = config.REPLICATE_MAX_ROUNDS
    render_format = "frames" if animated else "image"

    first_user: list[dict] = []
    for data, mime in reference_images:
        shrunk_mime, b64 = _shrink_reference(data, mime)
        first_user.append(_image_block(shrunk_mime, b64))
    first_user.append(
        {
            "type": "text",
            "text": (
                f"参考图如上（共 {len(reference_images)} 张，整个迭代期间以此为唯一比对基准）。\n"
                f"需求：{brief}\n"
                f"画布 {width}×{height}，fps {fps}；"
                + (
                    f"动态特效，data-duration {duration} 秒（渲染验证将抽取多个时间点关键帧）。\n"
                    if animated
                    else "静态特效（无动画；仍须注册空的 window.__timelines[\"main\"]）。\n"
                )
                + "按输出协议输出：STATUS: ITERATE + 完整 HTML。"
            ),
        }
    )
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": first_user},
    ]

    html = ""
    previews: list[bytes] = []
    rounds = 0
    converged = False
    render_failures = 0
    try:
        for round_no in range(1, max_rounds + 1):
            rounds = round_no
            resp = await client.chat.completions.create(
                model=config.REPLICATE_MODEL,
                max_tokens=config.REPLICATE_MAX_TOKENS,
                messages=messages,
                stream=False,
                reasoning_effort=config.REPLICATE_REASONING_EFFORT,
                extra_body={"thinking": {"type": "enabled"}},
            )
            # 思考模式下思维链在 message.reasoning_content，只取正式回答
            text = resp.choices[0].message.content or ""
            messages.append({"role": "assistant", "content": text})

            new_html = extract_html_content(text)
            if new_html:
                html = new_html
            if not html:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "未从你的输出中检测到完整 HTML 文档。请按协议重新输出："
                            "首行 STATUS: ITERATE，随后 DIFF，最后 ```html 围栏的完整 HTML。"
                        ),
                    }
                )
                continue

            # 代码强制渲染（不靠模型自觉），渲染图作为下一轮比对材料
            try:
                result = await fx_render.render_fx(
                    session_id, html, format=render_format
                )
            except fx_render.FxRenderError as e:
                render_failures += 1
                if render_failures >= MAX_CONSECUTIVE_RENDER_FAILURES:
                    raise ReplicateError(f"渲染连续失败：{e}") from e
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"HTML 渲染失败：{e}\n修正后重新输出（STATUS: ITERATE + 完整 HTML）。"
                        ),
                    }
                )
                continue
            render_failures = 0
            previews = await _read_previews(
                result.get("previewPaths") or [result.get("previewPath") or ""]
            )

            if _parse_done(text) and round_no > 1:
                converged = True
                break

            round_msg: list[dict] = [
                _image_block("image/png", base64.b64encode(p).decode("ascii"))
                for p in previews
            ]
            round_msg.append(
                {
                    "type": "text",
                    "text": (
                        f"第 {round_no}/{max_rounds} 轮渲染结果如上图"
                        "（透明区域显示为浅色棋盘格，不是参考图）。"
                        "与参考图逐条核对：文字（逐字）、位置占比、颜色渐变、"
                        "发光/描边/阴影、形状细节"
                        + ("、各时间点的动画姿态" if animated else "")
                        + "。完全一致则输出 STATUS: DONE + 最终完整 HTML；"
                        "有差异则 STATUS: ITERATE + DIFF 差异清单 + 修订后的完整 HTML"
                        "（只改差异点，其余保持）。"
                    ),
                }
            )
            messages.append({"role": "user", "content": round_msg})
    finally:
        await client.close()

    if not html:
        raise ReplicateError("复刻循环结束但未产出任何 HTML")
    return {
        "html": html,
        "previews": previews,
        "rounds": rounds,
        "converged": converged,
    }
