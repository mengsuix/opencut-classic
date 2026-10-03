"""独立视觉评委：单独的 LLM 调用（OpenAI SDK 直连 DeepSeek 官方端点），
评判效果图是否达到需求描述的标准，输出 PASS: true/false + 逐条理由。

场景不写死在本模块：验收标准完全由调用方（主 agent）写进 requirement
（1:1 复刻、风格借鉴、特定视觉要求……），评委严格按 requirement 判，
没要求的方面不扣分。

图片经 img-N 句柄传入（editor_bridge 登记）：模型无法复述图片 base64，
句柄是图片字节在 gateway 内存里的名字。
"""

import base64
import io
import logging

from openai import AsyncOpenAI

from . import config

logger = logging.getLogger("agent-gateway.visual_judge")

# 图片进评委前统一压缩的长边上限（与前端 preview.capture 降采样量级一致）
MAX_IMAGE_EDGE = 1568

JUDGE_SYSTEM_PROMPT = """\
你是视觉效果评审，独立评判效果图是否达到需求描述的标准。
输入：需求描述 + 效果图（渲染结果/画布截图），可能有参考图。

# 评判口径
- 严格按需求描述判：需求没要求的方面不扣分，不自行加戏、不扩展验收标准
- 有参考图时，按需求描述定义的参考方式评判：
  要求 1:1 复刻则逐字逐色逐项核对；要求风格借鉴则只核对风格要素的贴近度
  （配色/质感/发光/形状语言/动画气质），内容差异不扣分
- 效果图中透明区域显示为浅色棋盘格，那是透明标记不是底色问题
- 效果图可能是多张：同一对象的不同时间点/不同角度，逐一核对

# 输出协议（严格遵守）
- 第一行：PASS: true 或 PASS: false
- 随后逐条理由：不达标项写清「哪个要素 + 期望 + 实际」；全部达标则一句话总结
"""


def _shrink_image(data: bytes, mime: str) -> tuple[str, str]:
    """图片长边压到 MAX_IMAGE_EDGE 以内，返回 (mime, base64)"""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as opened:
        img = opened.convert("RGBA") if opened.mode == "P" else opened.copy()
    longest = max(img.size)
    if longest > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / longest
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


def _parse_pass(text: str) -> bool:
    """评委输出协议解析：前 5 行内出现 PASS: ... true 视为通过"""
    for line in text.splitlines()[:5]:
        s = line.strip().upper()
        if s.startswith("PASS:"):
            return "TRUE" in s
    return False


async def judge(
    requirement: str,
    result_images: list[tuple[bytes, str]],
    reference_images: list[tuple[bytes, str]] | None = None,
) -> tuple[bool, str]:
    """评判效果图是否达标，返回 (pass, verdict_text)。

    result_images / reference_images: [(图片字节, mime), ...]
    """
    content: list[dict] = []
    for i, (data, mime) in enumerate(reference_images or [], 1):
        shrunk_mime, b64 = _shrink_image(data, mime)
        content.append({"type": "text", "text": f"参考图 {i}："})
        content.append(_image_block(shrunk_mime, b64))
    for i, (data, mime) in enumerate(result_images, 1):
        shrunk_mime, b64 = _shrink_image(data, mime)
        content.append({"type": "text", "text": f"效果图 {i}（评判对象）："})
        content.append(_image_block(shrunk_mime, b64))
    content.append(
        {
            "type": "text",
            "text": f"需求描述（唯一验收标准）：\n{requirement}\n\n按输出协议评判上述效果图。",
        }
    )

    client = AsyncOpenAI(
        base_url=config.JUDGE_BASE_URL,
        api_key=config.JUDGE_API_KEY,
        timeout=300.0,
    )
    try:
        resp = await client.chat.completions.create(
            model=config.JUDGE_MODEL,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            stream=False,
            reasoning_effort=config.JUDGE_REASONING_EFFORT,
            extra_body={"thinking": {"type": "enabled"}},
        )
        # 思考模式下思维链在 message.reasoning_content，只取正式回答
        text = resp.choices[0].message.content or ""
    finally:
        await client.close()

    verdict = text.strip()
    if not verdict:
        raise RuntimeError("评委未返回任何内容")
    return _parse_pass(verdict), verdict
