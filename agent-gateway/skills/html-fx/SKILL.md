---
name: html-fx
description: 写 add_html / add_media 的 HTML 特效前的必读规范——HTML 契约、CSS/GSAP 动画确定性规则、迭代纪律、fx_components 特效库用法。任何要写特效 HTML 的任务先加载本 skill。
---

# HTML 特效写作规范（add_html / add_media 双路通用）

同一份 HTML 可走两条交付路：`timeline.add_html`（编辑器内活元素，文字经 data-param 可编辑；传 name 起可读名，插入即自动存入特效面板「生成特效」区）或 `add_media`（渲染成透明 WebM/PNG，同样进「生成特效」区、不进素材库）。写法和契约完全一致，渲染契约属性（data-composition-id/data-duration 等）由服务端自动补齐，**不用自己写**。

## HTML 契约（必须满足）

- 完整自包含 HTML 文档：`<meta charset="utf-8">`（否则中文乱码），无外部样式表/图片/字体文件
- root 元素（body 内第一个容器）带 `data-width="<px>"` 和 `data-height="<px>"`，即特效的设计像素尺寸（如胶囊 520×139；只有真的铺满画面的特效才用项目画布 1280×720）
  - `add_html` 活特效：声明框就是元素在画布上的像素尺寸——静态会裁掉空白边，动画不裁，所以动画要按特效自身尺寸声明（框装下动画全程、含位移行程），用 transform.positionX/positionY 定位；用画布尺寸会让元素框变成整幅画布
  - `add_media` 渲染素材：产物插入时按画布 contain 缩放，小画布会被放大，所以渲染/评审那一版用项目画布尺寸声明、把同一块特效按目标位置摆进画布坐标
- 页面背景透明（要底板就在 root 内画一个全尺寸子元素）
- 脚本允许内联或 HTTPS CDN（如 GSAP：`https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js`，渲染前服务端会自动替换为本地内联版，不必担心网络）；图片/字体必须 data: 内联（例外：烘焙转场的 `<video>` 素材源，见下文「视频帧源」节）
- 所有 id 全文档唯一

## 动画二选一

**CSS @keyframes**（简单/装饰/循环氛围首选，零 JS 成本）：
- 必须有限循环次数 + `animation-fill-mode: both`（无限 `infinite` 会导致时长推断失败）
- 不用 JS 时用这条；t=0 是入场前状态属正常

**GSAP**（编排/多元素/复杂时序首选）：
- 有且仅有一条 paused timeline：`window.__timelines["main"] = gsap.timeline({ paused: true })`，key 固定 `"main"`
- 构建同步完成；若必须等字体（`document.fonts.ready`），**构建完成后才注册**
- 禁 `repeat: -1`（无限循环）、禁 `Math.random()`/`Date.now()`/`performance.now()`（伪随机用索引派生：`(i * 2654435761) % 1000 / 1000`）
- 禁相对 tween（`x: "+=100"`）；一律 `fromTo` 显式 from 态，保证双向 seek 安全；二次接管同一目标时 `immediateRender: false`

## 动画 craft 规则（违反即出 bug 或闪烁）

- 位移/缩放/旋转只用 GSAP transform 别名：`x`、`y`、`scale`、`rotation`；非空间属性允许 `opacity`/`color`/`backgroundColor`/`borderRadius`；**禁** tween `width`/`height`/`top`/`left`（布局属性动画会闪）
- 居中对齐用 flex 或 `inset`，**不要** CSS `transform: translate(-50%,-50%)` 再用 GSAP 动 `x`/`y`（初始 CSS transform 与同属性 tween 会打架）；初始位置写进 `fromTo`
- 被动画的元素上**不要放 CSS `transition`**（它独立于 seek 插值，截帧必闪）
- 一组 stagger 总时长收敛：`元素数 × stagger ≤ 0.5s`，一批到达读作一个节拍
- 大量同时动画的元素加 `will-change: transform`
- DOM 测量（`getBoundingClientRect` 等）只能在构建期做一次并存常量，禁在 tween 回调里量

## 视频帧源：剪辑窗口烘焙（转场/混剪，走全部帧不抽帧）

需要把素材的一段真实画面嵌进产物时（典型：烘焙转场——把转场点前后的 A 尾段 + B 首段合成一段转场视频），用**声明式 `<video>` 交给框架托管播放**，**不要抽帧嵌 base64**（丢运动连贯性出定格感），**也不要自己脚本 seek/预解码 canvas**（框架托管媒体：渲染时逐帧提取合成，脚本 seek 会被 StaticGuard 判违规且实际出黑屏）：

- **素材窗口段 URL 只能从 `supply_media_window` 拿**（mediaAssets 的 `url` 字段是浏览器本地 blob URL，渲染机无法访问，不要用）：`supply_media_window({ id, start, end, maxWidth? })` 在编辑器浏览器里把素材窗口转码成小 WebM 上传到 gateway，返回渲染机可直接拉取的 URL（窗口已切好，**不要在 URL 上加 #t=**；start/end 是素材自身时间轴秒数，从时间线坐标经元素 timeRange 换算）
- **两个窗口分别调**：A 素材尾段 + B 素材首段各调一次（窗口各 ≤1.5s；80 分钟长视频也只转码这几秒，不下载整段）
- **声明式 video（框架媒体契约）**：
  ```html
  <video src="<窗口段 url>" data-start="0.5" data-duration="1" muted playsinline
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  ```
  - 必须 `muted` + `playsinline`；**绝不加 `crossorigin`**（lint 直接 error 且预览黑屏）；不要加 `preload`
  - 时间：`data-start`（合成时间轴秒）+ `data-duration`；`data-media-start` 是源内偏移（窗口段已切好，通常不用）
  - **禁止** `play()/pause()/currentTime = ...`——框架 owns 播放，脚本碰它会被 StaticGuard 判违规
  - **禁止**「等 loadedmetadata → 逐帧 seek → drawImage 到 canvas 缓存」方案——渲染机由 FFmpeg 逐帧提取真实帧直接合成，页面脚本无需要也不允许参与
- **几何过渡动画**：把 video 放进**不带 `data-start` 的 wrapper**，动画做在 wrapper 上（绝不把 `video data-start` 嵌在带 `data-start` 的祖先里——lint `video_nested_in_timed_element`，实际会错帧消失）：
  ```html
  <div id="wa" style="position:absolute;inset:0;will-change:transform">
    <video src="<A url>" data-start="0" data-duration="1" muted playsinline
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  </div>
  <div id="wb" style="position:absolute;inset:0;will-change:transform">
    <video src="<B url>" data-start="0.5" data-duration="1" muted playsinline
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  </div>
  <script>
  window.__timelines["main"] = gsap.timeline({ paused: true })
    .fromTo("#wa", { scale: 1, x: 0, opacity: 1 }, { scale: 0.55, x: -320, opacity: 0.35, duration: 0.5 }, 0.5)
    .fromTo("#wb", { x: 1280 }, { x: 0, duration: 0.7, ease: "power2.out" }, 0.5);
  </script>
  ```
  （已实测：A 缩小退场 + B 滑入的重叠转场逐帧正确）
- 层级由 CSS 顺序 / z-index 决定（`data-track-index` 只是 Studio 显示轨道，不控制前后层级）
- 产物是**实底**完整画面（非透明特效）：渲染/评审版用项目画布尺寸声明，特效内容按画布坐标摆；插入后盖住底层窗口，窗口结束帧与底层同源同时刻即无缝——**时间线不用 split**，窗口内音频也连续
- A/B 双源：`supply_media_window` 各调一次（同素材两个相邻窗口，或 split 两侧两个素材各一个窗口）

## 迭代纪律

- 先 `add_media` 的 `format:"image"`（静态）或 `format:"frames"`（动画）本地渲染看图，达标后再交付；t=0 与 t==duration 可能是空白帧，抽帧避开
- 每轮只改评委/截图确认出的差异点，不整体重写
- 性能预算：add_html 的动画 HTML 每帧重光栅化——DOM 节点 <1000、文档 <200KB；超了就拆多个元素或改走 add_media

## 特效库 fx_components（先搜再造）

用户点名或需求命中常见视觉（图表、故障、胶片颗粒、闪光扫过、 confetti、终端窗口、地图、徽标弹入等）时，**先调 `fx_components` 搜索**：236 个现成 component 配方（自包含 HTML+CSS+JS 片段，带变量声明与默认值）。

- `query` 搜索返回候选（名称/描述/标签/变量）；`name` 取片段原文
- 用法：把片段的 markup/CSS/JS 揉进你正在写的 HTML，变量值直接写死；文本类变量可映射成 `data-param` 槽位保持可编辑
- 片段若带动画，接线 `window.__timelines["main"]` 契约由你合并时补齐
- 库中的 block 形态（data-composition-src 外部引用）**不可用**——只取 component
