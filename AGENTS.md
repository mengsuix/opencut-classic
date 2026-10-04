# Agents.md

## 测试功能优先使用 bsk（browser-skill）

需要测试、验证功能（尤其是 Web/前端交互）时，优先使用 bsk 在用户已登录的真实浏览器中操作验证，不要只做静态代码审查或凭假设下结论。headless 浏览器（如 agent-browser）中 WebGPU 预览渲染黑屏，UI 验证不可靠，仅可用于无关渲染的 DOM 层检查。

- 基本流程：`bsk session start --json` → `bsk navigate <url> --session <id>` → `bsk observe --session <id>`（取 `@eN` refs）→ `bsk click @eN` / `bsk fill` / `bsk screenshot --session <id>` → `bsk session stop <id>`。
- 打开页面、点击交互、填表、截图确认渲染结果，均通过 bsk 完成。
- 验证结束后必须 `bsk session stop <id>`，不要留下未结束的会话。
