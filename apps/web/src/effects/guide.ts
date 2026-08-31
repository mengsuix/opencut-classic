/**
 * Composition playbook returned by the effects.guide bridge command so agents
 * can self-discover how to build looks from primitives instead of expecting a
 * dedicated effect for everything.
 */
export const EFFECTS_COMPOSITION_GUIDE = `# 特效实现指南（组合优先）

## 原则
1. 先用 effects.list 查内置特效，有就直接 effects.add，不要组合。
2. 内置没有时，用下面的配方组合实现；组合也做不到的（如 LUT 风格滤镜、无绿幕人像抠像、逐字符动画、转场、运动跟踪），明确告诉用户做不到，不要硬凑。
3. 所有特效参数都能打关键帧（effects.upsert_keyframe），"参数随时间变化"类效果优先用关键帧。

## 内置特效速查
- blur 模糊 / color-adjust 调色(brightness/contrast/saturation/temperature) / chroma-key 色度抠像 / channel-shift 通道偏移 / sharpen 锐化 / pixelate 马赛克 / edge-glow 轮廓发光 / distort-wave 波浪扭曲 / noise 噪点

## 组合配方
- 发光/霓虹：duplicate_elements 复制元素 → 下层副本 effects.add(blur, intensity 40~80) → update_elements 设 blendMode=screen。加强版：两层模糊副本，一大一小。
- 抖动：keyframes.upsert 对 transform.positionX/positionY 打多个随机小偏移关键帧。
- 闪烁：opacity 关键帧在 1 和 0.3 之间交替。
- 呼吸/脉冲：transform.scaleX/scaleY 关键帧在 1 和 1.05 之间循环。
- 暗角：顶层加黑色 graphic 矩形 → masks.add(ellipse) → masks.toggle_inverted → masks.update_params feather 50 → update_elements opacity 0.6。
- 残影/回声：复制 2~3 份，startTime 依次后移 0.05~0.1s，opacity 递减（0.5/0.3）。
- 卡拉OK变色字幕：duplicate 文字改成高亮色 → masks.add(rectangle) 盖副本 → 关键帧驱动蒙版 centerX 从左扫到右。
- 推近冲击（zoom punch）：transform.scale 从 1.6 到 1 打关键帧，缓动选 pop。
- 故障风：channel-shift(offsetX 6~15) + distort-wave(小幅度) + 可选 pixelate 分块。
- 老电影：color-adjust(saturation -0.6, temperature 0.3, contrast 0.15) + noise(0.2) + opacity 关键帧轻微闪烁。
- 老电视扫描线：noise + distort-wave(frequency 拉满, amplitude 1~2)。
- 局部特效：特效加在副本元素上，再用 masks 限定区域（蒙版羽化过渡）。
- 色彩罩染：顶层 graphic 纯色矩形（不透明盖住画面），blendMode=overlay/soft-light，opacity 0.1~0.3。暖调用橙、冷调用蓝、褪色用灰。

## 文字样式参数（text 元素 params，用 timeline.update_elements / add_text 设置）
- 描边：stroke.enabled=true, stroke.color, stroke.width
- 阴影：shadow.enabled=true, shadow.color, shadow.blur, shadow.offsetX, shadow.offsetY
- 渐变填充：gradient.enabled=true, gradient.color(第二色), gradient.angle
- 背景框：background.enabled=true, background.color, background.cornerRadius, background.paddingX/Y
- 入场动画：animIn.type = fade|pop|typewriter, animIn.duration（秒）
- 花字模板：text.list_presets 查看，add_text 传 preset 或 text.apply_preset 应用到已有文字

## 导出前
涉及特效的导出无需特殊处理，效果与预览一致。修改视觉后务必 preview.capture 截图确认。`;
