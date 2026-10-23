# Jayshop 调研报告：ProdSeller API 可达性 + 免费托管/域名方案

> 调研时间：2026-10-23（北京时间凌晨）| 方式：curl 直连 + 2026 年最新公开资料核实
> 原则：只读操作，未下单、未使用任何 API key

---

## 1. ProdSeller API 可达性：✅ 正常

| 检查项 | 结果 |
|---|---|
| `GET https://prodseller.com/v1/products`（无 key） | **401**（预期行为：无 key 就该 401，能连通即可） |
| 响应头 | `Server: nginx/1.27.5`，带 `RateLimit-Policy: 3000;w=900` 限流头，确认为 ProdSeller 自有服务 |
| 响应体 | `{"error":"API key manquante (header X-API-Key requis)"}`（法语：缺少 API key，需在 header 传 `X-API-Key`） |
| `GET https://prodseller.com/api-docs/` | **200**，文档页可访问 |
| 异常 | 无 |

**结论**：API 在线、连通正常。正式调用时在请求头加 `X-API-Key` 即可；限流为每 15 分钟 3000 次，足够 MVP 使用。

---

## 2. 免费托管方案排序（目标：Node.js Express + SQLite，免费、今晚可上线、带免费子域名）

### 🥇 首选：Render（注册 friction 最小，今晚就能上线）

- 免费 tier 2026 年仍在：512MB RAM、**无需信用卡**、每月 750 实例小时（≈ 够跑 1 个常开服务）
- 子域名格式：`jayshop.onrender.com`，部署成功即时可用
- 缺点：15 分钟无流量休眠，唤醒约 1 分钟（访问者会看到 loading 页）
- ⚠️ **关键细节**：免费版**没有持久磁盘**，文件系统是 ephemeral 的——**SQLite 文件在休眠/重部署后会丢失**。缓解办法：商品数据从 ProdSeller API 定时重新拉取 seed；用户/订单等关键数据不要只放 SQLite（或每天备份 db 文件）
- 免费 Postgres 也有但 30 天后过期——MVP 阶段直接用 SQLite 即可

**明早 10 分钟上线步骤（精确到点击）：**

1. 浏览器打开 `render.com` → 右上角 **Sign Up** → **Continue with GitHub**（用 GitHub 账号一键登录并授权，无需信用卡）
2. 进入 Dashboard，点右上角 **New +** → **Web Service**
3. 选择 **Public Git repository**（粘贴 jayshop 仓库 URL，最快，免授权）或 Connect GitHub 账号选仓库
4. 配置页填写：
   - **Name**: `jayshop`（即得 `https://jayshop.onrender.com`）
   - **Region**: `Frankfurt`（离欧洲用户/ProdSeller 近）
   - **Branch**: `main`；**Build Command**: `npm install`；**Start Command**: `npm start`
   - **Instance Type**: 选 **Free**
5. 点 **Create Web Service**，等待构建约 2–5 分钟
6. 页面顶部出现绿色 **Live** + 公网 URL，即上线成功
7. 前置要求（代码侧，今晚准备好）：`package.json` 必须有 `"start"` 脚本；服务监听 `process.env.PORT`（不能写死 3000，Render 会动态分配端口）

### 🥈 备选：Railway（SQLite 可持久化，但免费是"试用装"）

- 真相：**没有长期免费 tier**。新账号一次性 **$5 试用额度（30 天有效）**，之后免费计划每月只给 $1 额度——跑不动常开服务
- 优点：试用期内可挂 **0.5GB Volume**，SQLite 数据真正持久化；部署体验流畅；子域名 `xxx.up.railway.app`
- 缺点：GitHub 账号需通过验证，否则是受限试用（无公网）；30 天后必须转 $5/月 Hobby 才能续命
- 步骤：`railway.app` → Login with GitHub → **New Project** → Deploy from repo → **+ New → Volume**（挂载到 `/data`，把 SQLite 路径指向它）→ Settings → Networking → **Generate Domain**
- **适用场景**：如果 MVP 必须保证 SQLite 数据不丢，用 Railway 撑 30 天验证期，跑通后再决定付费

### 🥉 备选：Koyeb（唤醒快，但要信用卡）

- 免费：1 个 web service（512MB/0.1vCPU），1 小时无流量 scale-to-zero，**唤醒仅 1–5 秒**（体验远好于 Render），子域名 `xxx.koyeb.app`，还送免费 Postgres（每月 5 active 小时）
- 致命伤：注册**必须绑信用卡**（$29 预授权 hold）；2026 年 2 月被 Mistral AI 收购，免费政策存在变数
- 今晚无卡可用 → 不作为首选

### ❌ 出局名单（已逐一核实）

| 平台 | 出局原因（2026 年现状） |
|---|---|
| **Glitch** | 2025-07-08 已**彻底停止项目托管**，平台已死 |
| **Fly.io** | 无永久免费 tier，只有试用（2 小时机时或 7 天），之后必须绑卡按量付费 |
| **Vercel** | 官方知识库明确 "**SQLite can't be used with Vercel**"：serverless 无持久本地文件系统，`/tmp` 随调用丢弃。想上 Vercel 得换 Turso（libSQL）——要改代码，不适合今晚 |

### 🔭 以后重构可考虑（今晚不碰）

- **Cloudflare Workers + D1**：D1 是 SQLite 兼容的 serverless 数据库，免费额度慷慨，但需把 Express 改写成 Workers/Hono 形式——适合跑通后的架构升级
- 小众平台（Hubfly/SnapDeploy 有免费容器小时）生态太小，不推荐

---

## 3. 域名真相

### jayshopai.com 是否被注册？
- 沙箱内 WHOIS/RDAP 查询通道被拦截（rdap.org、whois.com 均不可达），**无法 100% 确证**
- HTTPS 探测行为与已知未注册域名一致，**倾向尚未被占用**
- **但这不重要**：.com 不可能免费，无论是否被注册都要花钱买。明天在 Porkbun/Cloudflare 搜索框亲手确认即可（30 秒的事）

### .com 现在多少钱（2026 年 10 月实价）
- 成本价 **$10.46/年**（Verisign 批发价；**2026-11-01 起涨到 $11.17**，早买早锁价）
- Cloudflare Registrar：$10.46（成本价，但要求用它家 DNS）
- Porkbun：~$10.3–11.08/年，免费隐私保护，checkout 干净——**综合最推荐**
- Namecheap：~$11.28 首年 / $18.48 续费
- GoDaddy：续费 $22.99/年——**避坑**

### eu.org 免费域名现状
- 仍在运作、仍免费，但**人工审核要数周到数月**——远水解不了近渴，今晚指望不上

### 结论排序
- **(a) 今晚就用**：Render 免费子域名 `jayshop.onrender.com` 上线验证，零成本、零等待
- **(b) 跑通后再花钱**：花 ~$10–11 在 Porkbun 买个域名（不一定死磕 jayshopai.com，`jayshop.store` / `getjayshop.com` 这类便宜好记的也可以），Render 免费版支持绑 2 个自定义域名，切换只需改 DNS

---

## 4. 临时公网 URL 验证（加分项）：✅ 可行

- `npx -y localtunnel`：本机 Node v24 + npm registry 畅通，**localtunnel 2.0.2 安装包可正常下载**——无账号 Linux VM 可直接拿到临时公网 URL（装包验证通过，未实际跑隧道）
- **cloudflared Quick Tunnels**：Cloudflare 2026 年 10 月官方博客确认**依然免账号、免费**（`cloudflared tunnel --url http://localhost:3000` 即得 `xxx.trycloudflare.com`），还新增了 `--allowed-mail` 邮箱白名单保护模式
- 结论：本地开发时一条命令就有公网 URL，今晚联调 webhook 或给人看 demo 完全够用

---

## 5. 核心结论（一句话）

> **ProdSeller API 可达（401 正常）；今晚用 Render 免费 tier 上线 `jayshop.onrender.com`（GitHub 登录、无需信用卡，10 分钟搞定）；接受 SQLite 在免费版不持久、靠 ProdSeller API 重 seed 的折中；域名以后花 ~$10 在 Porkbun 买，eu.org 指望不上，Glitch 已死、Vercel 跑不了 SQLite。**
