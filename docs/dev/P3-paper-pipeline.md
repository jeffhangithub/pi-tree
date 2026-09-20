# P3 — Paper 结构化管道实现规格(实现前调研)

> 调研日期:2026-09 · 基线:v0.3.3(commit 3cf6ee9)· 只读代码分析结果
> 目标:paper 插件获得与 book 同级的处理管道 —— PDF 上传 / arXiv 抓取、章节提取(toc.json)、保留原始 PDF、文件服务(支持 HTTP Range)。
> 后续依赖:本规格是 P4(真 PDF 渲染面板,`pdfjs-dist`)与 P5(划词/划章节提问)的前置。

---

## 0. 结论速览(调研问题的直接答案)

| # | 问题 | 结论 |
|---|------|------|
| 1 | book 管道完整阶段 | 上传→DB(pending)→`jobQueue.enqueue`→插件 `registerProcessor("book")` 执行 Phase1 确定性解析(转 md + toc.json + cover)→Phase2 agentic(outline.md/summary.md,可失败)→队列层通用概念提取(concepts.json)→completed。paper 照抄此骨架,注册 `"paper"` 处理器 + manifest `hasProcessing: true`。 |
| 2 | 上传入口与保存路径 | `POST /api/library/sources`(multipart),存 `$DATA_PATH/sources/{sourceId}/original{ext}`(如 `original.pdf`);`sourceId` = slugify(`title-author-year`)+ 冲突数字后缀。**处理完成后原始文件不会被删除**(现有代码没有任何删除 `original.*` 的路径;DEV_PLAN 第 78 行"不保留原始 PDF"的说法与当前代码不符,已过时)。 |
| 3 | ar5iv 抓取 | `plugin-paper/services/arxiv.ts`:`AR5IV_BASE=https://ar5iv.labs.arxiv.org/html`,`readPaper()` 直连 ar5iv 并 `html2text()`(h1-h6→# 标题)。**可直接复用其 HTML→标题结构**;但注意 120k 截断与旧式 arXiv ID 正则盲区,建议为管道新写 `fetchPaperMarkdown()`。 |
| 4 | 章节提取 | 新写 `services/sections.ts`:编号标题正则(`3.1`/`3 Method`)+ 常见节名(Abstract/Introduction/…/References)+ `pdf-parse@2.4.5` 的 `getInfo().outline`(PDF 内嵌目录,带 dest 页码)。toc.json 必须保持 book 的**扁平数组** `[{line,level,title}]`(server `loadTocJson` 只认这个形状),可加可选 `page` 字段。 |
| 5 | 原 PDF 留存改动点 | 无删除代码需要改 —— 只需"不引入删除":arXiv 下载直接写 `{sourceDir}/paper.pdf`;处理器不 unlink `original.pdf`;唯一全量删除在 `DELETE /api/library/sources/:sourceId`(整目录,合理,保留)。 |
| 6 | 文件服务现状 | `@hono/node-server@1.19.14` 的 `serveStatic` **已内置完整 Range 支持**(Accept-Ranges / Content-Range / 206 / `createReadStream({start,end})`,见 node_modules dist/serve-static.js:147-169),目前只在生产静态资源回退使用。paper 加 `GET /api/paper/sources/:sourceId/file` 即可。**全站当前没有任何鉴权中间件**(app.ts 仅 logger+cors),内容路由(如 `/api/library/sources/:id/content`)全部无鉴权 —— 插件路由照此模型,只做 sourceId 校验防目录穿越。 |
| 7 | 上传大小限制 | **没有任何大小限制**:server 无 `bodyLimit` 中间件、`DEFAULT_SERVER_CONFIG` 无上传字段、客户端也不限制;`@hono/node-server` 把整个 multipart body 读进内存(`Buffer.from(await file.arrayBuffer())`)。实际上限=内存。建议后续加固(可选)。 |

---

## 1. Book 处理管道完整解剖(paper 的参照物)

### 1.1 触发链路(上传)

`packages/server/src/routes/library.ts` `POST /sources`(L365-509):

1. `c.req.parseBody()` 取 multipart 字段:`file`(File 对象)、`title`(必填)、`author`(必填)、`year`(可选)、`type`(可选,**缺省默认 `"book"`** L388-390)。
2. `validateUploadedFile(ext, buffer)`(L47-62):`.pdf` 仅校验前 1024 字节含 `%PDF-`;`.epub` 校验 ZIP EOCD。
3. 生成 `sourceId`:slugify(`title-author-year`),与 DB 冲突则加数字后缀(L401-414)。
4. `mkdir $DATA_PATH/sources/{sourceId}` → `writeFile(original{ext})`(L416-422)。**`.md` 特例**:直接写 `markdown/content.md` 并置 status=`ready`,不排队。
5. 其他类型:DB 行 `status: "pending"`,然后 `await jobQueue.enqueue(sourceId)`(L483-486)—— enqueue 只登记 job,处理异步跑。
6. 返回 `{ id, progress: 0, status: "pending", … }`(201)。

> **对 paper 的关键含义**:上传链路完全通用,`type=paper` 的 multipart 上传今天就能落库成 `original.pdf` + pending;缺的只是"paper 处理器"与"客户端能发 type=paper 的上传表单"(见 §3.3、§8)。

### 1.2 Job 队列(`packages/server/src/services/job-queue.ts`)

- `registerProcessor(sourceType, processor)`(L61):插件启动时注册;processor 签名 `(sourceId, onProgress?, options?) => Promise<void>`,`options.force` = 全量重跑。
- `enqueue(sourceId, options?)`(L72-105):
  - 同 source 已有 pending/processing job 则直接返回现有 job(防重);
  - `sources.get(sourceId)` 取 `source.type` → `processors.get(type)` 找处理器;
  - **无处理器但 `concepts: true` 的类型**走 `runConceptOnlyJob`(只做概念提取)—— 这就是 paper 今天的现状;
  - 找到处理器则 `runJob`(异步,不 await)。
- `runJob`(L107-137):status=processing → `processor(...)`;进度回调里 **插件进度被 `Math.min(progress, 85)` 封顶**(L115),给后处理留空间;处理器返回后,若类型在 `conceptsEnabledTypes`(由 manifest `concepts: true` 触发,bootstrap.ts L188-192),`runConceptExtraction` 把 progress 置 90 并调 `agentTask.run({mode:"concept-extraction"})` 写 `analysis/concepts.json`(失败不致命);最后 status=completed、progress=100。处理器抛错 → status=failed + `sources.update(status:"failed")`。
- Jobs API(`packages/server/src/routes/jobs.ts`):`GET /api/jobs`、`GET /api/jobs/:sourceId`、`POST /api/jobs/:sourceId/process?force=true`(手动重跑)。

### 1.3 Book 处理器(`packages/plugin-book/routes.ts` L11-62)

`setup(ctx)` 里 `ctx.jobQueue.registerProcessor("book", …)`:

1. **force**:删除 `analysis/outline.md`、`analysis/summary.md` 缓存(L15-23)。
2. **Phase 1(确定性)**:`onProgress("converting", 10)` → `processBook()`(`services/process-book.ts`):
   - 幂等:若 `markdown/` 已有 .md 则直接置 ready 返回(L140-156);
   - `findOriginalFile()`:找 `original.*`(L19-34);
   - `getParser("file"+ext)` → `parser.parse()`(epub/mobi/pdf);
   - 写 `markdown/{sourceId}.md`(L183-185)、封面 `cover{ext}`(L188-191);
   - `extractHeadings(md)`(L40-102:md 标题 `#{1,6}`、`Chapter N`、`N.M`、Introduction/Conclusion/Summary/References)→ 写 **`analysis/toc.json` = 扁平数组 `[{line, level, title}]`**(L195-200);
   - `sources.update({status:"ready", title, author, year, error:null})`(L205-211)。
3. **Phase 2(agentic)**:若 `analysis/outline.md` 不存在 → `onProgress("analyzing", 50)` → `ctx.agentTask.run({sourceId, mode:"analysis", message})` 指示 AI 基于 toc.json 读各章开头,写 `analysis/outline.md` + `analysis/summary.md`;**失败不致命**(L37-57)。
4. Phase 3 概念提取由队列层统一做(注释 L60-61)。

`ctx`(`PluginRouteContext`,plugin-sdk/src/types.ts L264-291)可用服务:`dataPath`、`sources`、`jobQueue`(registerProcessor/enqueue/enableConcepts)、`agentTask`、`config.jinaApiKey` 等;bootstrap.ts L196-231 组装后 `app.route(prefix, result.routes)` 挂载插件 Hono 子应用。

### 1.4 Paper 照抄清单(改动点)

| book 中的元素 | paper 对应 |
|---|---|
| `registerProcessor("book")` | `registerProcessor("paper")`(在 plugin-paper/routes.ts) |
| manifest `hasProcessing: true` | paper package.json 打开(现为 `false`) |
| `findOriginalFile` → `original.pdf` | 同;arXiv 来源则下载到 `paper.pdf`(见 §5) |
| `getParser("file.pdf")` | 直接复用 `plugin-book/parsers/pdf-parser.ts` 的 `PdfParser`(pdf-parse),或 paper 内拷贝一份并增强(章节/页码提取) |
| 写 `markdown/{sourceId}.md` | 写 `markdown/paper.md`(`LibraryService.readContent` 只找第一个 .md,文件名自由) |
| `extractHeadings` → `analysis/toc.json` | 新 `extractPaperSections` → 同路径同格式(§4) |
| agentic outline/summary | 可选:paper 默认跳过 Phase2(论文 toc 已足够),仅当需要摘要时复用 agentTask;写 summary.md 还能让概念提取走 outline/summary 优先分支(job-queue L216-222) |
| 概念提取 | 免费获得(paper manifest 已有 `concepts: true`;但 job-queue L235-241 对 paper 的提取指令目前让 AI 调 `read_paper` 工具,管道落地后应改为"读 markdown/paper.md + toc.json",见 §8.7) |

---

## 2. 文件上传:入口路由、保存路径、命名、删除行为

- **入口**:`POST /api/library/sources`(server/src/routes/library.ts L365-509),multipart 字段 `file/title/author/year/type`。客户端 book 走插件自带表单(`plugin-book/ui/BookAddSourceForm.tsx`,post 到该端点,**不传 type,靠服务端默认 "book"**);元数据-only 来源走 `POST /api/library/sources/create`(L231-353,JSON,不触发处理)。
- **保存路径与命名**:`$DATA_PATH/sources/{sourceId}/original{ext}` → PDF 即 `original.pdf`;`.md` 例外直接进 `markdown/content.md`。
- **处理完成后是否删除**:**否**。全仓库对 `original.*` 没有任何 unlink/rm 路径(grep 证实;仅有三处删除:force 重跑删 analysis 缓存、`DELETE /api/library/sources/:sourceId` 删整目录(L577-579)、概念 force 删 concepts.json)。book 管道今天已经保留原文件;DEV_PLAN.md L78"处理完不保留原始 PDF"与当前代码不符,**应以代码为准**。
- **paper 上传链路的缺口**:`packages/client/src/api.ts` 的 `uploadSource()`(L214-235)**不发送 type 字段**,服务端缺省 book —— paper 上传必须显式带 `type=paper`。方案:paper 插件自带上传表单(§8.4),直接 `fetch("/api/library/sources")` 并在 FormData 加 `type: "paper"`。

---

## 3. arXiv / ar5iv 抓取现状与复用性

`packages/plugin-paper/services/arxiv.ts`(全文 227 行):

- `parseArxivEntries` / `searchPapers` / `getPaperInfo` / `normalizeArxivId`:arXiv Atom API(`export.arxiv.org/api/query`)元数据,已可用,直接复用。
- `readPaper(source, jinaApiKey)`(L113-174):输入 arXiv ID/URL 或任意 URL;
  - ID 正则 `/(?:arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5})/`(L121-123)—— **只认新式 ID(如 2301.07041),旧式 `hep-th/9901001` 会落进"非 http 输入报错"分支**,是已知盲区;
  - arXiv → 直连 `https://ar5iv.labs.arxiv.org/html/{id}`(免 Jina key);其他 URL → `https://r.jina.ai/{url}`(Accept: text/markdown,Bearer jinaApiKey);
  - ar5iv 响应经 `html2text()`(L181-227):去 script/style/nav,**h1-h6 → `#`~`######`**,p/br/div/li 换行,b/strong/i/em 加粗斜体,a 转链接,实体解码;
  - **120,000 字符截断**(L166-171)—— 这是聊天上下文保护,**管道摄取不可复用此截断**(论文全文要完整落盘)。

**复用结论**:html2text 已经把 ar5iv 的章节标题结构转成 markdown 标题,`extractPaperSections` 在其输出上跑正则即可拿到 section 结构 —— 复用成立。增强项(可选):ar5iv 是 LaTeXML 产物(`<section class="ltx_section">` 等),可写一个 paper 专用转换器把 `ltx_section/ltx_subsection` 映射为 `##/###` 并保留 `ltx_ref` 编号,比通用 html2text 的 h 标签更忠实。建议管道新函数 `fetchPaperMarkdown(arxivId, jinaApiKey)`(返回完整正文 + 元数据),与聊天工具 `readPaper` 分开,互不影响。

**PDF 下载**:arXiv 官方 `https://arxiv.org/pdf/{id}`(ArxivEntry.pdfUrl 已有该字段),`fetch` → `writeFile` 即可;注意加 UA(`pi-tree/1.0`)与失败重试。

---

## 4. 论文章节提取设计(§4 = 调研问题 4)

### 4.1 toc.json 格式(必须兼容 server)

book 生成代码:`process-book.ts` L195-200 直接把 `extractHeadings()` 的返回值 `JSON.stringify(headings, null, 2)` 写入 `analysis/toc.json` —— **顶层必须是数组**。server 消费方 `LibraryService.loadTocJson`(services/library.ts L362-398)只读 `{line, level, title}` 三个字段(额外字段会被忽略,安全),`buildOutlineTree` 按 level 建树;`GET /api/library/sources/:sourceId/outline`、`/headings` 都从它来。paper **必须保持数组形状**,同时为渲染面板(P4)增加可选字段:

```json
[
  { "line": 18, "level": 1, "title": "1  Introduction", "page": 1 },
  { "line": 40, "level": 2, "title": "1.1  Motivation", "page": 2 },
  { "line": 152, "level": 1, "title": "3  Method", "page": 5 },
  { "line": 420, "level": 1, "title": "References", "page": 12 }
]
```

字段说明:`line` = `markdown/paper.md` 中的行号(AI `read` 工具 offset 导航用,与 book 一致);`level` = 1/2/3(标题层级);`page` = 可选,PDF 页码(0 基或 1 基二选一,建议 1 基,与渲染面板约定;ar5iv 来源无页码则省略)。

### 4.2 提取器设计(`services/sections.ts`,新文件)

输入:markdown 全文(ar5iv 或 PDF 提取)+ 可选 PDF outline + 可选 page-index。按优先级合并三个来源:

**(a) 编号标题正则**(论文最强信号,参考 book 的 `N.M` 规则但加强):

```ts
// "3.1 Introduction" / "3 Methodology" / "A.2 Proofs" / "IV Experiments"
const numbered = /^(\d{1,3}|\b[A-Z]\b|IV|V|VI|VII|VIII|IX|X)(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?\s+([A-Za-z][A-Za-z0-9 ,:–\-']{1,120})$/i;
// level = 出现的数字段数(1 → level 1,"3.1" → 2,"3.1.2" → 3)
```

过滤误报:行长度上限(如 >150 字符剔除)、纯数字行、以 `.` 或 `,` 结尾的句子(真标题一般不以句号结尾)、全部大写的行(arXiv 常见)允许但归一化标题大小写。

**(b) 常见论文节名**(独立成行的裸节名,level 1):

```
Abstract, Introduction, Related Work|Background, Preliminaries,
Method|Methodology|Approach|Model|Architecture,
Experiment|Experiments|Evaluation|Results, Analysis,
Discussion, Conclusion|Conclusions|Summary, Future Work,
References|Bibliography, Acknowledg(e)ments, Appendix|Appendices
```

(带编号前缀如 `5 Conclusion` 已被 (a) 捕获;裸词匹配需整行相等或仅带尾随标点,避免正文句子误命中。)

**(c) PDF 内嵌 outline(书签)**:`pdf-parse@2.4.5` 的 `getInfo()` 返回 `InfoResult.outline: OutlineNode[]`(`{title, bold, italic, dest, items}` 树,即 PDF.js `getOutline()`,已确认在 node_modules/pdf-parse/dist/pdf-parse/esm/InfoResult.d.ts)。用途:
1. 用归一化标题与 (a)/(b) 结果**交叉校验/替换标题文案**(outline 标题通常最干净);
2. 从 `dest` 取页码:`dest` 为数组时首元素若是数字即为 0 基页索引(可换算);若是 `{num, gen}` 引用,`pdf-parse` 公开 API 不暴露 ref→页码映射 —— **降级策略**:用 outline 标题匹配到 markdown 中的标题行,再从 page-index 拿页码。arXiv 上传的 PDF 常**无 outline**,因此 outline 只能是辅助来源,主来源是 (a)/(b)。

**合并算法**:三个来源按 (行号, 标题) 去重 —— 同一行号±3 内且归一化标题相同的合并(取 outline 标题文本、取 (a) 的 level);保留出现顺序;`Abstract/References` 等裸节名强制 level 1。最终写 toc.json,并同时产出:

- `analysis/page-index.json`:`[{ "page": 1, "startLine": 1 }, …]`(PDF 来源;解析时用 `TextResult.pages` 逐页文本拼接并在 `paper.md` 中插入页标记行 `<!-- page:N -->` 或直接记 startLine;渲染面板 P4 用它做"章节→页"跳转与 toc 交叉校验);
- metadata 回填 `sources.update({ title, author, year, status: "ready" })`(arXiv 来源用 `getPaperInfo` 的结果;上传来源用 PDF `getInfo().info.Title/Author` 兜底,同 book)。

### 4.3 与 book 的差异对照

| | book `extractHeadings` | paper `extractPaperSections` |
|---|---|---|
| md 标题 | ✅ `#{1,6}` | ✅ 同(ar5iv 输出天然是 md 标题) |
| 编号规则 | `^(\d+)\.(\d+)\s+` 固定 level 2 | 1~3 段编号 + 字母/罗马数字附录,按段数定 level |
| 裸节名 | Introduction/Conclusion/Summary/References | 扩展论文词表(Related Work/Method/Experiments/…) |
| Chapter N | ✅ 专有规则 | ❌ 不需要 |
| PDF 书签 | ❌ 未用 | ✅ 辅助来源 + dest 页码 |
| 页码字段 | ❌ | ✅ 可选 `page` + `page-index.json` |

---

## 5. 原始 PDF 留存:改动点(问题 5)

**结论:现有代码没有任何"处理后删除原文件"的逻辑,无需"改成不删"的 diff**;工作重点是约束新代码不引入删除,并固化一个可确定性服务的规范文件名:

1. **上传来源**:`original.pdf` 由 server 上传路由写好后原样保留;paper 处理器**不 unlink、不 rename** 它(rename 会破坏 book 的 `findOriginalFile` 约定与幂等逻辑)。处理器可将它 `copyFile` 为 `paper.pdf`(论文 1-10MB,代价可忽略),使文件服务路径确定。
2. **arXiv 来源**:下载时直接写入最终路径 `{sourceDir}/paper.pdf`(不要"临时文件+处理完删除"的流程,那正是要避免的删除点)。
3. **唯一全量删除**在 `DELETE /api/library/sources/:sourceId`(library.ts L577-579,删整目录)—— 这是用户主动删除来源,原 PDF 一并删除,行为正确,保留。
4. **force 重跑**:paper 处理器照 book 模式,force 只删 analysis 缓存(toc.json/paper.md),**不碰 PDF**。
5. 规范:`文件服务` 优先 `paper.pdf`,回退 `original.pdf`(§6.2);两处都无则 404。

---

## 6. 静态文件服务现状与 paper 文件路由(问题 6)

### 6.1 现状

- `serveStatic` 已引入:仅 `app.ts` 的 `mountSpaFallback()`(L121-158,NODE_ENV=production 时服务 client dist)。依赖版本 `@hono/node-server@1.19.14`(server 直接依赖)。
- **Range 支持:内置且完整**。node_modules/@hono/node-server/dist/serve-static.js L147-169:`HEAD/OPTIONS` 返回 Content-Length;无 Range → 200 + 流式 `createReadStream`;有 Range → 解析 `bytes=start-end`,设置 `Accept-Ranges: bytes`、`Content-Range: bytes start-end/size`、`Content-Length`,206 + `createReadStream({start,end})`。Content-Type 由 mime 库按扩展名给(`.pdf` → `application/pdf`)。pdf.js 按需分块加载的 Range 需求**零成本满足**。
- 鉴权现状:server 全站**无任何鉴权中间件**(app.ts 仅 `logger()` + `cors()`);所有内容路由(`/api/library/sources/:id/content`、`/cover`、`/analysis/:filename`)均为本地单用户无鉴权模型。paper 文件路由**照此模型**即可,不引入新鉴权;风险点见 §10.5。

### 6.2 paper 文件路由设计

manifest:`routePrefix: "/api/paper"`(包名 `pi-tree-paper` → name `paper`,默认前缀已是 `/api/paper`,agent-registry.ts L463;显式写死更稳)。在 `plugin-paper/routes.ts` 增加:

```
GET /api/paper/sources/:sourceId/file            → 流式 PDF(inline,支持 Range)
GET /api/paper/sources/:sourceId/file?download=1 → 附件下载(Content-Disposition)
```

实现(伪代码):

```ts
routes.get("/sources/:sourceId/file", async (c, next) => {
  const sourceId = c.req.param("sourceId");
  // 1. 鉴权/校验:仿照现有内容路由的无鉴权模型,但必须防目录穿越
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(sourceId)) return c.json({ error: "Invalid source id" }, 400);
  const row = await ctx.sources.get(sourceId);
  if (!row || row.type !== "paper") return c.json({ error: "Source not found" }, 404);
  // 2. 解析规范文件:paper.pdf → original.pdf
  const rel = [join(sourceId, "paper.pdf"), join(sourceId, "original.pdf")]
    .find(p => existsSync(join(sourcesBasePath, p)));
  if (!rel) return c.json({ error: "File not found" }, 404);
  // 3. download 模式:readFile + Content-Disposition attachment(整文件下载不需要 Range)
  if (c.req.query("download") === "1") { /* readFile → c.body + headers */ }
  // 4. 流式模式:serveStatic,root 指向 sourcesBasePath,rewriteRequestPath 映射到 rel
  return serveStatic({
    root: sourcesBasePath,
    rewriteRequestPath: () => rel,
    onNotFound: () => c.json({ error: "File not found" }, 404),
  })(c, next);
});
```

要点:

- **必须自己校验 sourceId**:serveStatic 内置的路径穿越检查作用于请求路径而非 `rewriteRequestPath` 的返回值(见 dist L104-108),rewrite 后路径由我们拼接,故先做 DB 存在性 + 白名单正则双重校验。
- Range/206、Content-Type 全部由 serveStatic 处理;`onNotFound` 里返回 404 JSON,避免落空。
- 与现有内容读取路由的对照:`GET /api/library/sources/:sourceId/analysis/:filename`(library.ts L167-187)同样是无鉴权 + 文件名防穿越 + 404 JSON,本设计与其一致,只是换成流式 + Range。
- 挂载顺序无风险:bootstrap.ts 中插件路由在 `mountSpaFallback()` 之前注册(bootstrap L233-238),通配回退不会吞掉 `/api/paper/*`。

---

## 7. 大文件上传限制(问题 7)

- **没有限制**:server 端无 `bodyLimit` 中间件(全仓库 grep 无命中)、`@pi-tree/shared` 的 `DEFAULT_SERVER_CONFIG`(shared/src/types.ts L386-389)只有模型字段、`config.ts` 无上传相关项;客户端 `api.ts`/`BookAddSourceForm` 也不校验大小。
- 实际行为:`@hono/node-server` 将整个请求体(含 multipart 文件)读入内存后 `Buffer.from(await file.arrayBuffer())`(library.ts L392)再落盘 —— 实际上限 = 可用内存。
- 影响:论文 PDF 通常 1-10MB,无风险;几十~上百 MB 的扫描版/书扫描 PDF 可能吃内存。**可选加固**(超出 P3 范围,记入 backlog):在 app.ts 加 `bodyLimit({ maxSize: 200 * 1024 * 1024 })` 或改流式写盘;或在 `validateUploadedFile` 处按 `buffer.length` 拒超限文件(注意那时代价已发生,真正防内存需在中间件层)。

---

## 8. 完整实现规格

### 8.1 目标数据流

```
【上传来源】
  浏览器 → POST /api/library/sources (multipart, type=paper)
    → $DATA_PATH/sources/{id}/original.pdf + DB(pending)
    → jobQueue.enqueue(id) → processor("paper")
【arXiv 来源】
  浏览器 → POST /api/library/sources/create (JSON, type=paper, metadata.arxivId)
    → DB(ready/pending) → (server 小改:有处理器则 enqueue,§8.6)
    → processor 内:getPaperInfo(id) 元数据 + 下载 arxiv.org/pdf/{id} → paper.pdf
                      + 抓 ar5iv HTML → markdown/paper.md(缺 PDF 时正文来源)
【处理器 Phase 1(确定性)】
  1) onProgress("downloading", 10)   — arXiv 来源下载 PDF/HTML
  2) onProgress("converting", 30)   — PDF(pdf-parse,复用 book PdfParser 逻辑)
      或 ar5iv HTML → markdown/paper.md;构建 page-index(仅 PDF)
  3) onProgress("structuring", 55)   — extractPaperSections → analysis/toc.json
  4) sources.update({ status:"ready", title, author, year, error:null })
【处理器 Phase 2(agentic,可选)】
  6) 无 outline.md 且配置开启 → onProgress("analyzing", 70)
     agentTask.run(mode:"analysis") 写 analysis/summary.md(失败不致命)
【队列层后处理(自动,progress 90)】
  7) concepts:true → agentTask 概念提取 → analysis/concepts.json
  8) job: completed / progress 100
【消费端】
  - AI 会话:systemContext 注入 {file:analysis/toc.json},read 工具按行号读 paper.md
  - 面板(P4):GET /api/paper/sources/{id}/file (Range) + toc.json/page-index.json
```

### 8.2 toc.json 格式示例

见 §4.1 的 JSON 块。兼容性承诺:顶层为数组、每项含 `line/level/title`(server outline 必需);`page` 为 paper 扩展字段。

### 8.3 文件改动清单

**必须(paper 插件)**:

| 文件 | 改动 |
|---|---|
| `packages/plugin-paper/package.json` | `sourceType.hasProcessing: false→true`;`addSource` 增 `hasFileUpload: true, acceptedExtensions: [".pdf"]`(保留 arxivId 字段);加 `routePrefix: "/api/paper"`;加 `systemContext`(仿 book,注入 `{file:analysis/toc.json}` + paper.md 说明);可选 badges(Converted/PDF) |
| `packages/plugin-paper/routes.ts` | `registerProcessor("paper", …)`(Phase1/Phase2 编排,照 book routes.ts);新增 `GET /sources/:sourceId/file`(§6.2);保留 discover 注册 |
| `packages/plugin-paper/services/process-paper.ts`(新) | 管道主函数:识别来源(upload 的 original.pdf / metadata.arxivId)→ 下载/解析 → 写 paper.md + page-index.json + toc.json → DB 更新;幂等(paper.md 已存在则跳过,同 book) |
| `packages/plugin-paper/services/sections.ts`(新) | `extractPaperSections`(§4.2)+ `extractHeadingsFromMarkdown`(md 标题分支)+ outline 合并;纯函数,可单测 |
| `packages/plugin-paper/services/fetch-paper.ts`(新,或并入 arxiv.ts) | `downloadArxivPdf(id, destPath)`、`fetchAr5ivMarkdown(id)`(复用 `html2text` 或新 LaTeXML 转换器,不做 120k 截断);`readPaper` 保留给聊天工具 |
| `packages/plugin-paper/ui/PaperAddSourceForm.tsx` + `ui/plugin.tsx`(新) | 上传表单(仿 BookAddSourceForm,拖拽 + title/author/arxivId 二选一),FormData **显式带 `type:"paper"`**;`plugin.tsx` 注册 `addSourceForm`(ContentPanel 属 P4,此步不写) |
| `packages/plugin-paper/skills/paper-reading/SKILL.md` | 增加 toc.json 导航与 `read` 工具 offset 用法说明(与 P2 语言策略并行改) |

**建议(server 小改,均为可选)**:

| 文件 | 改动 |
|---|---|
| `packages/server/src/routes/library.ts` | `POST /sources/create` 末尾:若 `getJobQueue().hasProcessor(type)` 则 `enqueue(id)`(与上传路径 L483-486 对齐)—— 否则 arXiv 来源不会自动处理;或改用插件路由创建 arXiv 来源(改动面更大,不推荐) |
| `packages/server/src/services/job-queue.ts` | `buildExtractionInstructions` 的 paper 分支(L235-241)改为优先读 `markdown/paper.md` + `analysis/toc.json`(概念提取不再依赖会话工具 `read_paper`) |
| `packages/client/src/api.ts` | (仅当复用通用上传函数时)`uploadSource` 增加 type 参数;插件自带表单方案可跳过 |

**不做**:删除任何 `original.*` 文件的代码(本就不存在,§5);引入鉴权中间件(超出 P3 且与现状不一致)。

### 8.4 实施步骤(建议 3-4 天)

1. **骨架**:paper manifest 字段 + `routes.ts` 注册空处理器 + 上传一条 PDF 验证 job 流程(status 流转、progress 可见于 /api/jobs)。
2. **PDF 路径**:`process-paper.ts` 完成 original.pdf → `markdown/paper.md`(复用/拷贝 book `PdfParser`)+ `page-index.json` + `sources.update`;上传来源全链路可用。
3. **章节提取**:`sections.ts` 三来源合并 → toc.json;单测覆盖编号标题/裸节名/outline/误报样本;对照 server `loadTocJson` 兼容性(数组形状)。
4. **arXiv 路径**:`fetch-paper.ts`(downloadArxivPdf + ar5iv→md)+ 处理器分支 + server `sources/create` 的 enqueue 小改;验证 ar5iv 无 PDF 兜底。
5. **文件服务**:`/sources/:sourceId/file`(serveStatic + 校验);curl 验证 `Range: bytes=0-99` 返回 206 + Content-Range。
6. **收尾**:systemContext + SKILL.md;force 重跑语义(只清 analysis 产物);概念提取指令更新;jobs UI 验证 completed/100。

### 8.5 验收标准(对应 DEV_PLAN Phase 3)

- 上传 arXiv/本地 PDF:原文件留存可下载(`/api/paper/sources/{id}/file`,200 + application/pdf);
- `Range: bytes=0-99` → **206**,`Content-Range` 正确;HEAD 返回 Content-Length;
- `analysis/toc.json` 章节与行号正确(抽查编号/裸节名两类论文);`/api/library/sources/{id}/outline` 能读它;
- AI 回答能按 toc.json 行号引用原文(read 工具 offset);
- 无 PDF 的 arXiv 来源:paper.md 由 ar5iv 生成,toc.json 正常,file 路由 404(渲染面板降级,属 P4)。

---

## 9. 风险点

1. **ar5iv 可用性/限流**:ar5iv 对未收录/新论文无 HTML 版;抓取失败需优雅降级(仅 PDF 文本提取或仅元数据 + status 提示),不要 fail 整个 job。
2. **旧式 arXiv ID**:现有正则只匹配 `\d{4}\.\d{4,5}`(arxiv.ts L121-123);`hep-th/9901001` 类旧 ID 会解析失败 —— `normalizeArxivId` 同样未处理。若支持旧库需先修正则。
3. **扫描版 PDF**:无文本层 → 提取为空、无章节;仍保留 PDF、toc.json 写空数组 + metadata 标记;渲染面板 P4 已有降级设计(提示条)。
4. **outline dest 页码映射**:`{num,gen}` 引用型 dest 无法经 pdf-parse 公开 API 换页码;需走"标题匹配 → 行号 → page-index"降级;page 字段因此标记为 best-effort。
5. **鉴权缺口**:全站当前无鉴权,文件路由同模型;若未来 server 加 auth,必须同步加到该插件路由(在规格中已标注)。
6. **大文件内存**:无 bodyLimit,超大 PDF 会撑爆内存(§7);短期靠 PDF 校验兜底,长期建议中间件限流。
7. **enqueue 缺口**:`sources/create` 不触发处理 —— 漏改则 arXiv 来源永远 pending(§8.3 建议项 1)。
8. **120k 截断污染**:管道若直接调用 `readPaper` 会把全文截断 —— 必须走新 `fetchAr5ivMarkdown`。
9. **toc.json 兼容性**:顶层必须是数组;若改成 `{entries:[…]}` 结构,server `loadTocJson`、`getHeadings`、book outline UI 全部失效。
10. **pdf-parse 内存/耗时**:大 PDF 全文 getText 较慢且占内存;job 已是异步,仅影响进度面板时长;可后续按页流式提取。

---

## 10. 附录:关键代码位置索引

| 主题 | 位置 |
|---|---|
| book 处理器 / 进度回调 | `packages/plugin-book/routes.ts` L11-62 |
| processBook / extractHeadings / toc.json 生成 | `packages/plugin-book/services/process-book.ts` L40-102, L123-223 |
| PDF 解析器(pdf-parse) | `packages/plugin-book/parsers/pdf-parser.ts`;类型 `parsers/types.ts` |
| 上传路由 / 保存 / 校验 / enqueue | `packages/server/src/routes/library.ts` L47-62, L365-509 |
| 元数据创建(无 enqueue) | 同上 L231-353 |
| 队列(job 状态/进度封顶/概念后处理) | `packages/server/src/services/job-queue.ts` L72-208 |
| Jobs API / force | `packages/server/src/routes/jobs.ts` L24-30 |
| 插件挂载 / PluginRouteContext 组装 | `packages/server/src/bootstrap.ts` L184-238 |
| PluginRouteContext / PluginManifest 类型 | `packages/plugin-sdk/src/types.ts` L264-291, L345-423 |
| ar5iv / Jina 抓取 | `packages/plugin-paper/services/arxiv.ts` L113-227 |
| paper manifest(hasProcessing:false) | `packages/plugin-paper/package.json` L20 |
| book manifest(hasProcessing:true/addSource) | `packages/plugin-book/package.json` L20, L41-70 |
| systemContext `{file:…}` 注入机制 | `packages/server/src/services/tree-manager.ts` L967-1032 |
| toc.json 消费(loadTocJson/outline) | `packages/server/src/services/library.ts` L362-398 |
| serveStatic Range 实现 | `node_modules/@hono/node-server/dist/serve-static.js` L147-169(版本 1.19.14) |
| 上传大小限制(不存在) | server 无 bodyLimit;`@pi-tree/shared/src/types.ts` DEFAULT_SERVER_CONFIG L386-389 |
