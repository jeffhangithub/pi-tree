# P4 · paper 插件真 PDF 渲染面板（pdfjs-dist 嵌入）+ 划词/划章节提问 — 实现规格

> 状态：调研完成，待实施
> 范围：只读调研 + 实现前规格。本文所有文件路径、行号均基于当前仓库快照。
> 目标：为 `paper` 源类型新增右侧 contentPanel——用 pdfjs-dist 在浏览器内渲染真实 PDF，支持文本层划词（Define/Ask/Save）与按章节导航/提问。

---

## 0. 结论摘要（TL;DR）

1. **挂载链路是现成的**：`RightPanel` 通过 `getSourceTypeConfig(sourceType).contentPanel` 渲染插件面板，只传 `{ sourceId, onDefine, onSendMessage }` 三个 props。paper 插件只需新建 `packages/plugin-paper/ui/`（`plugin.tsx` + 面板组件）并在 `packages/client/src/pi-tree.config.ts` 里静态注册，与 book/news/youtube 完全同构。
2. **SelectionToolbar 可直接复用**：它监听 `containerRef` 内的 `mouseup`/`selectionchange` 并校验 `container.contains(range.commonAncestorContainer)`。pdfjs 的 DOM 文本层（`.textLayer` 内 span）满足这一条件；book 的 `ContentPanel.tsx` 已有在非聊天 DOM 上复用的先例。需要做一次**向后兼容的最小扩展**：支持可选 `getSelectionMeta` 以提取 PDF 页码/章节元数据，并让回调带出 `meta`。
3. **pdfjs-dist 用 v5.x**（当前 5.5.x，v4 已停止维护）：worker 通过 `?url` 引入 + `GlobalWorkerOptions.workerSrc`；文本层用类式 `TextLayer`（来自 `pdfjs-dist/web/pdf_viewer.mjs`）。核心插件是**静态打包**进 client 的（`pi-tree.config.ts` 静态 import），IIFE 运行时加载（`build-plugin-ui.mjs`/`plugin-loader.ts`）只服务于 `$DATA_PATH/extensions` 外部插件——paper UI 走静态路径即可，**不要给 plugin-paper 加 `piTree.ui`**（否则会和运行时 manifest 双重注册）。
4. **鉴权：无**。客户端 `api.ts` 全部是相对路径 `fetch("/api/...")`，无 token/Authorization；服务端除 CORS 外无 auth 中间件（单用户本地应用）。PDF 端点做成同源 `/api` 端点即可，但**必须支持 HTTP Range**（pdfjs 增量加载）。
5. **章节导航**：`ContentPanelProps` 是固定契约，自定义能力照 book 的 **factory 适配器注入**模式扩展（闭包注入 fetch 回调/配置），主机不感知。PDF 大纲（TOC）直接用 pdfjs 客户端 API `doc.getOutline()` 获取，**无需服务端先解析**。
6. **e2e 可加**：Playwright 自动拉起 aimock(:4010) + API server(:3747, `DATA_PATH=/tmp/pi-tree-e2e`, PI_MOCK) + Vite client(:5747)。测试可把一个小型 PDF fixture 拷进 `/tmp/pi-tree-e2e/sources/{id}/paper.pdf` 再断言文本层 DOM 与工具栏行为。

---

## 1. 现状调研结论（对应六个问题）

### 1.1 contentPanel 挂载链路与注册点

**挂载容器**：`RightPanel`（`packages/client/src/components/RightPanel.tsx`）

- 右侧边栏 `.right-sidebar` 有 4 个 tab：`dict` / `content` / `analysis` / `memos`（`rightTab: "dict" | "content" | "analysis" | "memos"`，第 10 行）。
- `content` tab 仅当 `config.contentPanel` 存在时显示（第 66-74 行，`data-testid="right-tab-content"`，label 用 `config.label`）。
- 面板渲染（第 108-116 行）：

```tsx
<PanelComponent sourceId={sourceId} onDefine={onDefine} onSendMessage={onSendMessage} />
```

**传入 props（固定三项，来自 `ContentPanelProps`）**：

| prop | 来源（Reader.tsx） | 语义 |
|---|---|---|
| `sourceId` | `source.id` | 源 ID |
| `onDefine` | `dict.handleDefine`（Reader 第 468 行） | 查词 → 词典 tab + quick card |
| `onSendMessage` | `session.handleSendMessage`（Reader 第 471 行） | 直接发消息进当前会话（签名 `(message: string, opts?: { forceBranch?: boolean })`，`useReaderSession.ts` 第 408 行） |

**注册链路**（全部现成，无需改动）：

```
plugin factory (paperPlugin())  →  ClientPlugin { sourceType: "paper", contentPanel }
  →  pi-tree.config.ts  defineConfig()  →  appConfig.contentPanels["paper"]
  →  source-types.ts loadSourceTypes(): contentPanel = appConfig.contentPanels[st.key]
  →  getSourceTypeConfig("paper").contentPanel
  →  RightPanel 渲染
```

- 注册点唯一：`packages/client/src/pi-tree.config.ts`（当前静态 import `bookPlugin/newsPlugin/youtubePlugin`，第 11-20 行）。加两行：`import { paperPlugin } from "pi-tree-paper/ui/plugin"` + 数组里 `paperPlugin()`。
- 别名解析：`packages/client/vite.config.ts` 已配置 `resolve.alias: { "pi-tree-paper": packages/plugin-paper }` + `conditions: ["source"]`（第 14-22 行）；`packages/client/tsconfig.app.json` 已配置 `paths: { "pi-tree-paper/*": ["../plugin-paper/*"] }`。**别名已存在，零配置即可 import**。
- `RightPanel` 不需要任何改动——它对 paper 无感知，通用渲染。

### 1.2 SelectionToolbar 复用到 PDF 文本层的可行性

`packages/ui/src/SelectionToolbar.tsx` 关键行为（完整读过）：

- props：`containerRef: RefObject<HTMLElement | null>`（必填）、`onDefine`（必填）、`onAsk/onBranch/onSave`（可选）。`SelectionToolbarProps` 目前**不是导出的**（interface 未 export，第 5-16 行）——扩展时需一并导出。
- 选择捕获：
  - 桌面：`container.addEventListener("mouseup")` → rAF → `showToolbarForSelection()`（第 70-98 行）。
  - 移动：document 级 `selectionchange`，300ms debounce（第 102-123 行）。
  - 校验：文本 `length >= 2 && <= 200`（第 44 行）；`container.contains(range.commonAncestorContainer)`（第 52 行）。
  - 定位：`range.getBoundingClientRect()` + `container.getBoundingClientRect()` + `container.scrollTop`（第 56-67 行）。**前提是 container 本身是滚动容器**。
  - 关闭：document `mousedown`/`touchstart` 点工具栏外部、container `scroll`（第 77-146 行）。
- 回调语义：
  - `handleAsk`：`onAsk(text)` → ChatView 的 `handleAsk` 只是 `setQuotedText(text)` + 聚焦输入框（**预填引用，不发送**，ChatView.tsx 第 520-531 行）。
  - `handleBranch`：`onBranch(text)` → 预填 + `setPendingBranch(true)`。
  - `handleDefine`：从选区向上找 `closest(".pit-chat-content, p, blockquote, li")` 取 ±100 字符窗口做 context（第 150-180 行），再 `onDefine(text, context)`。
  - `handleSave`：同 define 的 context 逻辑，`onSave(text, context)` → Reader 里 `createMemo(...)`。

**对 PDF 文本层的可行性结论**：

- ✅ 可行。pdfjs 的 `TextLayer` 渲染的是真实 DOM（`.textLayer` div + 若干 `span`），`window.getSelection()`、`range.commonAncestorContainer`、`getBoundingClientRect()` 全部正常；把 `containerRef` 指向 PDF 滚动容器（含全部页面 div）即可命中 `container.contains(...)` 校验。
- ✅ book 插件已有先例：`packages/plugin-book/ui/ContentPanel.tsx` 第 177-182 行在 markdown 容器上挂 `<SelectionToolbar containerRef={contentRef} onDefine={onDefine} />`。
- ⚠️ 需要解决的三个点：
  1. **context 提取会退化**：PDF 文本层没有 `.pit-chat-content/p/li`，`closest()` 返回 null → context 为 undefined，Define/Save 丢失上下文。需要一个 PDF 侧的"块级容器"约定（如页面 div 带 `data-page-number`），并通过扩展的 `getSelectionMeta` 提供 context。
  2. **缺页码/章节元数据**：`onAsk(text)` 只有纯文本，无法带出"第 3 页 / 第 2 节"。需要把选区所在页面/章节注入回调。
  3. **containerRef 类型**：`RefObject<HTMLElement | null>` 与 `RefObject<HTMLDivElement | null>` 兼容（ChatView 传入 `messagesContainerRef` 即此类型），PDF 容器用 `HTMLDivElement` 即可。

**扩展方案（向后兼容，详见 §6）**：新增可选 prop `getSelectionMeta?: (range, text, container) => SelectionMeta | undefined`（`{ page?, section?, context? }`），三个回调追加可选第二参 `meta`。现有调用方（Reader、book ContentPanel）一行不改。

### 1.3 pdfjs-dist 在 Vite 8 下的集成要点

仓库构建现状：

- `packages/client/vite.config.ts`：纯 `react()` 插件，**无 worker 配置、无 manualChunks、无静态复制插件**。dev proxy `/api` → `:3947`（可被 `VITE_API_PORT` 覆盖）。
- 客户端构建：`npm run build -w @pi-tree/client` = `tsc -b && vite build && vite build --config vite.viewer.config.ts`。viewer 配置是导出 HTML 的单文件模板（`vite-plugin-singlefile`，`emptyOutDir: false`），**与主构建共存于 dist/，勿动**。
- 仓库中目前**没有任何 `?url` / `new Worker` 用法**，pdfjs 的 worker 集成是全新的。
- 没有任何 package 依赖 pdfjs-dist（`packages/client/package.json` deps 里没有；plugin-book 只有服务端 `pdf-parse`）。

**pdfjs-dist 版本与 API（已核实，v5.x 为当前维护版本）**：

- 版本：`pdfjs-dist@^5.5`（worker 与库**必须同版本**，建议精确锁 `~5.5.x`；v4 已停止维护，且 v4 的 `renderTextLayer()` 函数式 API 已被 v5 的类式 API 取代）。
- Worker：`pdfjs-dist/build/pdf.worker.min.mjs`（ESM worker）。Vite 集成标准写法：

```ts
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl; // 必须在任何 getDocument() 之前
```

- 文本层（v5 类式 API，**不要再给 `page.render()` 传 `textLayer` 参数**）：

```ts
import { TextLayer } from "pdfjs-dist/web/pdf_viewer.mjs";

const textLayer = new TextLayer({
  textContentSource: page.streamTextContent(), // 或 await page.getTextContent()
  container: textLayerDiv,                    // 挂在页面 wrapper div 内
  viewport,                                   // 与 canvas 同一 viewport，保证对齐
});
await textLayer.render();
```

- 渲染生命周期：canvas 用 `page.render({ canvasContext, viewport })` 返回 `RenderTask`；**切页/缩放/卸载前必须 `renderTask.cancel()` 且 textLayer 容器要清空/`textLayer.cancel()`**，否则内存泄漏 + 竞态（React 19 StrictMode 双执行 effect 会放大此问题）。
- 静态资源（字体子集化相关，缺了会导致 Type0 字体/CJK/数学符号渲染缺字）：
  - `getDocument({ cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" })`
  - 这些目录在 `node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}`，需要**复制到 `packages/client/public/pdfjs/`**（新增小脚本，如 `scripts/copy-pdfjs-assets.mjs`，挂到 client 的 dev/build 前置步骤）。v5 的 wasm（OpenJPEG/qcms）缺失时 JPEG2000 图像会渲染失败。
- 构建分块：paper UI 虽被 `pi-tree.config.ts` 静态 import，但**在面板组件内用 `React.lazy(() => import("./PdfViewer"))` + PdfViewer 内才 import pdfjs**，Vite 会自动把 pdfjs-dist（约 1-2MB）+ worker 拆成独立 chunk/asset，不进入首屏 bundle。可选再加 `build.rollupOptions.output.manualChunks` 把 `pdfjs-dist` 单独命名。
- TypeScript：client 的 `tsc -b` 会通过 `pi-tree.config.ts` 的 import 链类型检查 `plugin-paper/ui`（tsconfig.app.json 的 `include: ["src"]` 会追踪外部 import，book/news/youtube 的 ui 目前就是这样被检查的；`types: ["vite/client"]` 已配置，`?url` 导入有类型）。`plugin-paper/tsconfig.json` 目前 `exclude: ["ui"]`——**保持排除**，与 plugin-book 一致，避免双份类型检查。

**与 IIFE 插件 bundle 机制的关系（重要）**：

- 核心插件 UI（book/news/youtube）是**静态 import 进 client bundle** 的：`pi-tree.config.ts` 第 11-13 行直接 `import { bookPlugin } from "pi-tree-book/ui/plugin"`。✅ 确认。
- 另有一套**外部插件运行时加载**机制：`scripts/build-plugin-ui.mjs` 把带 `piTree.ui` 的插件打成 IIFE（React/lucide/@pi-tree/ui 外部化为 `window.__piTreeDeps`），`packages/client/src/plugin-loader.ts` 从 `/api/config/plugins/ui-manifest` 拉取并注入，`main.tsx` 会调用 `loadPluginUI()`。
- 服务端 manifest 过滤条件是**磁盘上存在 `ui/dist/plugin.js`**（`routes/config.ts` 第 71 行 `existsSync`）。当前核心插件仓库里没有 `ui/dist`，所以不会双重注册。
- **结论**：paper UI 走静态路径；**不要在 plugin-paper 的 package.json 里加 `piTree.ui` 字段**（否则跑 `npm run build:plugin-ui` 后 manifest 会把它也列出来，静态 + 运行时双注册同一 `sourceType: "paper"`，且 esbuild IIFE 无法正确处理 pdfjs 的 `?url` worker 与 web worker 运行时加载）。

### 1.4 服务端 PDF 文件访问路径与鉴权

**鉴权现状：无**。

- `packages/client/src/api.ts` 全部是 `fetch("/api/...")`，无 `Authorization`/token/credentials 参数（已 grep 全文件确认）；Vite dev proxy 转发 `/api` → 服务端。
- 服务端 `packages/server/src/app.ts` 只有 `hono/cors` 中间件，**无 auth 中间件**；单用户本地应用（`DATA_PATH` 本地目录）。

**现有文件端点（`packages/server/src/routes/library.ts`）**：

| 端点 | 行为 | Range? |
|---|---|---|
| `GET /api/library/sources/:id/cover` | 整文件 `readFile` → body | ❌ 无 |
| `GET /api/library/sources/:id/content?start&end` | markdown 行区间 | n/a |
| `GET /api/library/sources/:id/headings` | markdown 标题 TOC | n/a |
| `GET /api/library/sources/:id/analysis/:filename` | 文本类文件（json/md/txt） | ❌ 无 |
| `POST /api/library/sources` (上传) | 存 `$DATA_PATH/sources/{id}/original{ext}` | n/a |

**现状缺口**：`original.pdf` 存盘后**没有任何路由对外提供**；全仓库无 Range/206/Accept-Ranges 实现。

**paper 源的特殊性**：`hasProcessing: false`、无文件上传；创建走 `POST /api/library/sources/create`（metadata-only，第 230-353 行），arXiv ID 存在 `metadata.arxivId`（AddSourceModal 通过 `metadataKey` 收集，e2e 里已用 `#add-paper-arxivId` 验证）。即**paper 源本地根本没有 PDF 文件**，PDF 需要：

1. 服务端按 `metadata.arxivId` 从 `https://arxiv.org/pdf/{id}` **代理流式**（并建议落盘缓存到 `sources/{id}/paper.pdf`）；或
2. 直接让浏览器跨域 fetch arXiv——**不推荐**：arXiv 对 `/pdf` 的 CORS 头不可依赖，且绕过代理后无法做 Range 转发与缓存。

**设计**（详见 §5）：新增 `GET /api/paper/pdf/:sourceId`（放 plugin-paper/routes.ts，挂 `/api/paper` 前缀）——优先本地文件（`sources/{id}/paper.pdf` 或 `original.pdf`，支持 Range），否则 arXiv 代理（Range 透传），支持 `Accept-Ranges: bytes` 与 206。同源 `/api` 自动走 Vite proxy，无需任何凭证。若未来加鉴权，Range 转发需透传请求头。

### 1.5 章节导航数据与自定义 props

- `ContentPanelProps`（`packages/ui/src/types.ts` 第 5-9 行）是**固定三字段契约**，主机 RightPanel 只传这三样，不会扩展。自定义能力照 book 模式：**插件 factory 用闭包适配器注入**（`plugin-book/ui/plugin.tsx` 第 34-42 行 `BookContentPanel` 把 `fetchHeadings/fetchContent` 闭包注入纯组件；`ContentPanel.tsx` 第 16-19 行 `BookContentPanelProps extends ContentPanelProps`）。paper 同样：`PaperContentPanel(props) → <PdfPanel {...props} getPdfUrl={...} />`。
- **章节大纲不必走服务端**：pdfjs 提供 `doc.getOutline()`（PDF 内嵌书签 TOC），返回 `{ title, dest }[]`；`dest` 解析 `doc.getDestination(dest)` → `doc.getPageIndex(ref)` 得页码。arXiv PDF 通常自带书签；无书签（扫描版）时回退为纯页码导航 + "每页一个章节"。
- AI 侧章节理解已有 `plugin-paper/skills/paper-reading`（ar5iv HTML 全文 + `read_paper` 工具），不依赖本面板；面板与 AI 之间建议用**章节标题**对齐（标题两边一致），页码仅作 PDF 内导航，不塞进 prompt（PDF 页码 ≠ ar5iv 文本行号）。

### 1.6 e2e 启动方式与断言基础设施

- `playwright.config.ts`：`testDir: "./e2e"`，自动拉起三个服务（`BASE_URL` 设置时跳过）：aimock(`npx -p @copilotkit/aimock llmock -p 4010 -f ./e2e/fixtures --strict`) → API server(`PORT=3747 DATA_PATH=/tmp/pi-tree-e2e npx tsx packages/server/src/index.ts`，`PI_MOCK=true`) → Vite client(`VITE_API_PORT=3747 npx vite --port 5747 --strictPort`，cwd packages/client)。dev 端口 3947/5947 与 e2e 端口 3747/5747 互不冲突。
- `e2e/helpers.ts`：`api.createUser / deleteUser / seedSource`（`POST /api/test/seed-source`，PI_MOCK 专属）/`createSession`/`sendMessage`。seedSource 支持 `type: "paper"`。
- 现无任何测试动过 `right-tab-content`；读者路由为 `/source/{sourceId}?session={sessionId}`（`reading-session.spec.ts` 第 53 行）。
- **PDF 测试的可行路径**：spec 内用 Node `fs` 把 `e2e/fixtures/sample-paper.pdf`（提交一个 1-2KB 的最小两页 PDF）拷到 `/tmp/pi-tree-e2e/sources/{id}/paper.pdf`（测试进程与 server 同机，DATA_PATH 已知）→ seed paper 源 → 打开 reader → 点 content tab → 断言 `.textLayer` 文本、划词工具栏、Define 落词典。文本层是 DOM，**Playwright 可直接断言文本/执行选择**，不依赖 canvas 像素。

---

## 2. 目标架构与组件结构

```
packages/plugin-paper/
├── ui/                              # 新建（client 侧，静态打包）
│   ├── plugin.tsx                   # paperPlugin(): ClientPlugin — factory + 闭包注入 getPdfUrl
│   ├── PdfPanel.tsx                 # 纯组件：状态机（loading/toc+viewer）、TOC 列表、SelectionToolbar 挂载
│   ├── PdfViewer.tsx                # 重型组件：动态 import pdfjs，canvas + TextLayer 渲染、缩放/滚动、页面管理
│   ├── pdfjs.ts                     # 单例封装：GlobalWorkerOptions、getDocument、asset URL 常量
│   └── PdfPanel.css
├── routes.ts                        # 修改：setup() 增加 GET /pdf/:sourceId（Range + arXiv 代理 + 缓存）
└── package.json                     # 修改：+pdfjs-dist 依赖；（不加 piTree.ui！）

packages/ui/src/SelectionToolbar.tsx # 修改：+getSelectionMeta 可选 prop、导出 SelectionToolbarProps/SelectionMeta、回调带 meta
packages/client/src/pi-tree.config.ts# 修改：+import paperPlugin + paperPlugin()
packages/client/vite.config.ts       # 修改（可选）：manualChunks 命名 pdfjs chunk
scripts/copy-pdfjs-assets.mjs        # 新建：node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm} → client/public/pdfjs/
packages/client/package.json         # 修改：dev/build 前置 copy 步骤
e2e/fixtures/sample-paper.pdf        # 新建：最小两页 PDF fixture
e2e/pdf-panel.spec.ts                # 新建：PDF 面板 e2e
```

数据流：

```
PdfPanel(sourceId, onDefine, onSendMessage)
 ├─ GET /api/library/sources/{id}          → metadata.arxivId / hasPdf 等（api.ts 或自带 fetch）
 ├─ getDocument({ url: `/api/paper/pdf/${sourceId}`, cMapUrl... })
 │    └─ 服务端: 本地 paper.pdf（Range）| 代理 arxiv（Range 透传，可选缓存）
 ├─ doc.getOutline()                        → TOC [{title, page}]
 ├─ 逐页 canvas render + TextLayer render   → 文本层 DOM（data-page-number 标注）
 └─ <SelectionToolbar containerRef={viewerRef} onDefine onAsk onSave getSelectionMeta={...} />
      └─ meta = { page, section, context }   → onAsk(text, meta) → 面板组装引用/提问
```

---

## 3. 文件改动清单

### 新建

| 文件 | 职责 |
|---|---|
| `packages/plugin-paper/ui/plugin.tsx` | `paperPlugin(): ClientPlugin`（`sourceType: "paper"`, `contentPanel: PaperContentPanel`）。闭包注入 `getPdfUrl(sourceId)`（返回 `/api/paper/pdf/${sourceId}`）与 `fetchSourceMeta`。 |
| `packages/plugin-paper/ui/PdfPanel.tsx` | 面板外壳：load doc → TOC + 当前章节状态；工具栏回调实现（Ask：`onSendMessage(引用+章节前缀)`；Define/Save：`onDefine`/memo 逻辑按 Reader 的 onSave 模式）；错误/空态。 |
| `packages/plugin-paper/ui/PdfViewer.tsx` | 渲染器：`React.lazy` 目标。管理 doc/page 列表、虚拟滚动（或全量渲染 + 缩放）、canvas/TextLayer 生命周期、`data-page-number` 标注、页面跳转 API（`scrollToPage(n)`）。 |
| `packages/plugin-paper/ui/pdfjs.ts` | worker/asset URL 常量、`GlobalWorkerOptions.workerSrc` 一次性初始化、`loadPdf(url)` 封装（防重复 getDocument）。 |
| `packages/plugin-paper/ui/PdfPanel.css` | 面板样式（TOC 列表、页面容器、工具栏相对定位约束）。 |
| `scripts/copy-pdfjs-assets.mjs` | 复制 `node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}` → `packages/client/public/pdfjs/`（dev/build 前置）。 |
| `e2e/fixtures/sample-paper.pdf` | 最小两页 PDF（可手写 PDF 语法或脚本生成一次后入库），文本含 "Abstract"/"Introduction" 便于断言。 |
| `e2e/pdf-panel.spec.ts` | e2e 用例（见 §8）。 |

### 修改

| 文件 | 改动 |
|---|---|
| `packages/client/src/pi-tree.config.ts` | `import { paperPlugin } from "pi-tree-paper/ui/plugin";` + 数组加 `paperPlugin()`。 |
| `packages/ui/src/SelectionToolbar.tsx` | 见 §6：导出 props 类型；加 `getSelectionMeta`；state 增 `meta`；回调追加可选 `meta` 参数；dismiss 清 meta。 |
| `packages/plugin-paper/routes.ts` | `setup()` 返回 `new Hono()` 上挂 `GET /pdf/:sourceId`（§5）；仍保留 discover provider 注册。 |
| `packages/plugin-paper/package.json` | `dependencies` + `"pdfjs-dist": "~5.5.0"`（+`@types/...` 不需要，pdfjs 自带类型）；**不加 `piTree.ui`**；可补 `"routePrefix": "/api/paper"`（默认即 `/api/paper`，显式更稳）。 |
| `packages/client/package.json` | `dev`/`build` 脚本前置 `node ../../scripts/copy-pdfjs-assets.mjs`（或 postinstall）。 |
| `packages/client/vite.config.ts` | 可选：`build.rollupOptions.output.manualChunks: { pdfjs: ["pdfjs-dist", "pdfjs-dist/web/pdf_viewer.mjs"] }`；`chunkSizeWarningLimit` 调至 ~2000 或忽略警告。 |

### 明确不改

- `RightPanel.tsx`、`types.ts`（ContentPanelProps 不动）、`source-types.ts`、`plugin-loader.ts`、`vite.viewer.config.ts`。
- `packages/plugin-paper/tsconfig.json` 保持 `exclude: ["ui"]`（client 负责类型检查，与 book 一致）。

---

## 4. pdfjs 集成代码要点

```ts
// packages/plugin-paper/ui/pdfjs.ts
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// 模块级一次性初始化（必须先于任何 getDocument）
GlobalWorkerOptions.workerSrc = workerUrl;

export const PDFJS_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
};

const docCache = new Map<string, Promise<PDFDocumentProxy>>();
export function loadPdf(url: string) {
  let p = docCache.get(url);
  if (!p) {
    p = getDocument({ url, ...PDFJS_ASSETS }).promise;
    docCache.set(url, p);
  }
  return p;
}
```

```tsx
// PdfViewer.tsx 核心渲染（v5 类式 TextLayer）
import { TextLayer } from "pdfjs-dist/web/pdf_viewer.mjs";

async function renderPage(doc, pageNo, canvas, textLayerDiv, scale) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;  canvas.height = viewport.height;
  const renderTask = page.render({ canvasContext: canvas.getContext("2d")!, viewport });

  const textLayer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
  return { renderTask, textLayer, viewport };
  // 调用方必须在切页/卸载/缩放前：renderTask.cancel(); textLayer.cancel();
  // React effect cleanup 里统一 cancel + canvas 尺寸重置（StrictMode 双跑安全）
}
```

要点：

1. **worker 一致性**：`pdf.worker.min.mjs` 与 `pdfjs-dist` 主包版本必须一致（同一 npm 版本解析出的两个产物天然一致，锁版本即可）。
2. **`?url` 导入**：dev 下 Vite 直接服务；build 下产出 `dist/assets/pdf.worker-*.mjs` 独立 asset。不要用 `new Worker(new URL(...))` 手动包装——pdfjs 会自己根据 `workerSrc` 以 module worker 方式加载。
3. **懒加载**：`PdfPanel.tsx` 中 `const PdfViewer = React.lazy(() => import("./PdfViewer"))`，首屏不含 pdfjs。
4. **`web/pdf_viewer.mjs` 子路径**：v5 中 `TextLayer` 已从主入口移出；若 TS 解析不到子路径类型，可加 `declare module "pdfjs-dist/web/pdf_viewer.mjs"` 或在 tsconfig paths 映射。
5. **不要复用默认 viewer**（`pdfjs-dist/web/pdf_viewer.mjs` 的 `PDFViewer` 组件全家桶不适合本仓库的窄侧栏）：只取 `TextLayer`/`AnnotationLayer` 原语自绘，尺寸、缩放、页码跳转全自控。
6. **AnnotationLayer 可选项**：v5 同样类式（`new AnnotationLayer({...})` + `annotationStorage`），一期可跳过（链接交互非必需）。
7. **cmaps/wasm 复制脚本**：`fs.cp` 三个目录到 `packages/client/public/pdfjs/`；public 目录内容在 dev 与 build 都由 Vite 原样服务。缺失症状是"Type0 字体缺字 / JPEG2000 图黑块"，排查时先查这里。
8. **分块验证**：`vite build` 后确认 `dist/assets/` 有独立 pdfjs chunk 与 worker asset；`vite preview` 或 e2e 里打开 PDF 面板确认 worker 无 404。

---

## 5. 服务端 `/pdf` 端点设计（Range 支持）

位置：`packages/plugin-paper/routes.ts`（挂载前缀 `/api/paper`，默认 `pkg.piTree?.routePrefix ?? "/api/{name}"`，agent-registry.ts 第 463 行）。

```
GET /api/paper/pdf/:sourceId
```

逻辑：

1. `sourceId` 来自 DB 查询（`ctx.sources` 服务查 source；不存在 → 404），**sourceId 只用作 DB 主键拼接路径**，天然免疫路径穿越（与 library.ts 一致）。
2. 本地文件优先：`join(ctx.dataPath, "sources", sourceId, "paper.pdf")`；若不存在且 source 是上传型（book 的 PDF），回退 `original.pdf`。
3. 本地命中 → **HTTP Range 实现**：
   - 读 `Range: bytes=start-end`（缺省 → 200 全量，`Accept-Ranges: bytes`）。
   - 用 `node:fs` `createReadStream(path, { start, end })` + `Readable.toWeb()` 给 Hono `c.body(stream, 206)`，设置 `Content-Range: bytes start-end/total`、`Content-Length`、`Content-Type: application/pdf`。
4. 本地未命中且 `source.type === "paper"` 且 `metadata.arxivId` → **arXiv 代理**：
   - `fetch("https://arxiv.org/pdf/" + arxivId, { headers: { Range: 原始Range头 ?? "", "User-Agent": "pi-tree/1.0" } })`；
   - 透传状态码/`Content-Type`/`Content-Range`/`Accept-Ranges`，body 直接流式回给客户端；
   - 成功后可选把完整响应落盘到 `sources/{id}/paper.pdf`（后续请求走本地 Range，同时离线可用）；失败（网络/429/404）→ 502/404 + 明确错误信息。
5. 都不满足 → 404 `{ error: "No PDF available for this source" }`。

客户端 pdfjs 侧：`getDocument({ url: `/api/paper/pdf/${sourceId}` })` 默认 `disableRange: false`，会发 Range 探测；服务端支持后自动增量加载。若某天去掉 Range，需回退 `disableRange: true`（整包下载，小论文可接受）。

注意：arXiv 代理是网络依赖，e2e/CI 一律走本地 fixture 路径（`sources/{id}/paper.pdf`），**不测代理分支**；代理分支单测可用注入 fetch 的方式覆盖。

---

## 6. SelectionToolbar 最小扩展（向后兼容）

`packages/ui/src/SelectionToolbar.tsx` 的接口 diff（全部**新增可选**，现有调用方零改动）：

```ts
// 新增导出
export interface SelectionMeta {
  page?: number;          // PDF 页码（1 起）
  section?: string;       // 当前章节标题
  context?: string;       // 覆盖默认的 ±100 字符窗口（PDF 文本层没有 p/li）
}

export interface SelectionToolbarProps {
  onDefine: (text: string, context?: string, meta?: SelectionMeta) => void;
  onAsk?: (text: string, meta?: SelectionMeta) => void;
  onBranch?: (text: string, meta?: SelectionMeta) => void;
  onSave?: (text: string, context?: string, meta?: SelectionMeta) => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /** PDF 等自定义 DOM：从 Range 提取页码/章节/上下文；返回 undefined 走默认逻辑 */
  getSelectionMeta?: (
    range: Range, text: string, container: HTMLElement,
  ) => SelectionMeta | undefined;
}
```

实现要点：

- `showToolbarForSelection` 校验通过后：`const meta = getSelectionMeta?.(range, text, container)`，`setMeta(meta)`；`dismiss()` 时 `setMeta(undefined)`。
- `handleDefine/handleSave`：`context = meta?.context ?? 现有 closest(".pit-chat-content, p, blockquote, li") 逻辑`；调用 `onDefine(text, context, meta)`。
- `handleAsk/handleBranch`：`onAsk?.(text, meta)` 等。
- 兼容性：`(text: string) => void` 可赋给 `(text: string, meta?: SelectionMeta) => void`（少参函数可赋多参目标，TS 结构性检查通过），Reader.tsx 的 `renderSelectionToolbar` 与 book 的用法**不需要改**。

paper 侧的 `getSelectionMeta` 实现（在 PdfPanel.tsx 内）：

```ts
const getSelectionMeta = (range: Range, text: string): SelectionMeta => {
  const node = range.commonAncestorContainer;
  const pageEl = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)
    ?.closest?.("[data-page-number]") as HTMLElement | null;
  const page = pageEl ? Number(pageEl.dataset.pageNumber) : undefined;
  const section = pageEl?.dataset.section ?? undefined;
  // context：所在页文本 ±100 字符窗口（复用 SelectionToolbar 的窗口算法）
  const full = pageEl?.textContent ?? "";
  const idx = full.indexOf(text);
  const context = idx >= 0
    ? full.slice(Math.max(0, idx - 100), idx + text.length + 100).trim()
    : full.slice(0, 200).trim();
  return { page, section, context };
};
```

PdfViewer 的每个页面 wrapper div 渲染时标注：`<div className="pdf-page" data-page-number={n} data-section={sectionTitleForPage(n)}>`（section 映射来自 `doc.getOutline()` 的 `{title, page}` 列表）。

---

## 7. 划词 / 划章节提问交互设计

**划词（SelectionToolbar）**：

- `Ask`（Quote）：`onAsk(text, meta)` → 面板把引用预填进聊天。注意 `ContentPanelProps` 只有 `onSendMessage`（**直接发送**，无"仅预填输入框"的通道——那是 ChatView 内部 `setQuotedText` 能力，未暴露给 contentPanel）。两个选项：
  - 一期（推荐）：Ask = `onSendMessage(组装文本)` 直接发送，如：
    `「{text}」（第 {meta.page} 页 · {meta.section}）——请解释这段。`
  - 二期（可选增强）：给 `ContentPanelProps` 加 `onQuote?: (text, meta) => void`，Reader 侧接 ChatView 的 quotedText 预填链路（改动面大，本期不做，记入 backlog）。
- `Define`：`onDefine(text, meta.context)` → 走现有词典链路，右栏切 dict tab + quick card。
- `Save`：面板内仿 Reader.tsx 第 269-296 行的 `onSave`（`createMemo(userId, { title, content: context ? "> text\n\ncontext" : text, sourceId, origin: "selection" })`）。**注意**：`userId` 不在 ContentPanelProps 里——面板需要自带 `useUser()`？`useUser` 在 `@pi-tree/client`（`UserContext`），插件约定是"不 import @pi-tree/client"。book 面板没有 Save 按钮，paper 一期也可以只提供 Ask/Define；若要 Save，最干净的做法是走 `onSendMessage` 不行……备选：面板内 `fetch("/api/users")` 拿默认用户，或用扩展 props 注入 `currentUserId`（factory 闭包注入，见 §1.5）。**建议一期只做 Ask + Define，Save 记入 backlog**。

**划章节（TOC）**：

- 左侧（面板内）TOC 列表：`doc.getOutline()` → 每项 `{ title, page }`（`dest` 经 `doc.getDestination` + `doc.getPageIndex` 解析；解析失败/无 outline 时回退为"第 N 页"列表，或隐藏 TOC）。
- 点章节 → `viewerRef.scrollToPage(page)` + 高亮当前章节；章节状态写入 `data-section`。
- 每项"问本章节"按钮 → `onSendMessage(\`请讲解章节「${title}」：\`)`。**提示词用章节标题不用页码**——AI 侧的 `read_paper` 走 ar5iv HTML 全文，没有 PDF 页码概念，标题才是稳定对齐键。
- 面板顶部显示当前章节（随滚动更新，节流）。

---

## 8. e2e 测试方案

`e2e/pdf-panel.spec.ts`（骨架）：

```ts
import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { api } from "./helpers";

const PDF_FIXTURE = new URL("./fixtures/sample-paper.pdf", import.meta.url).pathname;
const DATA_PATH = "/tmp/pi-tree-e2e";

test.beforeAll(async ({ request }) => {
  await api(request).createUser("e2e-pdf", "PDF Tester");
  await api(request).seedSource("e2e-paper-pdf", "Test Paper (PDF)", { type: "paper" });
  // 服务端优先读 sources/{id}/paper.pdf
  const dir = `${DATA_PATH}/sources/e2e-paper-pdf`;
  mkdirSync(dir, { recursive: true });
  copyFileSync(PDF_FIXTURE, `${dir}/paper.pdf`);
});

test("PDF panel renders text layer and supports selection actions", async ({ page }) => {
  await page.goto("/source/e2e-paper-pdf?session=..."); // createSession 复用 reading-session 模式
  await page.getByTestId("right-tab-content").click();
  await expect(page.locator(".pdf-page canvas")).toBeVisible();
  await expect(page.locator(".textLayer")).toContainText("Abstract");
  // 划词：text layer 上按像素拖选（或 evaluate 构造 Range + mouseup 冒泡）
  // → expect .pit-selection-toolbar visible → 点 Define → expect 词典 tab 出现条目
});
```

- fixture：`e2e/fixtures/sample-paper.pdf` 最小两页 PDF（首行 `%PDF-1.4`，含 "Abstract"/"Introduction" 文本对象即可，约 1-2KB；用脚本生成一次后固化入库）。
- 断言策略：**文本层是 DOM** → `toContainText` 直接断言；工具栏用 `data-testid`（如加 `pit-selection-toolbar` 类已存在）；Define 落词典沿用现有断言模式。
- 避免网络：PDF 走本地 `paper.pdf` 路径，不触发 arXiv 代理；aimock 负责聊天响应（可断言用户消息气泡，不依赖 AI 内容）。
- worker 回归：dev 模式下 Vite 服务 `pdf.worker.min.mjs`，测试打开面板成功即覆盖 worker 集成。

---

## 9. 实施步骤（建议顺序）

1. **依赖与资产**：plugin-paper 加 `pdfjs-dist@~5.5`；写 `scripts/copy-pdfjs-assets.mjs`；client package.json 的 dev/build 前置 copy；验证 `public/pdfjs/cmaps` 就位。
2. **SelectionToolbar 扩展**（§6）+ 导出类型；跑 `packages/ui` 的 vitest（现有 `__tests__`）与 client 类型检查确保零破坏。
3. **服务端端点**：plugin-paper/routes.ts 加 `GET /pdf/:sourceId`（本地文件 Range 优先，arXiv 代理次之）；`curl -H "Range: bytes=0-99"` 验证 206。
4. **UI 三件套**：`pdfjs.ts` → `PdfViewer.tsx`（canvas+TextLayer，先硬编码本地 URL 调试）→ `PdfPanel.tsx`（TOC + 工具栏接线）。
5. **注册**：pi-tree.config.ts 加 paperPlugin；`vite build` 确认 pdfjs 独立 chunk + worker asset。
6. **手工验收**：dev 起服务，arXiv paper 源打开 content tab：渲染、缩放、翻页、划词 Define/Ask、章节跳转。
7. **e2e**：fixture PDF + `pdf-panel.spec.ts`；`npm run e2e`（或单跑该 spec）。
8. **收尾**：electron 打包产物验证（见风险 5）；更新本文档状态。

---

## 10. 风险点与缓解

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **Bundle 体积**：pdfjs-dist ~1-2MB + worker ~1MB | `React.lazy` + 动态 import 拆 chunk（不进首屏）；manualChunks 命名；只引 TextLayer 不用全家桶 viewer。 |
| 2 | **worker 版本/路径错配**（最常见"PDF 打不开"原因） | 锁定 `~5.5.x` 单版本；`GlobalWorkerOptions.workerSrc` 模块级先置；build 后检查 dist/assets 无 worker 404。 |
| 3 | **IIFE 运行时双注册** | 不给 plugin-paper 加 `piTree.ui`；如未来需要运行时分发，须让 `build-plugin-ui.mjs` 跳过 paper 或外部化 pdfjs（worker 在 IIFE 里无法工作）。 |
| 4 | **arXiv 网络依赖**：CORS/限流/离线 | 全部走同源代理；成功后落盘 `paper.pdf` 缓存；本地文件优先；面板对 404/502 给空态与重试。 |
| 5 | **Electron file:// 下 module worker**：打包后 `assets/pdf.worker-*.mjs` 从 file 协议加载可能被 Chromium 拒绝 | 验收 electron 包；必要时 fallback：`import workerRaw from "...?url"` 转 blob URL 赋 workerSrc，或按平台切 `disableWorker` 等效方案（v5 用 `workerPort`）。 |
| 6 | **文本层与 canvas 对齐偏差**（pdf.js 已知问题，缩放后 span 位移） | canvas 与 TextLayer 使用**同一 viewport**；缩放时整页重渲染并同时 cancel/重建两者；避免对 textLayer 单独 CSS transform。 |
| 7 | **React 19 StrictMode 双执行** → 重复 renderTask | 所有 render 在 effect 内，cleanup 统一 `renderTask.cancel()` + `textLayer.cancel()` + 清空容器；doc 缓存单例防重复 getDocument。 |
| 8 | **无书签 PDF（扫描版）**：`getOutline()` 为 null | 回退"第 N 页"分页导航；`data-section` 置空，提问仅带页码与文本。 |
| 9 | **SelectionToolbar 200 字符上限 / 跨页选择** | 划词场景 200 字符够用；PDF 文本层选择通常不跨页（各页独立 DOM），面板对"无 meta.context 的选区"做整页上下文回退。 |
| 10 | **`?url` 的 TS 类型** | client tsconfig.app.json 已含 `vite/client`；plugin-paper/ui 由 client 程序检查（plugin-paper 自身 tsconfig 排除 ui，同 book）。 |
| 11 | **cmaps/wasm 缺失症状隐蔽**（CJK 缺字、JPX 黑块） | copy 脚本挂进 dev/build 前置；e2e 用带 Type0 字体的 fixture 或至少 smoke 覆盖 cMapUrl 无 404。 |
| 12 | **与 AI 章节上下文错位**：AI 读 ar5iv，用户看 PDF 页码 | 提问锚定章节标题（两侧一致）；页码只做 PDF 内导航，不进 prompt。 |

---

## 11. 附录：关键文件索引

| 文件 | 关键行/内容 |
|---|---|
| `packages/ui/src/SelectionToolbar.tsx` | props 5-16；mouseup 87-98；selectionchange 102-123；定位 56-67；Define context 150-180；Ask/Branch/Save 182-224 |
| `packages/ui/src/types.ts` | `ContentPanelProps` 5-9；`ClientPlugin` 57-70 |
| `packages/ui/src/ChatView.tsx` | `renderSelectionToolbar` 调用 642-647；`handleAsk=setQuotedText+focus` 520-531 |
| `packages/client/src/components/Reader.tsx` | renderSelectionToolbar 257-300；RightPanel props 459-476；onDefine/onSendMessage 468/471 |
| `packages/client/src/components/RightPanel.tsx` | content tab 66-74；PanelComponent 挂载 108-116 |
| `packages/client/src/pi-tree.config.ts` | 静态注册 book/news/youtube 11-20 |
| `packages/client/src/config.ts` | defineConfig/mergeRuntimePlugins |
| `packages/client/src/source-types.ts` | contentPanel 注入 87-116 |
| `packages/client/src/plugin-loader.ts` | 运行时 IIFE 加载（仅外部插件） |
| `packages/client/vite.config.ts` | plugin 别名 + conditions 14-22 |
| `packages/client/vite.viewer.config.ts` | 导出 viewer 单文件（勿动） |
| `packages/client/package.json` | vite 8.0.12；无 pdfjs；`build:viewer` |
| `packages/plugin-book/ui/plugin.tsx` | factory + 闭包注入 fetchHeadings/fetchContent（paper 照抄模式） |
| `packages/plugin-book/ui/ContentPanel.tsx` | SelectionToolbar 非聊天容器复用先例 177-182 |
| `packages/plugin-book/package.json` | `piTree.ui` + routePrefix `/api/book`（paper 反例：不加 ui） |
| `packages/plugin-paper/{package.json,routes.ts,services/arxiv.ts,index.ts,skills/paper-reading}` | paper 现状：metadata-only、ar5iv/Jina 全文、无 UI、无 PDF 存储 |
| `packages/server/src/routes/library.ts` | sources/create 230-353；上传 original{ext} 365-509；cover/analysis 无 Range 84-187 |
| `packages/server/src/routes/config.ts` | ui-manifest 63-93（existsSync 过滤 ui/dist） |
| `packages/server/src/services/agent-registry.ts` | 插件路由前缀 463；corePluginDirs 123 |
| `packages/plugin-sdk/src/types.ts` | `PluginRouteContext` 264-276（dataPath/sources 可用） |
| `playwright.config.ts` | e2e 三服务端口与 PI_MOCK |
| `e2e/helpers.ts` | seedSource/createSession 等 API 助手 |
