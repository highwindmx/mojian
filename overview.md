# 墨笺 HTML 加载：页面 CSS 作用域隔离（最终方案）

## 做了什么
在 `src/app.js` 中实现「页面 CSS 选择器前缀改写」，彻底消除「打开外部 HTML 时，页面全局选择器偶尔串味到应用外壳」的极小概率风险——同时保持内联编辑不变、不引入 iframe。

## 关键改动
- 新增 `scopeCss(rawCss)`：临时 `<style>` 挂到 `document.head`，用浏览器原生 CSSOM（`style.sheet.cssRules`）解析后再改写选择器：
  - `STYLE_RULE`：选择器统一加 `#editor ` 前缀（逗号分组分别处理）；
  - 分组型 at-rule（`@media`/`@supports`/`@container`/`@layer`/嵌套）：递归改写内层选择器，外层用 `cssText.slice(0, indexOf("{"))` 原样保留头部；
  - `@import`/`@charset`/`@font-face`/`@keyframes`：保持原样，`@import`/`@charset` 前置到样式表顶部；
  - 解析失败时 `catch` 回退为原样注入（不阻断编辑）。
- 新增辅助 `prefixSelector` / `serializeScopedRule`。
- `injectFileStyle`：先 `scopeCss(css)` 再注入 `#file-style`。
- `src/styles.css` 的 `.editor { contain: paint; }` 保留（双重保险，解决 fixed 弹窗溢出）。

## 决策
- 用户选定「方案 1」：保留内联编辑、消除残留 CSS 串味，不做 iframe 切换。
- 为什么不用「改名 app class」：改名只能挡 ID/类 撞名，挡不住 `body`/`*`/标签选择器；在其上做选择器前缀改写更全面、零改动应用类名。
- 为什么比 `@scope` 稳：上一轮 `@scope` 因无法容纳 `@font-face`/`@keyframes` 导致整段样式失效；CSSOM 改写能正确处理全部顶层规则。

## 验证
- `node --check src/app.js` / `src/pdf.js` 均通过；`@scope` 已从代码清除（仅作对比注释）；`contain: paint` 仍在。
- 待本机 `cargo build --release` 重嵌入 web 资源后实测：打开过去会轻微串味的 HTML，页面样式仍正确、应用外壳（工具栏/菜单）不再受影响；弹窗仍被圈在卡片内。

## 局限 / 下一步
- 原生 CSS 嵌套（`&`）等极新语法若 CSSOM 解析异常，靠 try/catch 回退原样注入。
- 尚未提交：`git add -A` 待验证后执行。
