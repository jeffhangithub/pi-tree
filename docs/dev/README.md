# docs/dev — 开发文档索引

本目录存放 pi-tree 定制版的开发文档(中文)。

| 文档 | 内容 |
|---|---|
| [USER_SCENARIOS.zh.md](./USER_SCENARIOS.zh.md) | 用户场景:目标用户、8 个核心使用场景、非目标 |
| [DESIGN_PRINCIPLES.zh.md](./DESIGN_PRINCIPLES.zh.md) | 设计思想:继承自 pi-tree 的哲学、本项目的 8 条增量设计原则、10 项关键决策记录 |
| [DEV_PLAN.zh.md](./DEV_PLAN.zh.md) | 开发计划:P0-P6 分阶段计划、工作量、验收标准、待决策点 |
| [P1-settings-api-key.md](./P1-settings-api-key.md) | P1 实现规格:设置页 API Key(默认 DeepSeek) |
| [P3-paper-pipeline.md](./P3-paper-pipeline.md) | P3 实现规格:paper 结构化管道(PDF 上传/arXiv 抓取/章节提取/文件服务) |
| [P4-pdf-viewer.md](./P4-pdf-viewer.md) | P4 实现规格:真 PDF 渲染面板(pdfjs-dist)+ 划词/划章节提问 |
| [IMPLEMENTATION_STATUS.zh.md](./IMPLEMENTATION_STATUS.zh.md) | 实现状态与交付说明:各阶段 commit、能力一览、验证结果、使用方式 |

| [`.agents/skills/paper-pdf-rendering/`](../../.agents/skills/paper-pdf-rendering/SKILL.md) | 项目级 skill:PDF 渲染/划词的技术契约与陷阱(pdf.js v5 TextLayer 变量、`::selection` 覆盖、DPR、原子替换、插件注册、e2e 契约)+ 验证配方 |
| `~/.dsh/skills/render-artifact-triage/` | 用户级 skill(跨项目):渲染类 bug 的排查方法论(先复刻用户操作、指标先校准、逐层二分、已知良好参照、两次失败即转刻画、核验委派报告) |

> 代码仓库:https://github.com/jeffhangithub/pi-tree (fork 自 https://github.com/shuowu/pi-tree,upstream 定期同步)
