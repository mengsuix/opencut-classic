/**
 * Composition playbook returned by the effects.guide bridge command so agents
 * can self-discover how to build looks from primitives instead of expecting a
 * dedicated effect for everything.
 */
export const EFFECTS_COMPOSITION_GUIDE = `# 特效实现指南（组合优先）

## 原则
1. 先用 effects.list 查内置特效，有就直接 effects.add，不要组合。
2. 内置没有时，用下面的配方组合实现；组合也做不到的（如外部 .cube LUT 导入、无绿幕人像抠像、逐字符动画、运动跟踪），明确告诉用户做不到，不要硬凑。
3. 所有特效参数都能打关键帧（effects.upsert_keyframe），"参数随时间变化"类效果优先用关键帧。蒙版的数值参数同样可打关键帧：用 keyframes.upsert，propertyPath 为 masks.<maskId>.params.<参数名>（如 masks.xxx.params.centerX）。
4. 循环类效果（呼吸/闪烁/抖动等）只需打一个周期的关键帧，然后 keyframes.set_loop 开启循环，关键帧通道会在元素存续期内重复播放；注意首尾关键帧值要相等才能无缝衔接。

## 内置特效速查
- blur 模糊 / color-adjust 调色(brightness/contrast/saturation/temperature) / chroma-key 色度抠像 / channel-shift 通道偏移 / sharpen 锐化 / pixelate 马赛克 / edge-glow 轮廓发光 / glow 外发光 / distort-wave 波浪扭曲 / swirl 漩涡扭曲(angle/radius/centerX/centerY) / noise 噪点 / vignette 暗角
- filter 滤镜（预设风格化调色）：style = film 胶片|teal-orange 青橙|faded 褪色|bw 黑白|warm 暖阳|cool 冷调，intensity 0~1 控制混合强度；风格化需求先用它，别再拿 color-adjust 硬凑

## 组合配方
- 发光/霓虹：优先 effects.add(glow, intensity 1.5~3, radius 20~60, color 按需)；要更炸的光晕可再叠一层 duplicate+blur+screen。
- 抖动：keyframes.upsert 对 transform.positionX/positionY 打一个周期的随机小偏移关键帧，再 keyframes.set_loop 循环。
- 闪烁：opacity 关键帧一个周期（如 1 → 0.3 → 1），再 keyframes.set_loop 循环。
- 呼吸/脉冲：transform.scaleX/scaleY 关键帧一个周期（1 → 1.05 → 1），再 keyframes.set_loop 循环。文字元素可直接用 animLoop.type=pulse/blink/shake，无需关键帧。
- 暗角：effects.add(vignette, amount 0.4~0.7, softness 0.4~0.8)。
- 残影/回声：复制 2~3 份，startTime 依次后移 0.05~0.1s，opacity 递减（0.5/0.3）。
- 卡拉OK变色字幕：duplicate 文字改成高亮色 → masks.add(rectangle) 盖副本 → keyframes.upsert 驱动蒙版中心从左扫到右（propertyPath: masks.<maskId>.params.centerX，值为 0~1 小数，0=左缘 1=右缘）。
- 推近冲击（zoom punch）：transform.scale 从 1.6 到 1 打关键帧，缓动选 pop。
- 故障风：channel-shift(offsetX 6~15) + distort-wave(小幅度) + 可选 pixelate 分块。
- 老电影：color-adjust(saturation -0.6, temperature 0.3, contrast 0.15) + noise(0.2) + opacity 关键帧轻微闪烁。
- 老电视信号干扰：noise + distort-wave(frequency 拉满, amplitude 1~2)。注意这只是行位移+颗粒，不是真正的逐行扫描线（扫描线需要逐行明暗调制，属逐像素算法，组合做不到，别硬凑）。
- 局部特效：特效加在副本元素上，再用 masks 限定区域（蒙版羽化过渡）。
- 色彩罩染：顶层 graphic 纯色矩形（不透明盖住画面），blendMode=overlay/soft-light，opacity 0.1~0.3。暖调用橙、冷调用蓝、褪色用灰。

## 转场（video/image 元素 params，用 timeline.update_elements 设置）
- 内置转场：给前一片段设 transition.type = fade|black|zoom|slide-left|slide-right，transition.duration（秒，0.1~5）。自动作用于同轨道下一个紧邻片段（间隙须 ≤1 帧），无需移动片段。
- fade 叠化 / black 黑场 / zoom 推近 / slide 滑入滑出；转场区前段音频自动淡出。
- 转场只渲染画面重叠，后一片段视频会消耗 trimStart 余量，无余量时定格源首帧。
- 内置类型以外的转场（擦除/旋转/白闪等）才需要手拼：重叠片段 + animIn/animOut 或关键帧。

## 文字样式参数（text 元素 params，用 timeline.update_elements / add_text 设置）
- 描边：stroke.enabled=true, stroke.color, stroke.width
- 阴影：shadow.enabled=true, shadow.color, shadow.blur, shadow.offsetX, shadow.offsetY
- 渐变填充：gradient.enabled=true, gradient.color(第二色), gradient.angle
- 背景框：background.enabled=true, background.color, background.cornerRadius, background.paddingX/Y
- 入场动画：animIn.type = fade|pop|typewriter, animIn.duration（秒）
- 出场动画：animOut.type = fade|pop|typewriter, animOut.duration（秒），作用于元素结束前
- 循环动画：animLoop.type = pulse|blink|shake, animLoop.duration（秒，循环周期），全程生效
- 花字模板：text.list_presets 查看，add_text 传 preset 或 text.apply_preset 应用到已有文字

## 元素动画预设（video/image/sticker/graphic 元素 params，用 timeline.update_elements 设置）
- 入场：animIn.type = fade|pop|zoom|slide-up|slide-down|slide-left|slide-right, animIn.duration（秒）
- 出场：animOut.type 同上, animOut.duration（秒）
- slide 从画布外滑入/滑出；zoom 入场=放大淡入、出场=放大淡出；需要其他运动形式再用关键帧手写

## 音频淡入淡出（audio/video 元素 params，用 timeline.update_elements 设置）
- fadeIn / fadeOut（秒，默认 0 关闭）：线性增益斜坡，播放、波形与导出自动生效

## 导出前
涉及特效的导出无需特殊处理，效果与预览一致。修改视觉后务必 preview.capture 截图确认。`;
