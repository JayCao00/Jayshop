# Jayshop 后端

Node.js (Express) + SQLite 商城后端，对外提供商城 API，并代理 **ProdSeller** 供应商接口。
前端静态文件放在 `./public/`（由前端工程师并行开发），由 `express.static` 同源托管。

## 本地运行

```bash
cd ~/workspace/jayshop
npm install

# 可选：复制环境变量模板并按需修改
cp .env.example .env

node server.js        # 或 npm start
```

启动后访问 `http://localhost:3000/api/health`，应返回：

```json
{ "ok": true, "demoMode": true }
```

- 未设置 `PRODSELLER_API_KEY` 时为**演示模式**：商品读取本地真实目录
  `catalog.json`（52 个真实商品，售价(¥) = 成本价(U) × (1 + MARKUP_PCT) × USDT_CNY_RATE；
  文件不存在才回退到 6 个内置演示商品，其价格已是人民币售价），管理员确认发货时直接生成
  `DEMO-KEY-xxxx`。`demoMode=true`（无 key 时无法实时下单/查实时库存）。
- 设置 `PRODSELLER_API_KEY` 后为**真实模式**：商品实时代理 `https://prodseller.com/v1/products`，
  售价(¥) = 成本价(U) × (1 + MARKUP_PCT) × USDT_CNY_RATE，四舍五入保留两位小数。
  成本核算内部始终用 USDT，人民币只做展示与实收记账。

> ⚠️ 首次启动会打印警告：正在使用默认管理员密码 `jayshop-admin`，
> 请务必通过环境变量 `ADMIN_PASSWORD` 修改。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PRODSELLER_API_KEY` | （空） | 供应商 API Key。留空 = 演示模式。**绝不写进代码** |
| `MARKUP_PCT` | `0.30` | 加价率（小数），售价(¥) = 成本价(U) × (1 + MARKUP_PCT) × USDT_CNY_RATE |
| `USDT_CNY_RATE` | `7.2` | USDT→人民币汇率（须 > 0 的数字） |
| `ALIPAY_QR_URL` | （空） | 支付宝收款码图片 URL（未在后台上传文件时回退使用） |
| `ADMIN_PASSWORD` | `jayshop-admin` | 管理后台密码，请务必修改 |
| `BOT_TOKEN` / `CHAT_ID` | （空） | Telegram 新订单通知（可选，两者都配才生效） |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录（`jayshop.db`） |

## API 一览

### 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok:true, demoMode}` |
| GET | `/api/products` | `{demoMode, products:[{id,name,description,price,imageUrl,delivery,inStock,requiresEmailActivation,sold}]}`，`price` 为售价 |
| GET | `/api/products/:id` | `{demoMode, product}`，不存在 → 404 |
| POST | `/api/orders` | 下单，限流 10 次/分钟/IP。请求体 `{productId, quantity, email?, payMethod?}`（`payMethod`: `alipay`(默认) / `usdt`） |
| GET | `/api/orders/:id` | 订单查询（`orderId` 为 UUID，不可猜测，无需登录），含 `payMethod` / `payState` |
| POST | `/api/orders/:id/mark-paid` | 支付宝订单客户标记已付款（multipart：`note` 可选，`screenshot` 可选图片 ≤5MB），限流 10 次/分钟/IP |
| GET | `/api/qr` | 支付宝收款码图片：优先返回后台上传的文件，否则 302 跳转到 `ALIPAY_QR_URL`，都没配则 404 |

下单请求体：`{productId, quantity, email?, payMethod?}`（`requiresEmailActivation` 的商品必须传合法 `email`）。
成功返回 `201 {orderId, status:'pending', totalPrice, payMethod}`，`totalPrice` 为人民币（¥）。
订单详情：`{orderId, status, productName, quantity, totalPrice, payMethod, payState, createdAt, deliveredKey?}`，
其中 `deliveredKey` 仅在 `status === 'delivered'` 时返回。

**支付流程：**
- **支付宝**：下单 → 客户到付款页扫码 → 点"我已付款"（可填昵称/备注、可传截图）→
  订单变为"待确认收款"（同时 Telegram 通知店主，截图也会推一份）→
  店主在支付宝 App 核对到账 → 后台点"确认收款并发货" → 走正常发货流程。
  未标记已付款的支付宝订单不可直接确认（409）。
- **USDT**：下单即 pending，店主确认后直接发货（原有逻辑不变）。

### 管理员接口（两种鉴权方式任选其一）

1. `X-Admin-Password: <密码>` 请求头（前端采用此方式），或
2. 先 `POST /api/admin/login`，后续请求携带 httpOnly cookie（同源默认自动带）。

管理接口另有每 IP 每分钟 60 次的限流（防 header 密码爆破）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | `{password}` → 成功设置 httpOnly cookie（token 存内存，重启失效） |
| GET | `/api/admin/orders` | 订单列表，pending 优先、创建时间倒序（含 `lastError` 字段） |
| POST | `/api/admin/orders/:id/confirm` | 确认发货。支付宝订单要求客户已标记已付款，否则 409 |
| POST | `/api/admin/orders/:id/cancel` | 取消订单（仅 pending） |
| POST | `/api/admin/qr` | 上传/更换支付宝收款码（multipart `qr`，仅图片 ≤2MB） |
| GET | `/api/admin/uploads/:name` | 查看客户付款截图（文件名白名单校验，防路径穿越） |
| GET | `/api/admin/balance` | 供应商 USDT 余额（真实模式实时查询；演示模式返回 `demoMode:true`） |

订单列表中每单展示：实付金额（¥）、USDT 成本（供应商侧）、支付方式、付款状态、客户备注、付款截图入口。

**confirm 行为：**
- 演示模式：直接标记 `delivered`，生成 `DEMO-KEY-xxxx`。
- 真实模式：以本地 `orderId` 为 `Idempotency-Key` 调用供应商 `POST /v1/orders`。
  - 即时返回发货 key → 直接 `delivered`；
  - 返回 `status:'paid'` → 后台每 30 秒轮询供应商订单状态，最多 40 次，
    发货后写入 `deliveredKey`，失败则标记 `failed`；
  - 供应商返回 **402（余额不足）** → **不标记失败**，订单保持 `pending`，
    记录 `lastError='余额不足'`，向管理员返回 402 + 中文提示
    "ProdSeller 余额不足（当前约 0.01 USDT），请充值后再试"，
    店主充值后可直接重试 confirm（幂等，不会重复扣款）；
  - 其他 4xx/5xx → 标记 `failed`。

## 部署

- **Render**：`render.yaml` 已配好免费 web service，`startCommand: npm start`。
  在 Render 控制台手动填入 `PRODSELLER_API_KEY` / `ADMIN_PASSWORD`（`sync: false` 项）。
  注意：免费版磁盘是临时的，`data/` 下的 SQLite 在重新部署/休眠后可能丢失，
  正式环境建议改用 Render Disk 或外部数据库。
- **Docker**：`docker build -t jayshop . && docker run -p 3000:3000 -v jayshop-data:/app/data jayshop`
  （用 volume 持久化 SQLite）。

## 安全说明

- `helmet` 默认安全头；下单、登录与"标记已付款"接口有 `express-rate-limit`；
  管理员鉴权 cookie 为 `httpOnly` + `SameSite=Lax`（`NODE_ENV=production` 时加 `Secure`）。
- 任何响应中**绝不出现** `PRODSELLER_API_KEY`、供应商成本价（USDT）、`ADMIN_PASSWORD`。
  对外商品的 `price` 字段即人民币售价；USDT 成本只在服务端内存/数据库中用于核算，
  仅管理员可见。
- 文件上传：仅允许 PNG / JPG / GIF / WebP（MIME + 扩展名双重校验），
  收款码 ≤2MB、付款截图 ≤5MB，文件名随机化，存于 `data/`（gitignored，不进仓库）；
  截图查看接口校验文件名格式，防路径穿越。
- `.gitignore` 已排除 `node_modules/`、`.env`、`data/`。
