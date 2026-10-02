/**
 * Playbook returned by the effects.guide bridge command so agents can pick the
 * right tool: built-in effects and built-in element params first, then
 * timeline.add_html for anything the built-ins can't express. Carries only the
 * knowledge that command descriptions don't: the waterfall policy, the
 * clip-vs-layer choice, element param enums, and the can't-do list.
 */
export const EFFECTS_COMPOSITION_GUIDE = `# 特效实现指南（内置优先，不足走 HTML）

## 原则
1. 先用 effects.list 查内置特效及其参数，能表达就直接用 effects.add / effects.add_layer，不要先写 HTML。
2. 内置特效和元素内置参数（文字样式/动画、转场、变速）都表达不了的自定义视觉，统一走 timeline.add_html（CSS @keyframes 或 GSAP），创作规范以 timeline.add_html 命令描述为准。
3. 做不到就明确告诉用户：Canvas/WebGL 像素级效果、需读取下方画面像素的局部特效（局部马赛克/模糊）、外部 .cube LUT 导入、无绿幕人像抠像、运动跟踪。

## 特效形态：挂素材 vs 特效轨
- 效果属于"这个素材"（抠像/锐化/调色）→ effects.add：跟随素材，只作用于该素材。
- 效果属于"这一段时间的画面"（光效/故障/模糊/老电影/暗角）→ effects.add_layer：独立特效轨，作用于时间窗口内其下方已合成的整幅画面，不跟随素材。
- 判断口诀：效果是"这个素材自带的"就挂载；是"覆盖在这段画面上的氛围"就上特效轨。
- 特效层只作用于 startTime ~ startTime+duration，窗口外不受影响——分段调色/氛围直接 add_layer 限定窗口；风格化调色优先用 filter（style 见 effects.list），别拿 color-adjust 硬凑。
- 关键帧：effects.add 的参数可用 effects.upsert_keyframe 打关键帧；effects.add_layer 的参数暂不支持。

## 元素内置参数速查（无需 HTML）
- 文字样式（timeline.update_elements / timeline.add_text 的 params）：stroke.* 描边、shadow.* 阴影、gradient.* 渐变、background.* 背景框；花字模板 text.list_presets 查看、text.apply_preset 应用
- 文字动画：animIn.type/animOut.type = none|fade|pop|typewriter|fade-chars|pop-chars；animLoop.type = pulse|blink|shake；*.duration 秒
- 元素入场出场（video/image/sticker/graphic）：animIn.type/animOut.type = fade|pop|zoom|slide-up|slide-down|slide-left|slide-right；slide 从画布外滑入/滑出，zoom 放大淡入/淡出
- 元素变换关键帧（keyframes.upsert，propertyPath 合法值）：transform.positionX/positionY、transform.scaleX/scaleY、transform.rotate、opacity；循环类打一个周期后 keyframes.set_loop（首尾关键帧值相等）
- 音频淡入淡出：fadeIn/fadeOut（秒，默认 0 关闭）
- 转场（video 前段 params）：transition.type = none|fade|black|zoom|slide-left|slide-right，transition.duration 0.1~5 秒，作用于同轨道下一个紧邻片段（间隙 ≤1 帧）；内置以外的转场走 timeline.add_html 透明动画叠在切点
- 变速/冻结（video）：timeline.retime_element（rate 0.01~5）；速度曲线 keyframes.upsert 打 propertyPath = retime.sourceTime；timeline.freeze_frame（默认播放头处冻结 3 秒，冻结段静音）

## 自定义 HTML 视觉
- 内置表达不了的视觉统一走 timeline.add_html：本地即时出结果、天然透明、data-param 文字仍可改、html.save_preset 保存复用。
- 验证：插入后用 get_preview_frame 在入场、中间和结束前多时间点截图确认，不能只看单帧。

## 导出前
涉及特效的导出无需特殊处理，效果与预览一致。修改视觉后务必用 get_preview_frame 截图确认。`;
