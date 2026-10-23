# Jayshop 建站 — BUILD_NOTES

> 最后更新：2026-10-23 02:45（北京时间）
> 目标：明早 8 点前交付可公开访问的卖货网站

## 0. 本轮新增（2026-10-23 凌晨）：支付宝收款 + 人民币定价 ✅

### 支付宝收款
- 下单页支付方式二选一：**支付宝**（默认）/ USDT。
- 选支付宝：下单后进付款页，展示店主支付宝收款码（`GET /api/qr`），客户扫码 → 填昵称/备注（可选）→ 传付款截图（可选，≤5MB）→ 点"我已付款"。
- 客户标记后：订单变"待确认收款"，Telegram 同时收到文字+截图通知；店主在支付宝 App 核对到账后，管理后台点"确认收款并发货" → 走原有 confirm 流程调 ProdSeller。
- 未标记已付款的支付宝订单不可直接确认（409）；USDT 订单逻辑不变。
- 收款码来源优先级：管理后台上传的文件（`data/alipay_qr.*`）> 环境变量 `ALIPAY_QR_URL` > 未设置（付款页提示联系店主）。后台可随时上传更换（图片 ≤2MB）。
- 付款截图存 `data/uploads/`（随机文件名），仅管理员可查看（文件名白名单防路径穿越）；截图也会推一份到 Telegram 留底（data/ 在免费托管上是临时的）。

### 人民币定价
- 新增 `USDT_CNY_RATE`（默认 7.2）：售价(¥) = 成本(U) × (1 + MARKUP_PCT) × USDT_CNY_RATE，四舍五入 2 位小数。
- 前端全部 ¥ 展示；成本核算内部仍用 USDT：订单表新增 `unit_cost_usdt` / `total_cost_usdt`，管理后台每单展示"实付 ¥X · 成本 Y USDT"。
- 管理后台新增供应商余额显示（USDT，真实模式实时查；演示模式显示"演示模式"）。
- 内置演示商品价格已是人民币，不再二次换算。

### 测试
- 40 项冒烟测试全部通过：回归（健康/商品/下单校验/限流/admin/确认/402）+ 新增（支付宝下单→标记→确认全链路、收款码上传校验 400/413/401、截图鉴权/路径穿越、成本字段、余额接口、人民币定价公式 0.55×1.3×7.2=¥5.15）。
- 内联前端 JS 全部 `node --check` 通过；`GET /api/qr` 环境变量回退（302）已验证。

## 1. 当前状态：代码 100% 完成 ✅

- 仓库位置：`~/workspace/jayshop/`
- 技术栈：Node.js 20 + Express + better-sqlite3，后端同源托管纯静态前端（零构建）
- 前端：`public/`（7 文件，苹果官网式极简风：纯白/#f5f5f7、#1d1d1f、#0071e3，移动端优先，中文）
- 后端：`server.js` + `lib/`（db.js / prodseller.js / notify.js）
- 真实商品：`catalog.json`（52 个商品，7 个无库存，2 个需邮箱激活）
- 本地冒烟测试（2026-10-23 02:15）**全部通过**：
  - `GET /api/health` → `{ok:true, demoMode:true}`
  - `GET /api/products` → 52 商品，售价 = 成本×1.3（如 0.55→0.72），字段白名单（无成本价/无 key 泄漏）
  - 下单校验：缺邮箱→400、售罄→409、非法数量→400、不存在→404；正常下单 201（totalPrice 正确）
  - 下单限流：10 次/分钟/IP（第 11 次 429）
  - 管理链路：header 鉴权 + cookie 鉴权均可用；演示 confirm → delivered + `DEMO-KEY-xxxx`；客户轮询查到卡密
  - 402 全链路（stub 供应商）：confirm → 402 中文提示"余额不足，请充值后再试"，订单保持 pending 可重试
  - 邮箱必填商品无邮箱下单 → 400；售罄商品下单 → 409

## 2. 安全设计（已落实）

- ProdSeller key 只从环境变量 `PRODSELLER_API_KEY` 读，代码/前端/仓库中无真实 key（已 grep 验证）
- 成本价永不返回给前端；订单 ID 为不可猜的 UUID
- 下单接口：手动履约流程（客户下单 → pending → 店主在 admin 页确认 → 后端调供应商），无无鉴权直接下单；下单限流防刷
- `Idempotency-Key` 使用本地 orderId 防重单
- admin：密码保护（`X-Admin-Password` 头 + httpOnly cookie 双通道），管理接口 60 次/分钟/IP 限流
- `.env.example` + `.gitignore`（node_modules、.env、data/）齐全

## 3. 阻塞点（全部需要用户明早动手，共约 10 分钟）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **托管账号** | 需用户的 GitHub + Render 账号（免费，无需信用卡） |
| 2 | **API Key** | `PRODSELLER_API_KEY` 填入 Render 环境变量（用户从 Telegram bot 获取） |
| 3 | **改默认密码** | `ADMIN_PASSWORD` 默认 `jayshop-admin`，上线前必须改 |
| 4 | **余额不足** | ProdSeller 余额仅 **0.01 USDT**，真实下单会 402；网站照常上线，店主充值后在 admin 页重试即可 |
| 5 | **公网 URL** | 本机沙箱出口代理限制，localtunnel/cloudflared 隧道均无法建立——**今晚拿不到临时公网 URL**；明早按下面步骤部署 Render 即得 `https://jayshop.onrender.com` |

## 4. 明早精确操作步骤（Render，约 10 分钟）

1. 把 `~/workspace/jayshop/` 推到 GitHub：新建空仓库（如 `jayshop`），`git init && git add -A && git commit -m init && git remote add origin <仓库地址> && git push -u origin main`（注意：`.env` 不会被提交，`.gitignore` 已配好）
2. 打开 `render.com` → **Sign Up** → **Continue with GitHub**（一键登录，无需信用卡）
3. Dashboard 右上角 **New +** → **Web Service**
4. 选 **Public Git repository**，粘贴第 1 步的仓库 URL → **Continue**
5. 配置页：Name 填 `jayshop`（即得 `https://jayshop.onrender.com`）；Region 选 `Frankfurt`；Build Command `npm install`；Start Command `npm start`；Instance Type 选 **Free**（`render.yaml` 已预填好这些，大部分会自动带出）
6. **Environment** → **Add Environment Variable**，逐个添加：
   - `PRODSELLER_API_KEY` = 你的 ProdSeller key（必填，否则是演示模式）
   - `MARKUP_PCT` = `0.30`（加价 30%，可改）
   - `USDT_CNY_RATE` = `7.2`（USDT→人民币汇率，售价¥=成本U×1.3×7.2）
   - `ADMIN_PASSWORD` = 你自设的管理密码（必填，别用默认的）
   - `BOT_TOKEN` / `CHAT_ID` = Telegram 机器人 token 和接收 chat ID（可选，不填则只用 admin 页看单）
   - `ALIPAY_QR_URL` = 支付宝收款码图片 URL（可选；更推荐上线后直接在管理后台上传）
7. 点 **Create Web Service**，等 2–5 分钟构建，顶部出现绿色 **Live** 即上线
8. 验证：打开 `https://jayshop.onrender.com`（应看到 52 个真实商品、无演示横幅）→ 打开 `/admin.html` 用新密码登录
9. **上线后第一件事**：在管理后台"支付宝收款码"卡片上传你的支付宝个人收款码（否则客户付款页无码可扫）
10. 去 ProdSeller 充值余额（否则真实下单报 402；网站本身不受影响）

## 5b. 2026-10-23 部署修复（Render Docker 构建失败）

- 现象：`RUN npm install --omit=dev` exit 1。根因：better-sqlite3@13 安装时从源码编译（node-gyp），而 `node:20-slim` 缺 python3/make/g++ 工具链。
- 修复：Dockerfile 在 npm install 之前加装工具链（`apt-get install -y python3 make g++`）。用户侧只需更新仓库里的 Dockerfile 后重新 push，Render 自动重建。
- **后续（同日 14:2x）**：首页商品列表一直显示灰色骨架屏。根因：helmet 默认 CSP（`script-src 'self'` 无 `'unsafe-inline'`）拦截了所有页面行内 `<script>`，导致页面逻辑从未执行；且 `img-src 'self' data:` 会拦外部商品图。修复：server.js 中配置 helmet CSP，放开 `script-src 'unsafe-inline'`、`script-src-attr 'unsafe-inline'`、`img-src https:`，其余保持默认。用户侧需更新 server.js 后重推。
- **后续（同日 14:0x）**：构建通过但运行时 `Segmentation fault (exit 139)`——v13 在 slim 镜像里现场编译出的 binding 加载即崩。改用 better-sqlite3@11.10.0（有 Node 20 linux-x64 官方预编译包，无需编译，API 与现有代码完全兼容）。package.json + package-lock.json 已同步，用户侧只需改 package.json 里版本号后重推。

## 5. 已知限制与后续建议

- **Render 免费版 15 分钟无流量会休眠**（唤醒约 1 分钟）；**无持久磁盘**，休眠/重部署后 SQLite 订单数据会丢失——缓解：新订单会经 Telegram 通知店主（配了 BOT_TOKEN 时），商品数据每次从 ProdSeller API 重拉不受影响
- 长期建议：跑通后在 Porkbun 花 ~$10.5/年买个 `.com` 域名绑到 Render（免费版支持绑 2 个自定义域名）；订单量大了再考虑付费磁盘或外部 Postgres
- `eu.org` 免费域名审批要数周，不指望
- 轮询说明：`requiresEmailActivation` 的商品（如 Canva Pro 2 年版）供应商先返回 paid，后端每 30 秒轮询最多 20 分钟，delivered 后客户在订单页自动看到卡密

## 5c. 2026-10-23 自定义售价功能（用户需求：偶尔大调一两次价格）

- 新增 `price_overrides(product_id PK, price_cny, updated_at)` 表（lib/db.js）。
- server.js：`priceOverrideMap()` + `applyPriceOverride()`；`getCatalog()`、`getProduct()`、下单接口统一应用自定义价（有则覆盖，无则走公式）。
- 新增管理接口：`GET /api/admin/products`（成本/公式价/自定义价/当前售价一览）、`POST /api/admin/products/:id/price`（设价；price 为空则清除恢复公式价）。
- admin.html：新增"🏷️ 商品定价"卡片，逐行显示成本/公式价，输入框设固定价，"恢复公式价"按钮清除。
- 限制：自定义价存 SQLite，重建丢失（已告知用户）。价格校验：>0 且 ≤9999999，保留 2 位小数。

## 6. 文件清单

```
~/workspace/jayshop/
├── server.js            # Express 主入口（API 路由/鉴权/限流/轮询）
├── lib/
│   ├── db.js            # SQLite 初始化（WAL）
│   ├── prodseller.js    # 供应商客户端 + 本地目录 + 售价映射
│   └── notify.js        # Telegram 新订单通知
├── public/              # 前端（index/product/pay/order/admin/404.html + app.js + styles.css，苹果极简风）
├── catalog.json         # 52 个真实商品目录（无 key 时的商品源）
├── package.json / package-lock.json
├── .env.example / .gitignore
├── render.yaml          # Render 一键部署配置
├── Dockerfile           # node:20-slim 备用部署
├── README.md            # 本地运行说明
├── research/HOSTING_RESEARCH.md  # 托管/域名调研原文
└── BUILD_NOTES.md       # 本文件
```
