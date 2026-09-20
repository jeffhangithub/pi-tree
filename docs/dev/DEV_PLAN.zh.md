# pi-tree 能力分析与开发计划(v2 最终版)

> 分析日期:2026-09-19 · 基线版本:v0.3.3(commit 3cf6ee9)· 仓库:https://github.com/shuowu/pi-tree
> 目标:基于 pi-tree 继续开发 —— **真 PDF 渲染显示论文原文(嵌入开源方案)、划词/划章节提问、回答中追问、理解后返回上一层、AI 回复默认语言用户可选、设置页配置 API Key(默认 DeepSeek)**。
> **第一阶段架构要求(2026-09-20 修订)**:每个提问节点保存**原文锚点(页码 + 文本选区 + 章节)**,点击历史节点同时恢复问答上下文并**跳回 PDF 对应位置**;阅读记录从第一天起采用**可导出的可移植格式**,不绑定 pi-tree 数据库。
> **多源回答要求(2026-09-20 新增)**:针对论文文字/章节的问答,**答案不全部来自论文本身**,由三层构成——①论文内证据(章节/行号)② LLM 原理性解释(标注"通用原理")③外部互联网可信数据源(原理、著作、分析解释,带出处链接);依托 pi-tree 自带 MCP 桥接入,逐句标注来源类别,论文观点与外部解释不混淆。
> **第二阶段**:把"对话树核心 + 原文锚点"拆成独立共享模块,开发 **Zotero 插件**(pi-tree 作为第一版验证平台,不把 Electron 应用硬塞进 Zotero)。见 §5。

> 需求最终确认(2026-09-19):
> 1. **真 PDF 渲染必做**——找开源方案嵌入,不是可选;
> 2. **全站中文界面不做**(已从计划移除);
> 3. **AI 回复默认语言必须用户可选**;
> 4. 设置页填 API Key,默认 DeepSeek,不改 .env。

---

## 0. 结论先行

**pi-tree 非常适合作为这个项目的基础,推荐 fork 后继续开发。** 理由:

1. 你的能力需求中,**追问与返回上一层是原生能力**(树状会话 + 面包屑 + 树导航),**划词提问的基础设施已存在**(SelectionToolbar 支持 Ask/Branch/Define/Memo)。
2. **原文展示有可复用管道**:book 插件已实现"上传 PDF → 转 markdown + toc.json(带行号)→ 面板按章节显示"——paper 插件照此模式升级即可;在此之上加 **pdf.js 真渲染层**(PDF 页面原样显示 + 文本层选择)。
3. 插件体系成熟:全部改动走插件层与表现层,不碰核心,上游合并冲突最小。

**主工作量**:① paper 插件的处理管道(PDF 上传/arXiv 抓取、章节提取、原 PDF 留存与文件服务);② pdf.js 渲染面板(页面渲染 + 文本层 + 选择 → 划词工具栏 + 章节导航)。这两块约 6-8 人天,加上设置页、语言选择与收尾,**主线总计约 10-13.5 人天**。

---

## 1. 项目概况与架构

| 项 | 内容 |
|---|---|
| 语言/规模 | TypeScript,monorepo(npm workspaces),约 5.1 万行,Node ≥ 22;React 19.2 + Vite 8 + TS 6.0 |
| 许可证 | AGPL-3.0(个人使用无影响;对外提供服务需开源) |
| 活跃度 | v0.3.3,2026-07 仍在推送,作者持续迭代 |
| 运行时 | Hono 服务端 + React/Vite 客户端 + Electron 桌面壳;数据存本地文件(~/.local/share/pi-tree)+ SQLite(drizzle) |
| 核心依赖 | **Pi SDK**(npm 包 `pi` / `pi-sdk`)——树状 agent 会话的运行引擎 |

### 包结构

```
packages/
├── client      # React 界面(Reader/Library/Settings/各 Panel + plugin-loader)
├── ui          # 共享聊天 UI(ChatView/MessageBubble/InlineBranches/Breadcrumb/SelectionToolbar)
├── core        # 会话树模型(conversation-tree/tree-nav/pi-session)+ 类型
├── shared      # 共享类型(Source 等)
├── server      # Hono 服务端(路由/DB/agent 编排/job 队列/数据目录)
├── plugin-sdk  # 插件 SDK(工具注册/路由/DiscoverProvider)
├── plugin-book / plugin-news / plugin-paper / plugin-youtube / plugin-mcp  # 4 个内置源插件
├── mcp         # MCP 桥
├── electron    # 桌面应用(实验性)
└── rss-crawler # 独立 RSS 爬虫
```

### 关键机制(与本需求直接相关)

1. **树状会话(Pi SDK)**:每个回答是一个树节点,可在任意节点下开分支;每条分支只携带"根→当前节点"的路径上下文(省 token、抗污染)。`core/tree-nav.ts` 提供 `collectScopeMessages`/`buildBreadcrumb`。
2. **Agentic 而非 RAG**:AI 用工具按行号精确读取原文(`read` 工具 + toc.json 行号导航),不做向量检索。
3. **插件三层扩展**:Skill(Markdown 指令)→ Profile(YAML 会话配置)→ TypeScript 插件(工具 + 路由 + UI 面板)。
4. **插件 UI 体系**:`ClientPlugin` 描述符(contentPanel/addSourceForm/sourceCard/sourcePanels),核心插件静态打进 client bundle,外部插件 IIFE 运行时加载,React/lucide/@pi-tree/ui 通过 `window.__piTreeDeps` 共享。

---

## 2. 已有能力盘点(对照最终需求)

| # | 需求 | 现状 | 结论 |
|---|---|---|---|
| 1 | 真 PDF 渲染显示论文原文 | ❌ 无:paper 插件无上传、无本地原文、无 UI 面板;客户端无任何 PDF 渲染依赖。book 插件只有"PDF→文本"的提取管道,不留原文件 | **必做:嵌入 pdfjs-dist + 自建 paper 管道** |
| 2 | 划词提问 | ✅ 基础设施已存在:`packages/ui/SelectionToolbar.tsx` 支持 **Ask(预填提问)/ Branch(引用原文+开分支)/ Define(查词)/ Save(存 memo)**,已接入聊天区与 book 原文面板;但**未接入 PDF 文本层** | **在 PDF 文本层上接入,小-中工作量** |
| 3 | 划章节提问 | ⚠️ book 面板有"点章节看内容",但无"就此节提问"按钮;`ContentPanelProps.onSendMessage` 钩子已存在 | **paper 面板实现:章节 TOC + 跳页 + 问此节,中工作量** |
| 4 | 回答中继续追问 | ✅ 原生:每条回答都是树节点,InlineBranches 回答下方直接开分支 | **零开发** |
| 5 | 回到上一层继续看 | ✅ 原生:面包屑(Breadcrumb)+ 左侧树导航(TreeView)+ 分支作用域切换 | **零开发** |
| 6 | AI 回复默认语言可选 | ⚠️ 无语言策略:skill 未规定回复语言,全靠模型自觉;无任何语言偏好 UI | **必做:skill 语言策略 + 设置页语言偏好(小工作量)** |
| 7 | 设置页配置 API Key | ⚠️ 只能改 .env(PI_API_KEY 等)或手写 models.json;服务端只有读、**无写接口**;默认模型目前是智谱 glm-5-turbo | **必做:设置页写接口 + 默认 DeepSeek(1.5-2 天)** |

### paper 插件现状明细(升级对象)

- `hasProcessing: false`,无文件上传;添加来源只有 title/author/arxivId 三个表单字段;
- 无 `ui/` 目录(无 ContentPanel);routes.ts 只注册 DiscoverProvider;
- 全文处理在对话期临时抓取(ar5iv HTML 优先 / Jina 兜底),**不落盘、无章节结构、不保留 PDF**;
- book 插件的 pdf-parser 用 `pdf-parse` 提取纯文本,章节切分只有简单的 chapterPattern(对论文章节无效);处理完**不保留原始 PDF**——真渲染方案必须改为保留原文件。

### PDF 渲染开源方案选型(必做,方案已调研)

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. pdfjs-dist(推荐)** | Mozilla 官方 pdf.js 的 npm 包,**Apache-2.0**。Canvas 渲染页面 + 自带 TextLayer(文本层,原生支持选择/复制/搜索)。API 齐全:页面渲染、outline(目录/章节,带跳页目标)、页码、缩放、批注数据 | **首选**:定制能力最强,SelectionToolbar 需要捕获文本层选择,只有直接操作文本层才做得到 |
| B. react-pdf | MIT,react-pdf 封装 pdf.js 的 React 组件;上手快,但其文本层选择定制受组件约束,工具栏/选区映射要 hack | 备选;如时间紧可先渲染后迁移 |
| C. 整包 viewer 嵌入 iframe | pdf.js 自带 web viewer,iframe 嵌入即得完整查看器;但跨 iframe 的选择事件捕获和划词工具栏接入要 postMessage,割裂感强 | 不推荐 |

> 决策:**方案 A**。`pdfjs-dist` 为 Apache-2.0,与本项目 AGPL 兼容;Vite 下 worker 用 `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' })` 加载;大 PDF 需服务端支持 HTTP Range 请求(Hono `serveStatic` 已内置 Range 支持,需确认路由挂载方式)。

---

## 3. 适合继续开发的结论

**适合。** 综合评估:

- ✅ **架构契合**:树状会话正是"追问→返回"交互的第一性实现,不用自己造;
- ✅ **管道可复用**:book 插件的"上传→处理→面板→划词"骨架可整体复制到 paper;
- ✅ **扩展点成熟**:插件 SDK + UI 描述符,paper 升级是纯插件层工作;pdf.js 是前端标准库,嵌入无架构障碍;
- ✅ **模型友好**:DeepSeek/glm/Qwen 中文能力强,自带多 provider 体系;
- ⚠️ **风险 1**:Pi SDK 是外部依赖,树模型/会话引擎在框架层;改动集中在表现层与插件层,风险低,但需锁定 SDK 版本;
- ⚠️ **风险 2**:AGPL-3.0——自己部署用没问题;若对外提供 SaaS 服务必须开源;pdfjs-dist(Apache-2.0)兼容;
- ⚠️ **风险 3**:上游活跃,建议 fork + 定期 rebase;改动尽量不进 core/不硬改共享包,降低合并成本;
- ⚠️ **风险 4**:扫描版 PDF(无文本层)无法划词——方案上以"可选择文本"为准,扫描版提示用户走 OCR 或仅浏览(不留暗坑)。

---

## 4. 开发计划(主线,全部必做)

### Phase 0 — 环境与基线(0.5 天)
- [x] clone 到 SSD:/Volumes/MiniMate1/pi-tree
- [ ] 建开发分支(如 `feat/paper-pdf`),`npm install`,`npm run dev` 跑通(server :3947 / client :5947)
- [ ] 跑 `npm run typecheck` / `npm test` 确认基线绿
- [ ] 配 DeepSeek API key,走通一次 paper reading 会话(截图留档)
- **验收**:dev 环境可用,基线测试通过

### Phase 1 — 设置页配置 API Key(默认 DeepSeek)(1.5-2 天)
> 目标:用户在设置界面填 key/选 provider,不再开 `.env` 或手写 `models.json`。

1. **服务端新增配置写接口**(照 `routes/models.ts` 模式):
   - `GET /api/settings` 返回当前 provider/baseUrl/model 与 **key 掩码**(只回显尾 4 位,如 `sk-…abcd`,永不返回明文);
   - `PUT /api/settings` 写入 `$DATA_PATH/models.json`(providers 结构,含 apiKey/baseUrl/api/models),字段级更新:key 留空=不覆盖;
   - 写入后使 `loadModelsJson()` / `getServerConfig()` 缓存失效,新会话立即生效;进行中的会话提示"重开会话生效";
   - 文件权限 0600,key 只在服务端落盘。
2. **默认 DeepSeek**:
   - `DEFAULT_SERVER_CONFIG` 的 readingModel/lookupModel 改为 DeepSeek 模型(如 `deepseek-v4-flash`);
   - 首次启动时若 `models.json` 不存在,生成含 deepseek provider 的默认模板(apiKey 留空,设置页提示填入);
   - `.env.example` 示例改为 DeepSeek。
3. **客户端 SettingsModal 新增配置区**:Provider 下拉(默认 DeepSeek)+ API Key 输入(password 型,占位显示掩码)+ 可选 Base URL + 保存提示。
4. **安全约束**:日志不打印 key;GET 接口掩码;PUT 响应不含 key。
- **验收**:全新环境仅通过设置页填 DeepSeek key → 新建会话正常问答;界面只显示尾 4 位;重启服务后配置保留。

### Phase 2 — AI 回答策略:语言可选 + 多源回答(1-1.5 天)
1. **skill 语言策略**(基础):`paper-reading/SKILL.md` 增加语言规则——"回答语言遵循用户设置的偏好;用户显式要求其他语言时以用户为准;术语保留英文原文并附中文释义"。
2. **多源回答策略**(新增,写进 SKILL.md):
   - 三层来源:①论文内证据(章节+行号,agentic read 引用)②原理性解释(LLM 知识,注明"[原理]")③外部可信源(经 MCP 工具检索,带 URL/出处);
   - 来源标注格式:`[论文 §3.2 L45]` / `[原理]` / `[arXiv:…]` / `[URL]`;关键论断逐句标注;
   - 可信源白名单:arXiv / Semantic Scholar 优先,百科类标"二手来源",低可信来源不进答案;
   - 禁止把 LLM 推测冒充论文结论。
3. **外部源接入**:启用 pi-tree MCP 桥(`config/mcp.json`),配置 1-2 个可信源——网页搜索(如 Tavily/Brave)与学术库(arXiv/Semantic Scholar);确认 paper profile 的 `extensions: [paper, mcp, memos]` 已包含 mcp,并验证 AI 能调用检索工具。
4. **设置页语言偏好**(必做):SettingsModal 增加"回复语言"选项——**跟随提问 / 中文 / English / 日本語 / Deutsch / Français**(跟随提问为默认),存 `$DATA_PATH/models.json` 或独立 settings,服务端读取后注入会话 systemContext("Always answer in {lang} unless the user explicitly asks otherwise")。
5. **会话内快捷切换**(小):Reader 会话头部下拉同步该偏好(与会话绑定,覆盖全局默认)——几十行 UI,可选但建议做。
6. **模型建议**(文档化):DeepSeek(便宜、中文强)/ glm-5-turbo(双语)/ 本地 Qwen(离线),复用现有 provider 体系,无需开发。
- **验收**:设置"中文"后英文提问也回中文;"跟随提问"下中英各回各语言;提问一个概念,回答同时含论文内引用(带行号)+ 原理性解释 + 至少一个带 URL 的外部来源,且来源类别标注清晰、不与论文观点混淆。

### Phase 3 — paper 结构化管道 + 原 PDF 留存(3-4 天)
1. **sourceType 升级**:`hasProcessing: true`;addSource 增加 **PDF 文件上传** + arXiv URL/ID 字段(保留现有 arxivId)。
2. **服务端处理器**(照 `plugin-book/routes.ts` 的 `jobQueue.registerProcessor` 模式):
   - arXiv 来源:下载**原始 PDF 存档** + 抓 ar5iv HTML(利用其 section 结构)提取正文;
   - 本地上传 PDF:存档原文件(处理完**不删除**);
   - **论文章节提取器**(新写,比 book 的 chapterPattern 更强):编号标题正则 + 常见论文节名(Abstract/Introduction/Related Work/Method/Experiments/Results/Conclusion/References),产出 `{sourceId}/analysis/toc.json`(章节+行号);同时用 pdf.js outline 提取 PDF 内嵌目录(章节→页码映射,供渲染面板跳转);
   - 产出:`{sourceId}/paper.pdf`(原文件)+ `markdown/paper.md`(正文文本)+ `analysis/toc.json` + metadata(arxivId/title/authors/abstract)。
3. **文件服务**:`/api/sources/:id/file` 提供 PDF 下载/流式读取,**支持 HTTP Range**(pdf.js 按需分块加载必需;Hono serveStatic 已内置,注意挂载路径与鉴权一致)。
4. **systemContext + SKILL.md 更新**:注入 toc.json 导航数据,指示 AI 用 `read` 工具按行号引用原文作答。
- **验收**:上传 arXiv PDF 后,原文件留存可下载;toc.json 章节与行号正确;AI 回答能带行号引用;Range 请求返回 206。

### Phase 4 — 真 PDF 渲染面板(必做,3-5 天)
1. **引入 pdfjs-dist(Apache-2.0)**:client 内 `PdfViewerPanel` 组件(放在 plugin-paper/ui,静态打进 bundle,Vite 动态 import 分包);worker 按 Vite 官方姿势加载。
2. **渲染**:canvas 逐页渲染 + pdf.js **TextLayer 文本层**(原版排版、可选择复制、支持高亮);虚拟滚动/分页懒渲染(论文 10-40 页规模,先简单分页+按需渲染,再优化);缩放(适配宽度/固定比例)、页码、连续滚动。
3. **章节导航**:读取 PDF outline(内嵌目录)渲染章节树,点击跳转到对应页;与 Phase 3 的 toc.json 交叉校验。
4. **选择捕获 + 锚点采集**:文本层容器 `mouseup` 捕获选区 → 复用 `SelectionToolbar`(Ask/Branch/Define/Save),选区携带 `{page, text, 章节上下文}` 元数据;**开分支时把锚点写入节点**(见 P5 的数据模型)。
5. **文本层缺失降级**:扫描版 PDF(无文本层)显示提示条("此页无可选择文本"),仍可浏览。
- **验收**:上传的 PDF 在面板中原版排版显示;页面文字可选择;划词弹出工具栏;章节树点击跳页;放大缩小正常;选区锚点(page+quote)采集正确。

### Phase 5 — 划词/划章节提问闭环 + 锚点回跳(2-3 天)
1. PDF 文本层选择 → SelectionToolbar 全功能(Define/Ask/Branch/Save),提问注入引用格式(`> 原文摘录`+ 页码/章节);
2. **章节级提问**:章节树/章节标题旁"就此节提问"按钮 → 组装带引文(章节标题+页码范围+首句摘录)的提问,预填输入框或直接开分支(`ContentPanelProps.onSendMessage`);
3. **节点锚点数据模型**(核心扩展,为 Zotero 第二阶段铺路):
   - 提问节点存储 `anchor: { page, quote, section }`(页码、选中原文、所在章节),与消息并列,不侵入 Pi SDK 树模型;
   - 树视图与历史节点点击 → **恢复该分支问答上下文 + PDF 面板跳转到 anchor.page 并高亮 quote**;
4. **可移植阅读记录导出**:新增 `/api/sessions/:id/reading-record`(或客户端导出)产出与 Zotero 兼容的 JSON:
   ```json
   { "source": "paper.pdf",
     "nodes": [ { "id": "n1", "parentId": null,
                  "question": "…", "answer": "…",
                  "anchor": { "page": 4, "quote": "…", "section": "3.2" } } ] }
   ```
   (Pi SDK 树 ↔ 平铺 nodes 数组双向可映射;Zotero 与 pi-tree 读同一份记录,无需迁移聊天历史);
5. 验证完整闭环:PDF 划词 → 提问(带锚点)→ 回答中追问(InlineBranches)→ 面包屑/树导航返回上层 → 点击历史节点 → **PDF 跳回锚点页并高亮**。
- **验收**:e2e 用例(划词提问 + 章节提问 + 追问 + 返回 + 锚点回跳 + 导出记录)全绿。

### Phase 6 — 收尾与发布(1 天)
1. 全量 typecheck / test / e2e;核心流程走查;
2. Docker 镜像构建验证(如用户走 Docker 部署);
3. 文档:README 中文说明、`DEV_PLAN.zh.md` 归档;
4. 上游同步策略:保持 fork,按季度 rebase;改动边界=插件层 + server 的 paper 处理器/文件路由/settings 写接口 + 客户端 settings/语言偏好/PDF 面板。

### 工作量与顺序

| 阶段 | 内容 | 估时 | 依赖 |
|---|---|---|---|
| P0 | 环境基线 | 0.5 天 | - |
| P1 | 设置页 API Key(默认 DeepSeek) | 1.5-2 天 | P0 |
| P2 | AI 回答策略(语言可选 + 多源回答) | 1-1.5 天 | P0 |
| P3 | paper 管道 + 原 PDF 留存 + 文件服务 | 3-4 天 | P0 |
| P4 | 真 PDF 渲染面板 + 锚点采集 | 3-5 天 | P3 |
| P5 | 划词/划章节提问 + 锚点回跳 + 阅读记录导出 | 2-3 天 | P2+P4 |
| P6 | 收尾发布 | 1 天 | 全部 |

**总计:主线约 11-15.5 人天,全部必做(无可选阶段)。** P1 / P2 / P3 可并行推进;P4 依赖 P3;P5 依赖 P4。

### 待决策点
1. **PDF 渲染方案**:方案 A(pdfjs-dist 自研薄封装,推荐)vs 方案 B(react-pdf)。已倾向 A,开工前最终拍板。
2. **回复语言偏好粒度**:仅全局设置 vs 全局+会话内切换(建议后者,成本 +0.5 天)。
3. **锚点存储位置**:节点 metadata(不侵入 Pi SDK)vs 旁路表(锚点与树分离,导出更易)。建议先 metadata,导出层统一映射。
4. **可信源清单**:MCP 接哪些源(建议 Tavily/Brave 搜索 + arXiv/Semantic Scholar 学术库),是否允许百科(标二手)。开工 P2 前定。
5. **上游策略**:纯 fork 独立演进 vs fork+定期同步。建议后者。
6. **部署形态**:Docker / 源码 / Electron 桌面?影响 P6 验证面,不影响主体开发。

---

## 5. 第二阶段:Zotero 插件设计计划(路线图,不在本期开发)

> 定位:**pi-tree 是第一版验证平台**(验证"对话树 + PDF 原文锚点"的产品逻辑);验证成立后,把**核心能力拆成独立共享模块**,为 Zotero 做一个原生插件。**不是**把 pi-tree 的 Electron 应用转换/塞进 Zotero——两者运行环境不同(Zotero 插件运行在 Zotero 内部,调用其 PDF Reader API 与 JavaScript API)。

### 5.1 分层架构

```text
共享核心层(@paper-chat/core,独立包)
├── 对话树数据模型(节点/父子关系/分支创建/历史与快照)
├── 原文锚点:PDF、页码、文本范围(page + quote + section)
├── LLM 请求与上下文组装(分支路径 = 上下文)
└── 学习记录读写(可移植 JSON 格式,见下)

Pi-tree 适配层(第一阶段)          Zotero 适配层(第二阶段)
├── pi-tree PDF 阅读界面           ├── Zotero PDF Reader(内置阅读器)
├── 左侧 Session Tree              ├── 选中文本与当前页
├── 本地数据库(pi-tree 自有)       ├── 跳转到 PDF 页码/高亮选区
└── Electron UI                    └── Zotero notes / annotations / 插件 SQLite
```

### 5.2 第一阶段如何为第二阶段铺路(已并入 P4/P5)

1. **锚点是第一公民**:每个提问节点存 `anchor: { page, quote, section }`,点击历史节点 → 恢复问答上下文 + 跳回原文位置;
2. **可移植阅读记录格式**(与 Zotero 共享,无需迁移聊天历史):
```json
{
  "source": "paper.pdf",
  "nodes": [
    { "id": "n1", "parentId": null,
      "question": "作者为什么使用这个损失函数?",
      "answer": "…",
      "anchor": { "page": 4, "quote": "…", "section": "3.2" } },
    { "id": "n2", "parentId": "n1",
      "question": "这里的 KL divergence 是什么?",
      "answer": "…",
      "anchor": { "page": 4, "quote": "…", "section": "3.2" } }
  ]
}
```
3. **不把核心数据绑死在 pi-tree 数据库**:Pi SDK 树 ↔ 平铺 nodes 数组双向可映射,导出/导入接口在第一阶段就提供。

### 5.3 Zotero 插件的职责边界(第二阶段开工时细化)

- 从 Zotero 读取当前 PDF、页码与选中文本(Zotero PDF Reader API);
- 展示对话树(渲染核心层的树模型);
- 节点保存到 Zotero note 或插件自有 SQLite;
- 点击节点 → 调用 Zotero Reader API 跳回原文页并高亮;
- 学习总结写回 Zotero 笔记;
- 打包:Zotero 7/8 bootstrapped plugin 结构,`.xpi` 发布,可用社区 TypeScript scaffold(zotero-plugin-scaffold)。

### 5.4 许可边界

- pi-tree 为 **AGPL-3.0**:基于它修改并发布网络服务或衍生版本,须遵守 AGPL 的源码提供义务;
- 共享核心层若**直接复用 pi-tree 代码**,需继续保持 AGPL 并开源;
- 若第二阶段**独立重写**核心模块、只复用接口设计与思路(树模型、锚点格式、交互),许可边界更清晰;
- 建议:第一阶段把核心逻辑尽量收敛成接口清晰的小模块(便于第二阶段"重写 vs 复用"时做选择)。

