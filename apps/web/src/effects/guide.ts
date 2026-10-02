/**
 * Composition playbook returned by the effects.guide bridge command so agents
 * can self-discover how to build looks from primitives instead of expecting a
 * dedicated effect for everything.
 */
export const EFFECTS_COMPOSITION_GUIDE = `# 特效实现指南（组合优先）

## 原则
1. 先用 effects.list 查内置特效，有就直接 effects.add，不要组合。
2. 内置没有时，用下面的配方组合实现；组合也做不到的（如外部 .cube LUT 导入、无绿幕人像抠像、运动跟踪），明确告诉用户做不到，不要硬凑。
3. 所有特效参数都能打关键帧（effects.upsert_keyframe），"参数随时间变化"类效果优先用关键帧。蒙版的数值参数同样可打关键帧：用 keyframes.upsert，propertyPath 为 masks.<maskId>.params.<参数名>（如 masks.xxx.params.centerX）。
4. 循环类效果（呼吸/闪烁/抖动等）只需打一个周期的关键帧，然后 keyframes.set_loop 开启循环，关键帧通道会在元素存续期内重复播放；注意首尾关键帧值要相等才能无缝衔接。

## 特效形态：挂素材 vs 特效轨（先选对形态）
- 效果属于"这个素材"（抠像/锐化/调色）→ effects.add：跟随素材，只作用于该素材，素材移动/裁剪时自动跟随。
- 效果属于"这一段时间的画面"（光效/故障/模糊/老电影/暗角）→ effects.add_layer：独立特效轨，作用于时间窗口内其下方已合成的整幅画面，不跟随素材（素材挪动后需手动对齐）。
- 判断口诀：效果是"这个素材自带的"就挂载；是"覆盖在这段画面上的氛围"就上特效轨。
- 时间窗口隔离：特效层只作用于 startTime ~ startTime+duration 之间的画面，窗口外的段落完全不受影响。分段调色/分段氛围（"就这两秒要夜景感"）直接 effects.add_layer 限定窗口即可，无需担心染到其他段。

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
- 卡拉OK变色字幕：duplicate 文字改成高亮色 → masks.add(rectangle) 盖副本 → keyframes.upsert 驱动蒙版中心从左扫到右（propertyPath: masks.<maskId>.params.centerX；蒙版坐标以元素中心为原点，-0.5=左缘、0=中心、+0.5=右缘，扫动即 -0.5 → +0.5）。
- 推近冲击（zoom punch）：transform.scale 从 1.6 到 1 打关键帧，缓动选 pop。
- 故障风：channel-shift(offsetX 6~15) + distort-wave(小幅度) + 可选 pixelate 分块。
- 老电影：color-adjust(saturation -0.6, temperature 0.3, contrast 0.15) + noise(0.2) + opacity 关键帧轻微闪烁。
- 老电视信号干扰：noise + distort-wave(frequency 拉满, amplitude 1~2)。注意这只是行位移+颗粒，不是真正的逐行扫描线（扫描线需要逐行明暗调制，属逐像素算法，组合做不到，别硬凑）。
- 局部放大/放大镜：优先用 attention.spotlight 命令（一条命令完成复制、放大、蒙版定位，元素须在播放头可见）；只在需要非矩形/非椭圆蒙版或特殊层叠时才手拼：duplicate → 副本 transform.scaleX/Y 放大 → masks.add 圈出区域 → masks.set_canvas_rect 定位。
- 局部特效（局部马赛克/模糊等）：duplicate 原片段叠到上层 → 副本 effects.add → 副本 masks.add(rectangle) 圈出区域，蒙版外自动透出下层原画面。定位蒙版优先用 masks.set_canvas_rect：传 left/top/right/bottom（画布 0~1 比例、左上原点，与预览截图目测一致），内部自动换算；元素须处于播放头可见帧（先 playback.seek 到目标帧再截图估算）。手动写蒙版参数时注意坐标系：centerX/centerY 是相对元素中心的偏移（0=中心，+0.5=右/下缘，-0.5=左/上缘），width/height 是相对元素宽高的比例（1=铺满）。视频元素默认铺满画布，此时元素坐标≈画布坐标。
- 色彩罩染：先调用 graphics.list 获取合法 definitionId，再用 timeline.insert_element 创建 graphic 纯色矩形；graphic 的 definitionId 必填，不能只传 type。blendMode=overlay/soft-light，opacity 0.1~0.3。暖调用橙、冷调用蓝、褪色用灰。
- 分段调色/氛围（复刻"某一段突然变色"类成片手法的标准做法）：effects.add_layer 限定 startTime/duration 窗口，叠 filter 或 color-adjust。夜景/冷峻=filter(cool, 0.5~0.7) 或 color-adjust(temperature -0.3, brightness -0.1~-0.2)；回忆/暖场=filter(warm)；压抑/黑白=filter(bw)。需要聚焦视线再叠 vignette(0.4~0.6)。

## 转场（video/image 元素 params，用 timeline.update_elements 设置）
- 内置转场：给前一片段设 transition.type = fade|black|zoom|slide-left|slide-right，transition.duration（秒，0.1~5）。自动作用于同轨道下一个紧邻片段（间隙须 ≤1 帧），无需移动片段。
- fade 叠化 / black 黑场 / zoom 推近 / slide 滑入滑出；转场区前段音频自动淡出。
- 转场只渲染画面重叠，后一片段视频会消耗 trimStart 余量，无余量时定格源首帧。
- 内置类型以外的转场（擦除/旋转/白闪等）才需要手拼：重叠片段 + animIn/animOut 或关键帧。
- 单个 clip 内部要出转场效果（成片里常见的光晕/闪白过场）：先用 timeline.split_elements 在转场点切开，再给前段设 transition.type；素材不允许切开时，用 fx_render 渲染一段透明背景的光晕/闪白动画（format:"video"），叠在切点位置（要提亮叠加感可再设 blendMode screen）。

## 文字样式参数（text 元素 params，用 timeline.update_elements / add_text 设置）
- 描边：stroke.enabled=true, stroke.color, stroke.width
- 阴影：shadow.enabled=true, shadow.color, shadow.blur, shadow.offsetX, shadow.offsetY
- 渐变填充：gradient.enabled=true, gradient.color(第二色), gradient.angle
- 背景框：background.enabled=true, background.color, background.cornerRadius, background.paddingX/Y
- 入场动画：animIn.type = fade|pop|typewriter|fade-chars|pop-chars, animIn.duration（秒）；fade-chars/pop-chars 为逐字错帧动画
- 出场动画：animOut.type = fade|pop|typewriter|fade-chars|pop-chars, animOut.duration（秒），作用于元素结束前
- 循环动画：animLoop.type = pulse|blink|shake, animLoop.duration（秒，循环周期），全程生效
- 花字模板：text.list_presets 查看，add_text 传 preset 或 text.apply_preset 应用到已有文字

## 元素动画预设（video/image/sticker/graphic 元素 params，用 timeline.update_elements 设置）
- 入场：animIn.type = fade|pop|zoom|slide-up|slide-down|slide-left|slide-right, animIn.duration（秒）
- 出场：animOut.type 同上, animOut.duration（秒）
- slide 从画布外滑入/滑出；zoom 入场=放大淡入、出场=放大淡出；需要其他运动形式再用关键帧手写

## 变速与冻结（video 元素）
- 恒定变速：timeline.retime_element，rate 0.01~5，maintainPitch 可选。
- 速度曲线（坡度变速/时间重映射）：keyframes.upsert，propertyPath = retime.sourceTime，值为"源时间偏移（秒）"、时间为元素本地时间（秒）。曲线单调增=变速，斜率即速度倍率；值递减=倒放；平台段=定格。默认 bezier 平滑。音频会跟随曲线变速（音高随速度变化）。分割元素时曲线自动正确拆分。删除全部关键帧即恢复恒定 rate。
- 冻结帧：timeline.freeze_frame（默认在播放头位置冻结 3 秒，可传 time/duration），冻结段静音，可拖右缘延长。

## 音频淡入淡出（audio/video 元素 params，用 timeline.update_elements 设置）
- fadeIn / fadeOut（秒，默认 0 关闭）：线性增益斜坡，播放、波形与导出自动生效

## 自定义 HTML 视觉（内置特效和组合配方都表达不了时）
- 默认顺序：先 timeline.add_html 用 HTML 尝试（本地即时出结果、文字仍可改），截图确认不合适再升级 fx_render；add_html 同样支持 JS/GSAP（脚本在沙箱 iframe 内运行、编辑器按时间轴 seek 驱动），只有 Canvas/WebGL/shader/物理粒子等像素级效果（DOM 序列化拿不到像素）才必须直接 fx_render
- add_html：浏览器按时间轴定格栅格化，透明背景，data-param 文字仍可改；通过 html.save_preset 保存源码与参数后可复用。CSS @keyframes 能表达入场、呼吸、扫光、错峰文字、位移/旋转/变形/透明度/滤镜过渡等动画
- 本地动画使用完整自包含 HTML、内联 CSS、有限时长/次数及 animation-fill-mode:both；支持 delay、缓动、多个动画、::before/::after。JS/GSAP 可用：脚本跑在沙箱 iframe（内联或 HTTPS CDN 脚本），注册一个 paused GSAP timeline 到 window.__timelines["main"]（与 fx_render 同约定），编辑器按时间轴 seek 驱动；脚本可运行时生成 DOM（逐字拆分等）。图片/字体限 data: 内联，不依赖定时器/真实时钟/悬停/滚动。动画时间=片段本地时间+trimStart，裁剪/分割后延续而非重播
- 静态 HTML 仍裁掉空白边缘、按内容像素尺寸放置；带 @keyframes 的 HTML 保持固定画布不裁边，用项目 data-width/data-height，并显式设置根容器尺寸和定位，内容在框内摆到目标位置
- fx_render 产物是定型的图/视频，文字不可再编辑（改字需改 HTML 重渲）——用户需要后续改文字的需求必须停在 add_html
- 升级 fx_render：静态像素级复刻用 format:"image"（真实 Chrome 渲染透明 PNG）；动画先 format:"frames" 迭代确认，再 format:"video" 正式渲染（透明 WebM，无需混合模式）；用项目画布尺寸，插入后 1:1 落位
- 本地动画插入后在入场、中间和结束前分别 preview.capture 检查，不能只看单帧确认动画完成

## 导出前
涉及特效的导出无需特殊处理，效果与预览一致。修改视觉后务必 preview.capture 截图确认。`;
