# README 截图工具

把真实的 `src/index.html` 装进无头 Edge（mock 掉 Tauri 后端），按固定窗口尺寸截图，用于更新 README 配图。

## 跑法

```bash
node tools/shot/serve.js          # 监听 127.0.0.1:8897
```

另开一个终端截图（`--force-device-scale-factor=2` 出 2 倍图，README 里缩小显示更清晰）：

```bash
"<Edge>/msedge.exe" --headless=new --disable-gpu --no-sandbox \
  --force-device-scale-factor=2 --window-size=1560,964 --hide-scrollbars \
  --virtual-time-budget=9000 --user-data-dir=/tmp/edge-shot \
  --screenshot="docs/images/screenshot-md.png" \
  "http://127.0.0.1:8897/shot.html?md"

# JSON 表格 + 原文对照
... --screenshot="docs/images/screenshot-json.png" "http://127.0.0.1:8897/shot.html?json"
```

- `?md` 打开内置的 Markdown 示例（`MD_SAMPLE`），`?json` 打开 `examples/patient-visits.json`。
- 窗口宽 1560 是**实测的工具栏不换行阈值**，矮一点或窄一点会看到工具栏折行，截出来像排版 bug。
- 出图比例 1560×964 ≈ 1.618（与默认启动窗口的黄金分割一致）。

## 验证窗口尺寸校正（`src/app.js` 的 `restoreWindowSize`）

`?win=WxH` 会伪造"上次记住的窗口尺寸"，把实际 `setSize` 的目标写到 `<html data-winsize>`：

```bash
msedge --headless=new --virtual-time-budget=6000 --dump-dom \
  "http://127.0.0.1:8897/shot.html?md&win=800x600" | grep -o 'data-winsize="[^"]*"'
# data-winsize="971x600"   ← 4:3 被校正为黄金矩形（600 × 1.618）
```

`?win=1440x890` 应原样返回 `1440x890`；不带 `win` 参数时不会有 `data-winsize`（说明走 tauri.conf.json 的默认尺寸）。

## 注意

- 探针不能写 `document.title`：`app.js` 打开文件后会用「文件名 · 墨笺」覆盖它。
- mock 的 `window` 对象要提供 `PhysicalSize` 构造器，否则 `new PhysicalSize(...)` 抛错被 try/catch 吞掉，看起来像"没有校正"。
- 前端改动后无需重新编译即可截图（直接读磁盘上的 `src/`）；只有跑真实 exe 才需要 `cargo build`。
