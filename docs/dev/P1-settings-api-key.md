# P1: 设置页配置 API Key(默认 DeepSeek)— 实现规格

> 来源:DEV_PLAN.zh.md Phase 1(第 116-130 行)。
> 目标:用户在设置界面填 key / 选 provider,不再开 `.env` 或手写 `models.json`;默认模型改为 DeepSeek(`deepseek-v4-flash`)。
> 本文档为纯调研结论 + 实现规格,所有行号基于当前工作区代码快照。

---

## 1. 调研结论(现状)

### 1.1 models.json 的 schema、加载与缓存

**文件**:`packages/server/src/services/models-json.ts`

路径:`$DATA_PATH/models.json`;`DATA_PATH` 未设时为 `~/.local/share/pi-tree`(macOS 上即 `~/.local/share/pi-tree`,与 `global-config.json` 同目录,`models-json.ts:54-59`)。

Schema(与 Pi SDK 的 `~/.pi/agent/models.json` 同构):

```ts
export interface ModelsJsonProvider {
  baseUrl?: string;                       // 如 "https://api.deepseek.com"
  api?: string;                           // "openai-completions" | "anthropic-messages" | ...
  apiKey?: string;                        // 支持 "$ENV_VAR" 语法(resolveApiKey 解析)
  compat?: Record<string, boolean>;
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
    input?: string[];                     // ["text"] | ["text","image"]
    cost?: Record<string, number>;        // input/output/cacheRead/cacheWrite
  }>;
}
export interface ModelsJson { providers?: Record<string, ModelsJsonProvider>; }
```

加载与缓存(`models-json.ts:52-85`):

- 模块级单例缓存 `let _cached: { data: ModelsJson | null; path: string } | null = null;`
- `loadModelsJson()`:若 `_cached.path === filePath` 直接返回缓存;**不检查 mtime、无 TTL**,文件被外部修改后不会自动重读。
- 缓存失效仅两种途径:
  1. `resetModelsJsonCache()`(已导出,`models-json.ts:120-122`,注释写 "used in tests")——把 `_cached` 置 null;
  2. `DATA_PATH` 环境变量变化导致路径不同(测试场景)。
- 文件不存在 / JSON 解析失败都返回 `null`,且**同样会写入缓存**(下次不再碰磁盘)——因此写入成功后必须调用 `resetModelsJsonCache()`,否则新文件不会生效。

辅助函数:

- `resolveApiKey(raw)`(`:91-97`):空值→`undefined`;`$ENV_VAR` → `process.env[...]`(找不到时原样返回);否则原样返回。
- `findProviderForModel(modelId)`(`:103-115`):遍历 providers,**要求 `providerCfg.models` 数组中存在该 modelId** 才返回 `{name, config}`。注意:若某 provider 的 `models` 数组缺失或不含目标模型,该函数返回 null,provider 配置(apiKey/baseUrl)不会生效——这是下面接口设计的关键约束。

**现状:服务端对 models.json 只有读、没有任何写路径**(全仓库 `writeFileSync(...models.json)` 仅出现在测试文件)。

### 1.2 现有 `/api/models` 路由与响应结构

**文件**:`packages/server/src/routes/models.ts`,挂载于 `app.ts:71` → `app.route("/api/models", modelRoutes)`。

`GET /api/models`(`models.ts:43-145`)每次请求都:

1. `getServerConfig()` 取 env/file 配置;
2. `configureModelRegistry(...)` 建临时注册表(内置 SDK 模型 + env provider);
3. `loadModelsJson()` 把 models.json 里每个 provider(含其 models 数组)注册进注册表(apiKey 经 `resolveApiKey` 解析);
4. `allowedProviders = { cfg.provider } ∪ modelsJson 的 provider 名` 过滤 → 去重 → 输出。

响应结构:

```jsonc
{
  "models": [ { "id", "name", "provider", "reasoning", "contextWindow" } ],   // ModelInfo
  "currentModel": "deepseek-v4-flash",          // = cfg.readingModel
  "providers": [ { "name", "source": "environment"|"models.json", "modelCount" } ]
}
```

`POST /api/models/test`(`:159-198`):连接测试,`findProviderForModel` + `resolveApiKey` 做 provider 覆盖,30s 超时。

**关键行为**:当 env 未配 provider 且 models.json 无内容时,`allowedProviders` 为空 → `models` 返回空数组 → 前端显示 "No models available"。若 models.json 的 provider 条目写了 `baseUrl`(即使不含 models),SDK 内置同名 provider 的模型也会以该 baseUrl/apiKey 出现在列表中(models.ts 的 registerProvider 会覆盖内置 provider 的 URL/key)。

**路由注册模式**(新增路由照此办理):每个路由文件 `packages/server/src/routes/<name>.ts` 导出一个 `export const xxxRoutes = new Hono()`,在 `app.ts` 顶部 import 并 `app.route("/api/xxx", xxxRoutes)`(见 `app.ts:6-17, 65-77`)。现有 `routes/config.ts`(`GET/PUT /api/config`,只暴露 readingModel/lookupModel,写入 `global-config.json`)是最贴近的参考实现。

### 1.3 API key 加载链路与脱敏现状

服务端链路:

- `config.ts:getServerConfig()`(lazy 单例 `_config`,首次调用初始化):`fileConfig(global-config.json) || env(PI_PROVIDER / PI_API_KEY / PI_BASE_URL / PI_API / PI_MODEL / PI_LOOKUP_MODEL) || ""`。`apiKey` 等认证字段定义在 `ServerConfigFull`(server 内部,不进 shared,`config.ts:11-20`)。
- `models-json.ts`:`models.json` 中 provider 的 `apiKey` 经 `resolveApiKey` 解析,在 `routes/models.ts` 与 `tree-manager.ts` 中用于 provider 覆盖(`tree-manager.ts:148-159`:`findProviderForModel` 且 provider 名 ≠ `cfg.provider` 时才用 models.json 的 baseUrl/apiKey/api;否则 env 配置是 source of truth)。
- **掩码/脱敏现状**:
  - `saveServerConfig()`(`config.ts:101-175`)已实现掩码语义:入参 `apiKey` 含 `"•"` 视为"掩码值,保留文件里已存的值";空串视为"删除 override,回退 env"。**这是可复用的先例**。
  - `GET /api/config` 只返回 readingModel/lookupModel,`api-smoke.test.ts:93-103` 断言响应**不含** apiKey/provider/baseUrl。
  - 日志:config.ts 只 log provider 名与 api type;tree-manager 只 log provider 名;models-json 只 log 文件路径。**全仓库未发现打印 key 的日志**。
  - **没有任何现成的掩码工具函数**(如 `maskApiKey`),需新写。

### 1.4 默认模型 `glm-5-turbo` 的硬编码位置(逐文件)

| 文件 | 行 | 内容 |
|---|---|---|
| `packages/shared/src/types.ts` | 373(注释)、387-388 | `DEFAULT_SERVER_CONFIG.readingModel/lookupModel = "glm-5-turbo"` |
| `README.md` | 136 | 模型表:`\| Zhipu \| glm-5-turbo \| ...` |
| `docs/docs/models.md` | 19 | 同上模型表 |
| `packages/ui/README.md` | 54 | 示例 `<ModelIcon modelName="glm-5-turbo">` |
| `DEV_PLAN.zh.md` | 71、136 | 计划文档提及(非代码) |

**重要事实**:`DEFAULT_SERVER_CONFIG` 在 `config.ts:5` 被 import,但 `getServerConfig()` 的对象字面量**从未使用它**(全部回退到 `""`),即它是当前运行时的死代码——未配置时 `readingModel=""` 导致会话创建直接报错(`Model "" not found under provider ""`),并非真的默认走智谱。**实现本功能时必须把它真正接入回退链**(见 4.3)。另外 `.env.example` 已经是 DeepSeek(`PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-v4-flash`),DEV_PLAN 的 .env 修改项实际已完成,只需同步 README/docs 文案。

SDK 事实(供默认值设计用):`@earendil-works/pi-coding-agent` 内置 `deepseek` provider(`pi-ai/dist/providers/deepseek.js`:`baseUrl: "https://api.deepseek.com"`),内置模型含 `deepseek-v4-flash` / `deepseek-v4-pro`(openai-completions,deepseek thinking compat,1M 上下文)。内置 provider 名还有 anthropic/openai/google/zhipu/... 数十个(pi-ai/dist/providers/ 目录),可直接作为下拉候选。

### 1.5 SettingsModal 现状(改动落点)

**文件**:`packages/client/src/components/SettingsModal.tsx`(412 行)+ `packages/client/src/api.ts`。

- 挂载:App.tsx:78 与 HomePage.tsx:128-129(`<SettingsModal onClose={...} />`)。
- 数据拉取(`SettingsModal.tsx:36-66` useEffect):
  - `fetchModels()`(`api.ts:69-73`)→ `GET /api/models` → `{ models, currentModel, providers }`,存 `models`/`providers` state;
  - `fetchServerConfig(true)`(`api.ts:28-34`,force 绕模块级 `_configCache`)→ `GET /api/config` → `{ readingModel, lookupModel }`。
- 模型区(307-408 行):`modelsByProvider` 按 provider 分组成 `<optgroup>` 下拉(Reading/Lookup 各一个),保存走 `saveServerConfig()` → `PUT /api/config`(`api.ts:36-49`,成功后同步 `_configCache`);`POST /api/models/test` 做连接测试。
- **Provider 下拉 / API Key / Base URL 输入均不存在**。空模型时只显示提示框(315-324 行)教用户去改 env 或手写 models.json——这整段要替换成可填写表单。
- 样式:已有 `form-group / form-help / settings-info-box / settings-actions` 等 class(`SettingsModal.css`),新输入控件可复用;API Key 用 `<input type="password">`。

### 1.6 写入配置后的缓存失效机制(现有可复用件)

| 机制 | 位置 | 用途 |
|---|---|---|
| `resetModelsJsonCache()` | `models-json.ts:120` | 置空 `_cached`,强制下次 `loadModelsJson()` 重读 |
| `resetServerConfig()` | `config.ts:94-96` | 置空 `_config`,强制 `getServerConfig()` 重读(仅测试用) |
| `saveServerConfig()` | `config.ts:101-175` | 写 `global-config.json` 后**原地重建 `_config`**,无需 reset |
| `closeAllSessions()` | `session-store.ts:269-275` | 驱逐所有缓存会话(TreeManager 创建时绑定模型);`routes/config.ts:19-34` 已在模型变更时调用它 |

`/api/models` 无注册表缓存(每请求重建),所以模型列表天然即时刷新,只需保证 `_cached` 已重置。进行中的会话仍持有旧 provider/key,需 `closeAllSessions()` 驱逐,前端提示"新会话生效"。

### 1.7 服务端文件写入的权限/原子性现状

- **没有现成的原子写/0600 工具函数**。全部是裸 `writeFileSync(path, JSON.stringify(...))`:config.ts:157(global-config.json)、tag-groups.ts:90、dictionary.service.ts:280、discover.service.ts:106、export-service.ts:325。
- 全仓库没有对配置文件做 `chmodSync`/`mode` 设置;models.json 更是从未被服务端写过。
- 需新增工具函数(见 3.1),并满足 DEV_PLAN 的 "文件权限 0600"。

---

## 2. 接口定义

在 `packages/server/src/routes/settings.ts` 新建 `settingsRoutes`,挂载 `app.route("/api/settings", settingsRoutes)`(app.ts,紧随 `/api/config`)。

### 2.1 `GET /api/settings`

返回(全部脱敏,绝不含明文 key):

```ts
interface SettingsInfo {
  provider: string;               // 生效 provider(无则 "")
  baseUrl: string;                // 生效 baseUrl(空 = 用 SDK 内置默认)
  api: string;                    // api 类型,空 = openai-completions
  readingModel: string;           // 生效默认(= getServerConfig 回退 DEFAULT_SERVER_CONFIG 后)
  lookupModel: string;
  apiKeyMasked: string;           // 如 "sk-…abcd";空串 = 未配置;永不返回明文
  providers: ProviderInfo[];      // 与 GET /api/models 的 providers 相同(前端可复用)
  builtInProviders: string[];     // SDK 内置 provider 名列表(下拉候选,来自临时 registry.getAll() 去重)
}
```

实现要点:

- `apiKeyMasked` 来源顺序:`resolveApiKey(models.json providers[provider].apiKey)` → `getServerConfig().apiKey`;两者都空则 `""`。
- 掩码规则(新工具 `maskApiKey`,建议放 `models-json.ts` 或新 `services/key-mask.ts`):长度 ≤ 8 → `"••••"`;否则 `key.slice(0, 3) + "…" + key.slice(-4)`(对 `sk-` 前缀友好)。`$ENV_VAR` 形式的 key 先 resolve 再掩码。
- `builtInProviders`:`configureModelRegistry({})`(空配置)拿 `modelRegistry.getAll()` 的 provider 去重;与 models.json provider 名取并集,前端默认选中 `provider` 或 `"deepseek"`。

### 2.2 `PUT /api/settings`

请求体(字段级更新,可部分提交):

```ts
interface SettingsUpdate {
  provider?: string;   // 目标 provider 名(决定写进哪个条目,默认 "deepseek")
  apiKey?: string;     // 明文=保存; ""=清除; 含 "…"/"•"=保留现有(掩码回传); 缺省=不动
  baseUrl?: string;    // ""=删除该字段(回退 SDK 内置默认)
  api?: string;
  readingModel?: string;
  lookupModel?: string;
}
```

响应:`{ success: true, settings: SettingsInfo }`(掩码快照,不含明文);失败 `{ success: false, error }`(400)。

服务端语义(核心逻辑,建议实现为 `services/models-json.ts` 新增 `saveModelsJson(patch)`):

1. **写 models.json**(读-合并-写,绝不整文件覆盖,保留用户手写的其他 provider):
   - 若文件不存在 → 初始化为 `{ providers: {} }`。
   - 目标条目 `providers[provider]`,合并 `baseUrl / api / apiKey`(apiKey 走 `saveServerConfig` 同款三态:含 `•/…` 保留、空串删除、否则 trim 保存;`$VAR` 语法原样透传)。
   - **models 数组必须写**:内置 provider → 从临时 registry `getAll()` 拉该 provider 的全部内置模型转 models.json 的 models 子集(id/name/reasoning/contextWindow);自定义 provider → 至少写 `[{ id: readingModel }, { id: lookupModel }]`。原因:`findProviderForModel` 靠 models 数组匹配,tree-manager 的 provider 覆盖才能命中(见 1.1)。
   - 写盘用新原子工具(见 3.1),mode 0600。
2. **写 global-config.json**:复用 `saveServerConfig({ readingModel, lookupModel, ... })`(只存模型偏好与可选 provider/baseUrl;**apiKey 不进 global-config.json**,统一放 models.json,避免双写两处明文)。
3. **缓存失效**:`saveModelsJson` 内部调用 `resetModelsJsonCache()`;`saveServerConfig` 已原地更新 `_config`。
4. **会话驱逐**:若 `readingModel/lookupModel/provider` 有变 → `closeAllSessions()`(照 `routes/config.ts:26-34` 模式),响应里可带 `sessionsEvicted: n` 供前端提示。
5. 校验:provider 名非空且 `[A-Za-z0-9_-]+`;baseUrl 若填必须是 `http(s)://` 开头;未知 provider 允许写入(自定义 provider 场景),但 `builtInProviders` 之外时 models 数组按自定义规则落。

注意与现有体系的一致性:models.json 的 provider 名与 `cfg.provider` **不同名**时 tree-manager 才启用 models.json 覆盖;因此 PUT 不要把 provider 写入 global-config.json(保持 `cfg.provider=""`),否则同名判断会跳过 models.json 里的 key,导致认证失效。

### 2.3 客户端 api.ts 新增

```ts
export interface SettingsInfo { provider; baseUrl; api; readingModel; lookupModel; apiKeyMasked; providers; builtInProviders }
export async function fetchSettings(): Promise<SettingsInfo>            // GET /api/settings
export async function saveSettings(u: SettingsUpdate): Promise<SettingsInfo>  // PUT /api/settings
```

(沿用 `fetchServerConfig`/`saveServerConfig` 的 fetch + 错误抛出模式。)

---

## 3. 文件改动清单

### 3.1 服务端 `packages/server/src`

| 文件 | 改动 |
|---|---|
| `services/models-json.ts` | ① 新增 `saveModelsJson(patch)`(读-合并-写 + `resetModelsJsonCache()`);② 新增 `maskApiKey(raw)`;③ 新增 `writeJsonAtomic(path, data)`(mkdir + 临时文件 + `renameSync` + `chmodSync 0o600`,放这里或新 `services/fs-utils.ts`) |
| `routes/settings.ts`(新) | `GET /` 与 `PUT /` 按 2.1/2.2 实现;import `getServerConfig/saveServerConfig`、`loadModelsJson/saveModelsJson/maskApiKey`、`closeAllSessions`、`configureModelRegistry` |
| `app.ts` | import + `app.route("/api/settings", settingsRoutes)` |
| `config.ts` | `getServerConfig()` 回退链接入 `DEFAULT_SERVER_CONFIG`:`readingModel: fileConfig.readingModel \|\| process.env.PI_MODEL \|\| DEFAULT_SERVER_CONFIG.readingModel`(lookupModel 同理) |
| `bootstrap.ts` | 首启种子:若 `$DATA_PATH/models.json` 不存在,生成 DeepSeek 模板(见 3.3) |
| `__tests__/` | 新增 `settings-api.test.ts`(GET 掩码无明文、PUT 三态 apiKey、0600 权限、缓存失效、models 数组写入、findProviderForModel 命中);`api-smoke.test.ts` 保持通过(`GET /api/config` 仍无 provider/apiKey 字段——settings 接口独立,不破坏该断言) |

### 3.2 共享 / 客户端

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types.ts` | `DEFAULT_SERVER_CONFIG` → `{ readingModel: "deepseek-v4-flash", lookupModel: "deepseek-v4-flash" }`;注释 373 行同步 |
| `packages/client/src/api.ts` | 新增 `fetchSettings/saveSettings` + `SettingsInfo` 类型 |
| `packages/client/src/components/SettingsModal.tsx` | 见 4.4 |
| `packages/client/src/components/SettingsModal.css` | 按需补 Provider 下拉 / key 输入样式 |

### 3.3 文档 / 模板

- `bootstrap.ts` 种子模板:

```json
{ "providers": { "deepseek": {
    "baseUrl": "https://api.deepseek.com",
    "api": "openai-completions",
    "apiKey": "",
    "models": [ { "id": "deepseek-v4-flash", "reasoning": true },
                { "id": "deepseek-v4-pro",  "reasoning": true } ] } } }
```

- `README.md:136`、`docs/docs/models.md:19`:模型表把 DeepSeek 置为默认/首行;`packages/ui/README.md:54` 示例改 `deepseek-v4-flash`。
- `.env.example` 已为 DeepSeek,**无需改**;`docs/docs/getting-started.md` / `self-hosting.md` 提及"设置页可直接填 key"。

---

## 4. 实施步骤(建议顺序)

1. **地基**:`services/models-json.ts` 加 `writeJsonAtomic` + `saveModelsJson` + `maskApiKey`,单测覆盖(读-合并-写、0600、三态 apiKey、reset 生效)。
2. **默认值**:shared 改 `DEFAULT_SERVER_CONFIG`;`config.ts` 接入回退链(修死代码);跑现有 `config` 相关测试确认 `GET /api/config` 行为未变(仅默认值变化)。
3. **种子**:`bootstrap.ts` 首启写 DeepSeek 模板(文件不存在才写,存在则跳过)。
4. **路由**:新建 `routes/settings.ts`(GET/PUT),挂 `app.ts`;写 `settings-api.test.ts`。
5. **客户端**:`api.ts` 加两个函数;`SettingsModal.tsx` 新增 "Provider & API Key" 区:
   - Provider 下拉 = `settings.builtInProviders` ∪ models.json provider 名(默认选中 DeepSeek,无选中时加 "Custom…" 手输选项);
   - API Key:`<input type="password">`,placeholder 显示 `apiKeyMasked`(如 `sk-…abcd`),留空提交 = 不动(响应体里对掩码值原样回传即可,服务端识别 `…/•`);
   - Base URL:可选文本框,空 = SDK 内置默认;
   - 保存:调 `saveSettings`,成功后重拉 `fetchModels()` 刷新模型下拉,提示"已保存,新会话生效";
   - 删除 315-324 行 "No models available" 的 env 教学文案(改为直接可填表单)。
6. **验收**(对齐 DEV_PLAN):全新环境(无 env、无 models.json)→ 打开设置页填 DeepSeek key → 保存 → 新建会话正常问答;界面只显示尾 4 位;重启服务后配置保留;`npm run typecheck` / `npm test` 全绿。

---

## 5. 风险点

1. **models 数组缺失导致 key 不生效**(最重要):`findProviderForModel` 依赖 `models` 数组匹配;PUT 必须写入该数组,否则 tree-manager 不会用 models.json 的 apiKey,认证静默失败。
2. **provider 双写陷阱**:若同时把 provider 写进 global-config.json,`modelsJsonProvider.name === cfg.provider` 会让 tree-manager 跳过 models.json 覆盖而改用 env key(空)→ 认证失败。约定:provider/key/baseUrl 只进 models.json,global-config.json 只存模型偏好。
3. **明文落盘**:apiKey 明文存 models.json(与 SDK 惯例一致),必须 0600 权限;客户端只在 GET 拿到掩码;响应与日志严禁明文。掩码含 `…`/`•` 的 PUT 请求按"保留现有"处理(与 `saveServerConfig` 一致,防止掩码覆盖真实 key)。
4. **缓存与并发**:忘记 `resetModelsJsonCache()` 会导致写后列表/认证不更新(见 1.1);单进程下并发 PUT 概率低,但原子写(tmp+rename)可防半写文件。
5. **DEFAULT_SERVER_CONFIG 是死代码**:改默认值必须同时修 `getServerConfig` 回退链,否则只改 shared 无任何效果。
6. **既有测试约束**:`api-smoke.test.ts:93-103` 断言 `/api/config` 不泄露 provider/apiKey——不要给 `/api/config` 加字段,新信息一律走 `/api/settings`;`saveServerConfig` 的 `existingFileConfig: Record<string,string>` 只覆盖字符串字段,新增字段需同步。
7. **自定义 provider**:不在 `builtInProviders` 中的 provider 无内置模型可列,models 数组按 `[readingModel, lookupModel]` 最小写入,保证列表可显示、tree-manager 可命中。
8. **Windows/权限**:`chmodSync` 在 Windows 为 no-op,文档注明该保证仅对 POSIX 生效。
