# 实现状态与交付说明(截至 2026-09-20)

> 分支:`feat/paper-pdf` · 上游:`shuowu/pi-tree` v0.3.3 · fork:`jeffhangithub/pi-tree`
> 主线 P0-P5 已全部实现并验证;P6 收尾进行中。

## 交付清单(按阶段)

| 阶段 | 内容 | commit | 状态 |
|---|---|---|---|
| P0 | 环境基线(clone/build/typecheck/test 全绿) | — | ✅ |
| P1 | 设置页 API Key + 默认 DeepSeek | `dde5b55` | ✅ |
| P2 | 回复语言偏好 + 多源回答策略 | `86eed67` | ✅ |
| P3 | paper 结构化管道(PDF 上传/arXiv 抓取/章节提取/Range 文件服务) | `d193f8a` | ✅ |
| P4 | 真 PDF 渲染面板(pdfjs-dist 5.7)+ 划词锚点采集 | `944fd3c` | ✅ |
| P5 | 双类锚点闭环(锚点入库/回跳定位/阅读记录导出) | `a208ac8` | ✅ |
| P6 | 收尾(e2e 契约更新/文档/发布) | 进行中 | 🔄 |

## 新增/修改能力一览

### 1. 设置页配置 API Key(默认 DeepSeek)
- `GET/PUT /api/settings`:provider/apiKey(掩码尾 4 位)/baseUrl/api/readingModel/lookupModel/replyLanguage;
- key 只写 `$DATA_PATH/models.json`(0600、日志脱敏、永不返回明文);
- 默认模型 `deepseek-v4-flash`,首启自动生成 deepseek provider 模板;`.env.example` 同步。

### 2. AI 回复语言可选 + 多源回答
- 回复语言:follow/zh/en/ja/de/fr,设置页全局 + Reader 头部会话级切换;注入 systemContext(新会话)+ 逐轮指令(resume 会话);
- 多源回答策略(paper-reading SKILL.md):论文内证据 `[论文 §x Lxx]` + 原理性解释 `[原理]` + 外部可信源 `[URL]`;白名单、禁冒充论文结论;
- MCP 桥示例配置(Tavily/Brave + arXiv/Semantic Scholar),填 key 即启用。

### 3. paper 结构化管道
- 添加来源支持 **PDF 上传**(manifest 驱动表单)与 arXiv ID/URL;
- 处理管道:PDF→`original.pdf` 留存 + `paper.md`(页标记)+ `toc.json`(章节+行号+页码)+ `page-index.json`;arXiv→`paper.pdf` 存档 + 元数据回填,正文优先 ar5iv;
- `GET /api/paper/sources/:id/file`:Range/206、HEAD、attachment 下载、防目录穿越;
- `sources/create` 对 paper 自动 enqueue 处理。

### 4. 真 PDF 渲染面板(pdfjs-dist 5.7.284,Apache-2.0)
- 逐页 canvas + TextLayer 文本层(原版排版、可选可复制)、缩放、连续滚动、按需渲染;
- 章节树(内嵌 outline,回退 toc.json)点击跳页;
- 划词 → SelectionToolbar → 统一锚点 `{kind:"pdf",page,quote,section}`;
- 扫描版 PDF 降级提示;StrictMode 安全(取消 RenderTask)。

### 5. 双类锚点闭环
- **统一锚点**:`kind:"pdf" {page,quote,section}` / `kind:"content" {nodeId,quote}`,经 Pi SDK CustomEntry 旁路持久化(JSONL,重启不丢,零 SDK 侵入);
- **展开**:PDF 划词开分支 + AI 回答内划词开分支(content 锚点);
- **回溯**:点击历史节点 → 恢复上下文 + 定位——pdf 跳页高亮(文本层匹配+canvas 覆盖层)/ content 聊天区滚动 + `<mark>` 高亮;
- **导出**:`GET /api/sessions/:id/reading-record` → 可移植 JSON `{source, nodes:[{id,parentId,question,answer,anchor}]}`;侧栏 JSON 下载按钮。

## 验证结果

| 验证 | 结果 |
|---|---|
| `npm run build`(全 workspace) | ✅ |
| `npm run typecheck` | ✅ 0 错误 |
| `npm test`(全 workspace) | ✅ client 65 / core 212 / server 403+1skip / ui 54 / plugin-paper 50 |
| `npx playwright test`(e2e 回归) | ✅ 35/35(含按新契约更新的 add-source 用例) |
| 实机冒烟(P3 报告) | ✅ 上传 PDF 与 arXiv 双路径 + Range/206 |

## Bug 修复轮次

### 轮次 1(2026-09-20,commit `40532d8`)——用户实机试用反馈
| 问题 | 根因 | 修复 | 实测 |
|---|---|---|---|
| PDF 选词乱码/文字重影 | pdfjs-dist 5.7 的 TextLayer 依赖 `--text-scale-factor`/`--min-font-size` 等 CSS 契约(在 pdf_viewer.css 中),我们的手抄样式漏了这些规则,span 字号回落到继承值 14.4px(应 9.56px) | 在页面 wrapper 直接设 `--total-scale-factor`(=scale),删除依赖 `--user-unit` 的失效 calc 链,补齐 textLayer 变量契约 | 重叠数 365 → **0**;canvas==textLayer==wrapper(367×475);`fontSize==fontHeight*scale` 145/145 正确;拖选文本与预期完全一致 |
| 面板布局失衡(目录过长、PDF 视口过短、默认 205% 缩放) | 目录区 max-height 失效/占比过大;初始缩放 clamp 0.2–4 且基于宽容器估算 | 目录默认折叠(展开 max-height 30%);PDF 区 `flex:1`;初始缩放改为容器宽度自适应 clamp 0.6–2;右栏默认宽 320→400px | 折叠时 PDF 视口占 91.5%,展开目录 28.5%,缩放 60% 自适应,无横向溢出 |
| session tree 看不出父子层级 | 渲染逻辑把单子链折叠为同一缩进(`depth` 不递增);会话本身**无真实分支**(JSONL 中 children>1 均为 custom 元数据) | 每层用 `.tree-children` 包裹(18px 缩进 + 导轨 + tick),子节点恒 `depth+1`,加 `data-depth`,分支徽标 `⑂N` 强化 | 用户会话渲染 depth 0–4、left 8/27/46/65/84;mock 环境真造分支后父(⑂2)→ 两同级子 断言通过 |

> ⚠️ 排查中发现的待查问题:某次 `user_sessions.id=2` 的 `is_active` 被置 0(仅 `DELETE /api/sessions/...` 会写该字段),导致侧栏显示 "No session tree yet";已手工恢复。若会话"消失",优先检查该字段——疑为真实代码缺陷,待专项排查。

## 已知边界与后续- **e2e 契约更新**:paper 创建后立即为 `pending`(异步处理),e2e 环境无 arXiv 网络故不等待 ready——真实环境用真实模型/网络时处理完成即 ready;
- **P4 未做**:构建脚本自动拷贝 pdfjs 资产(现直接入库 `client/public/pdfjs/`)、manualChunks 优化;
- **P5 未做**:完整 e2e(核心逻辑已单测覆盖);
- **后续阶段**:第二阶段 Zotero 插件(共享核心层拆出,见 `DEV_PLAN.zh.md` §5)。

## 使用方式

```bash
# 开发模式(server :3947 / client :5947)
npm run dev
# 生产构建
npm run build
# Docker(带 .env 或首启后在设置页填 key)
docker compose up
```
首次使用:打开设置页 → Provider 选 DeepSeek → 粘贴 API Key → 保存;添加论文(PDF 上传或 arXiv 链接)→ 右侧面板阅读原文 → 划词提问。
