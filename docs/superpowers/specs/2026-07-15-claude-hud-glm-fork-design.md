# claude-hud-glm Fork 设计

> 状态：设计草案 ｜ 日期：2026-07-15 ｜ 基于上游 claude-hud 0.4.2（commit `5555a1d`）

## Context

claude-hud 是纯被动展示层（零依赖、无 HTTP、无 provider 抽象），原生只支持 Anthropic 的成本/配额语义。GLM（智谱）下：token 计数与 context 进度条已可用，但智谱套餐的 5h/7d token 配额用量无数据来源。

之前的解法是"external-usage 外挂"（Python feeder + cron + `.env`），单机可用但**多机部署成本高**：每台机器要装 feeder + 配 config + 装 cron + 同步 key，且无上下文时要重新解释整套机制。

本 fork 把智谱支持直接改进 claude-hud，利用 statusLine 子进程**继承 Claude Code 环境**的特性（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 天然可用），实现**每台机器零额外配置**——只要 Claude Code 配好了 GLM，fork 版自动拉 usage。新机器仅 `/plugin marketplace add hugo2046/claude-hud-glm` + `/plugin install` 一步到位。

## 目标 / 非目标

**目标**
- GLM 用户在 HUD 看到 `Usage ██░░ XX% (5h) | ░░ XX% (7d) | <level>`（智谱套餐配额）
- 每台 GLM 机器装 fork 后零额外配置（无 `.env` / cron / feeder）
- 对非 GLM 用户零影响（`isZhipuProvider=false` 时整段跳过）
- 渲染层零改动（复用 claude-hud 原生 usage 渲染）
- 零新增运行时依赖（Node 18+ 原生 `fetch`）

**非目标**
- 不做 provider 抽象（YAGNI；现在只支持智谱，以后要加别的厂商再重构）
- 不监控账户现金余额（智谱无公开 API；本方案监控的是 token 配额窗口）
- 不改 claude-hud 的其他显示（cost / context / 工具活动等保持原样）
- v1 仅支持智谱**个人版**（团队版需 `bigmodel-organization` / `bigmodel-project`，statusLine 环境通常无此值；留作后续）

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 显示形态 | 进度条 + 等级标注 | `fiveHour`/`sevenDay` 用原生进度条（视觉好），`balanceLabel` 塞套餐等级（信息全） |
| 实现深度 | 硬编码智谱（独立文件） | YAGNI；现在只 GLM，不建 provider 抽象 |
| 分发 | GitHub 公开 repo + marketplace | 一步装、可回馈社区、可给上游提 PR |
| 缓存策略 | TTL 4min + fetch 5s 超时 + 旧缓存兜底 | statusLine 高频刷新不能每次 HTTP；缓存优先 |
| 接入方式 | `await fetch`（main 已 async） | `index.ts:56` `main` 本就是 async，零障碍 |

## 架构

fork claude-hud，**数据层加智谱 provider，渲染层零改动**。

```
statusLine 刷新 (main async) → index.ts 组装 usageData
  ├─ stdin.rate_limits 有数据 → 用 stdin（上游逻辑不变）
  └─ 否则 isZhipuProvider(env)?
       → getZhipuUsage:
            读 glm-quota.json 缓存
            ├─ 新鲜(<4min) → 返回缓存（同步路径，~99%）
            └─ 过期 → await fetch monitor (5s 超时)
                 ├─ 成功 → parseZhipuTiers + 原子写缓存 + 返回
                 └─ 失败 → 返回旧缓存（或 null）
       → 填 {fiveHour, sevenDay, balanceLabel: level}
  → render(ctx)（零改动）→ Usage ██░░ XX% | ░░ XX% | max
```

**智谱 monitor 接口**（未公开，已实测可达）：
- `GET {host}/api/monitor/usage/quota/limit`，host 从 `ANTHROPIC_BASE_URL` 推导（取 `scheme://netloc`，含 `bigmodel.cn` → `open.bigmodel.cn`、`z.ai` → `api.z.ai`）
- Header：`Authorization: <api_key>`（**不加 Bearer**）、`Content-Type: application/json`、`Accept-Language: en-US,en`
- 响应 `data.limits[type=TOKENS_LIMIT]`：`unit=3` → 5h 窗口、`unit=6` → 7d 窗口、`percentage`、`nextResetTime`(ms)；`data.level` = 套餐等级

## 组件

### 新增

**`src/providers/zhipu.ts`** — 智谱 provider 核心
- `isZhipuProvider(env): boolean` — `ANTHROPIC_BASE_URL` 含 `bigmodel.cn` / `z.ai`
- `getZhipuCredentials(env): { apiKey, host }` — 读 `ANTHROPIC_AUTH_TOKEN` / `ZHIPUAI_API_KEY`；host 从 base_url 推导；非官方域名抛错
- `fetchZhipuQuota(host, apiKey, { timeoutMs=5000 }): Promise<ZhipuData>` — 原生 `fetch` + `AbortController` 超时
- `parseZhipuTiers(data): { fiveHour, sevenDay, level }` — 移植 feeder 的 Python 逻辑→TS：`unit=3`→fiveHour、`unit=6`→sevenDay、unit 缺失按 `nextResetTime` 升序兜底、单条降级；`level` 取 `data.level`
- `getZhipuUsage(env, now, deps): Promise<UsageData | null>` — 主入口：缓存优先，过期 fetch，失败兜底；返回 `{fiveHour, sevenDay, fiveHourResetAt, sevenDayResetAt, balanceLabel: level}`

**`src/glm-quota-cache.ts`** — 缓存（照模板）
- 文件：`getHudPluginDir(homeDir)/glm-quota/glm-quota.json`
- TTL：`GLM_QUOTA_TTL_MS = 240_000`（4min）
- `read(homeDir, now): CachedQuota | null` — 读 + `now - savedAt > TTL` 判新鲜（仿 `external-usage.ts:280-283`）
- `write(homeDir, data, deps)` — tmp+rename 原子写，mode `0o600`（仿 `external-usage.ts:216-261`）
- deps 注入（fs，仿 `context-cache.ts:43-53` 便于测试）

### 修改

**`src/index.ts`**
- `MainDeps`（:21-39）加字段 `getZhipuUsage`
- `:147` 后（usageData 组装段结尾）插入：
  ```ts
  if (shouldReadUsage && !usageData && isZhipuProvider(process.env)) {
    usageData = await deps.getZhipuUsage(process.env, deps.now());
  }
  ```
- import 加 `getZhipuUsage, isZhipuProvider` from `./providers/zhipu.js`；defaultDeps 绑定

**`.claude-plugin/plugin.json` + `marketplace.json`**
- plugin.json：`name`→`claude-hud-glm`、`version`、`author.url`、`homepage`、`repository`（→ `github.com/hugo2046/claude-hud-glm`）
- marketplace.json：顶层 `name`、`owner`、`plugins[0].name`（与 plugin.json 一致）、`metadata.version`

**`package.json`** — `name`→`claude-hud-glm`（version 与 plugin.json 同步，`RELEASING.md` 强制）

**`README.md`** — 加 GLM 支持段 + 安装说明（`/plugin marketplace add hugo2046/claude-hud-glm`）

## 复用的现有约定

| 约定 | 来源 | 复用点 |
|------|------|--------|
| hud-plugin-dir 定位 | `claude-config-dir.ts:25-27` | glm-quota 缓存路径 |
| 缓存读 + 判新鲜 | `external-usage.ts:263-316, 280-283` | glm-quota-cache.read |
| tmp+rename 原子写 | `external-usage.ts:216-261` | glm-quota-cache.write |
| deps 注入测试 | `context-cache.ts:43-53` | 两个新模块的 deps |
| usageData 组装/合并 | `index.ts:116-147` | 智谱 hook 插入点（:147 后） |
| balanceLabel 渲染 | `render/lines/usage.ts:35-39,148-149`；`session-line.ts:268-272` | level 塞 balanceLabel，零渲染改动 |
| MainDeps 模式 | `index.ts:21-39` | `getZhipuUsage` 作为 dep |
| main try/catch 兜底 | `index.ts:192-197` | provider 抛错不崩 HUD |

## 错误处理

- `main` 已有 try/catch（`index.ts:192-197`）：智谱 provider 任何抛错 → 打印 `[claude-hud] Error:` + 不崩 HUD
- fetch 超时 / 网络失败 → 返回旧缓存（不覆盖）
- 接口改版 / 解析失败 → 旧缓存 + debug log（`createDebug`）
- 非智谱机器 → `isZhipuProvider=false` 整段跳过，对上游行为零影响
- 凭证缺失 → `getZhipuCredentials` 抛错被 main catch，`usageData=null`（HUD 不显示 usage 行）
- 缓存文件损坏 → read 返回 null，下次 fetch 重建

## 测试（照 `tests/` 现有风格）

**`tests/providers/zhipu.test.js`**
- `isZhipuProvider`：`bigmodel.cn` / `z.ai` / 中转域名 / 空 base_url
- `parseZhipuTiers`：`unit=3/6` 主路径 + unit 缺失兜底 + 单条降级 + 0 条 + level
- `getZhipuUsage`：缓存命中（mock fs）、过期 fetch 成功（mock fetch + fs）、fetch 失败用旧缓存（mock fetch throw）

**`tests/glm-quota-cache.test.js`**
- read：新鲜 / 过期 / 损坏 / 缺失
- write：原子写 + mode `0o600`

## 默认决策

- **上游 merge**：isolation-friendly（新增 2 文件 + `index.ts` 一处 hook），`git merge upstream/main` 冲突概率低，不强制定期 merge
- **现有外挂**（`~/.claude/plugins/claude-hud/feeder`）：fork 装好验证后拆掉（删 cron 行 + feeder 目录）；fork 不需要 `.env`（环境继承）
- **config 开关**：复用 `showUsage`，不单独加 `showGlmQuota`（YAGNI）
- **缓存 TTL**：240000ms（4min）；**fetch 超时**：5000ms

## 安全与隐私（硬约束）

fork 推公开 GitHub（`hugo2046/claude-hud-glm`），**零密钥零敏感信息**是硬约束，实施全程必须维持：

- **代码零硬编码**：智谱凭证只从环境变量读（`ANTHROPIC_AUTH_TOKEN` / `ZHIPUAI_API_KEY`），任何源码/配置/文档不写死 key。运行时 statusLine 继承 Claude Code 环境拿 key，仓库内不存 key。
- **测试 fixture 必须合成**：`parseZhipuTiers` / `fetchZhipuQuota` 的测试用**编造的合成值**（如 `percentage: 42`、`level: "test"`、`nextResetTime: 1784102030306` 这类不泄露真实用量的数）。**禁止粘贴真实 API dump**——真实账户的配额快照（`level`/`percentage`/`nextResetTime`）属隐私，不得进仓库。
- **文档占位符**：README/示例用 `YOUR_API_KEY` / `<your-api-key>` 占位，不贴真实 key 或真实账户数据。
- **.gitignore 已覆盖**（上游 claude-hud）：`.env`、`.env.*`、`.claude/settings.json`、`.claude/*.local.json`、`*.pem`、`*.key`、`secrets/`、`credentials/` 均已忽略；新增 `glm-quota` 缓存位于 `~/.claude/plugins/claude-hud/glm-quota/`（仓库外），不进仓库。
- **外挂 `.env` 一并清理**：现有外挂（`~/.claude/plugins/claude-hud/feeder/.env`，含从 `settings.json` 同步的真实 key）在 fork 验证通过后随 feeder 目录整体删除，不残留含 key 的文件。
- **实施时 commit 前 secret-scan**：每次提交前跑 `rg -E "sk-[A-Za-z0-9]{16,}|gh[opsr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9]{20,}"` 复核；必要时用 `git-secrets` / GitHub secret scanning 双保险，确保 git 历史零泄漏。
- **已验证现状**（2026-07-15 扫描）：fork 仓库跟踪文件无 key / 敏感文件名，spec 无真实账户数据残留。

## 验证

1. `npm ci && npm run build && npm test` 全绿（含新测试）
2. `dist/index.js` 重新编译存在
3. 本地切到 fork 版 statusLine（settings.json 命令指向 fork `dist/index.js`），重启 Claude Code
4. HUD 出现 `Usage ██░░ XX% (5h) | ░░ XX% (7d) | max`
5. 非 GLM 机器（base_url 非 `bigmodel.cn`）确认 usage 行走原逻辑（回归）
6. 断网 / 改错 key：确认用旧缓存或整段消失，不崩 HUD
7. `git tag vX.Y.Z` 触发 `.github/workflows/release.yml`，GitHub release 含 `dist/`
8. 另一台 GLM 机器 `/plugin marketplace add hugo2046/claude-hud-glm` + `/plugin install claude-hud-glm` 验证一步装

## 风险

- 智谱 monitor 接口未公开，可能改版 → 解析失败用旧缓存兜底，不崩；改版时只改 `parseZhipuTiers`
- 第三方中转 GLM 不可达（仅 `bigmodel.cn` / `api.z.ai`）→ `isZhipuProvider` 已排除中转
- statusLine 同步流程 + fetch 延迟 → 5s 超时 + 缓存优先（99% 同步路径），最坏单次刷新慢 5s
- 团队版账号（需 org/project）→ v1 仅个人版；团队版可通过额外环境变量支持（留口，不在 v1 范围）
