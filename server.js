'use strict';

/**
 * Jayshop 商城后端
 * Express + SQLite，对外提供商城 API，并代理 ProdSeller 供应商接口。
 * 前端静态文件由另一位工程师放在 ./public，下面的 express.static 负责托管。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { initDb } = require('./lib/db');
const {
  isDemoMode,
  DEMO_PRODUCTS,
  loadLocalCatalog,
  toPublicProduct,
  fetchCatalog,
  fetchProduct,
  createOrder: psCreateOrder,
  fetchOrder: psFetchOrder,
  extractDeliveredKey,
} = require('./lib/prodseller');
const { notifyNewOrder, notifyPaidClaimed, notifyPaidClaimedPhoto } = require('./lib/notify');

// ---------------- 配置 ----------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let MARKUP_PCT = parseFloat(process.env.MARKUP_PCT ?? '0.30');
if (!Number.isFinite(MARKUP_PCT) || MARKUP_PCT < 0) {
  console.warn('[jayshop] MARKUP_PCT 配置无效，已回退为 0.30');
  MARKUP_PCT = 0.30;
}
// USDT→人民币汇率：售价(¥) = 成本(U) × (1 + MARKUP_PCT) × USDT_CNY_RATE
let USDT_CNY_RATE = parseFloat(process.env.USDT_CNY_RATE ?? '7.2');
if (!Number.isFinite(USDT_CNY_RATE) || USDT_CNY_RATE <= 0) {
  console.warn('[jayshop] USDT_CNY_RATE 配置无效，已回退为 7.2');
  USDT_CNY_RATE = 7.2;
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jayshop-admin';
const DEMO = isDemoMode();
const ADMIN_COOKIE = 'jayshop_admin';
// 支付宝收款码：优先使用店主在管理后台上传的文件（data/alipay_qr.*），
// 其次回退到环境变量 ALIPAY_QR_URL 指向的外部图片地址。
const ALIPAY_QR_URL = (process.env.ALIPAY_QR_URL || '').trim();
// 币安内部转账 UID（USDT 付款用）：客户通过币安 App 内"UID 转账"付款到此 UID。
// 在 Render 环境变量 BINANCE_UID 中设置；未设置时 USDT 付款页会提示联系店主。
const BINANCE_UID = (process.env.BINANCE_UID || '').trim();
// 店主联系方式：前台"联系店主"悬浮窗展示；QQ 填纯数字，Telegram 填用户名（可带 @，会自动去掉）
const CONTACT_QQ = (process.env.CONTACT_QQ || '').trim();
const CONTACT_TELEGRAM = (process.env.CONTACT_TELEGRAM || '').trim().replace(/^@/, '');
// 店铺公告：前台顶部横幅展示；优先用后台设置的值，未设置过则用环境变量 ANNOUNCEMENT
const ANNOUNCEMENT_ENV = (process.env.ANNOUNCEMENT || '').trim().slice(0, 200);
// 热门商品（首页"🔥热门"分类）：优先用后台设置的值，未设置过则用环境变量 FEATURED_IDS，
// 都没有则用默认 4 款（Gemini Pro、Duolingo、Apple TV、Muse AI）。
const FEATURED_IDS_DEFAULT =
  '6a31035939dc014325da2c66,6aa5bafb77c587d75cbe2a8e,6abeace70dbb401865ffb2d2,6ac65a53d07e0053469f477d';
function parseFeaturedIds(raw) {
  const set = new Set();
  try {
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
    for (const s of arr) {
      const t = String(s).trim();
      if (t) set.add(t);
    }
  } catch {
    /* 忽略 */
  }
  return set;
}
function getFeaturedIds() {
  try {
    if (typeof stmts !== 'undefined' && stmts.getSetting) {
      const row = stmts.getSetting.get('featured_ids');
      if (row && row.value !== undefined && row.value !== null) {
        const arr = JSON.parse(String(row.value));
        // 后台设置过（即使是空数组）就以它为准；空数组 = 取消全部热门
        if (Array.isArray(arr)) return parseFeaturedIds(arr);
      }
    }
  } catch {
    /* 忽略，转用环境变量 */
  }
  const env = (process.env.FEATURED_IDS || '').trim();
  return parseFeaturedIds(env || FEATURED_IDS_DEFAULT);
}
/** 标记热门商品（首页"热门"分类用；同时保留其关键词分类） */
function applyFeatured(pub) {
  if (getFeaturedIds().has(String(pub.id))) pub.featured = true;
  return pub;
}
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  [jayshop] 正在使用默认管理员密码 "jayshop-admin"，请尽快通过环境变量 ADMIN_PASSWORD 修改！');
}
if (DEMO) {
  console.log('[jayshop] 未检测到 PRODSELLER_API_KEY，进入演示模式（demoMode=true）。');
} else {
  console.log('[jayshop] 已连接 ProdSeller 真实模式。');
}

// ---------------- 应用 ----------------
const app = express();
app.set('trust proxy', 1); // Render / 反向代理后取真实 IP 做限流
// helmet 默认 CSP 会拦截页面内的 inline <script>（本站所有页面逻辑都写在
// 行内 script 里）以及外部商品图片，这里放开这两项，其余保持默认收紧。
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
    },
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ---------------- 数据库 ----------------
const db = initDb(DATA_DIR);
// 轻量迁移：老数据库补 last_error / 支付相关字段
try {
  const cols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
  const need = {
    last_error: 'TEXT',
    pay_method: `TEXT NOT NULL DEFAULT 'usdt'`,
    pay_state: `TEXT NOT NULL DEFAULT 'unpaid'`,
    pay_note: 'TEXT',
    screenshot_path: 'TEXT',
    unit_cost_usdt: 'REAL',
    total_cost_usdt: 'REAL',
  };
  for (const [col, type] of Object.entries(need)) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
      console.log(`[jayshop] 数据库迁移：orders 表新增 ${col} 字段`);
    }
  }
} catch (e) {
  console.warn('[jayshop] 数据库迁移检查失败：', e.message);
}
const stmts = {
  insertOrder: db.prepare(`
    INSERT INTO orders
      (order_id, product_id, product_name, quantity, unit_price, total_price,
       email, pay_method, unit_cost_usdt, total_cost_usdt,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`),
  getOrder: db.prepare(`SELECT * FROM orders WHERE order_id = ?`),
  listOrders: db.prepare(`
    SELECT * FROM orders
    ORDER BY (status = 'pending') DESC, created_at DESC`),
  setDelivered: db.prepare(`
    UPDATE orders SET status = 'delivered', delivered_key = ?,
      prodseller_id = COALESCE(?, prodseller_id), last_error = NULL,
      updated_at = ? WHERE order_id = ?`),
  setFailed: db.prepare(`
    UPDATE orders SET status = 'failed', last_error = NULL,
      updated_at = ? WHERE order_id = ?`),
  setCancelled: db.prepare(`
    UPDATE orders SET status = 'cancelled', last_error = NULL,
      updated_at = ? WHERE order_id = ?`),
  setProdsellerId: db.prepare(`
    UPDATE orders SET prodseller_id = ?, updated_at = ? WHERE order_id = ?`),
  setLastError: db.prepare(`
    UPDATE orders SET last_error = ?, updated_at = ? WHERE order_id = ?`),
  markPaid: db.prepare(`
    UPDATE orders SET pay_state = 'paid_claimed', pay_note = ?,
      screenshot_path = ?, updated_at = ? WHERE order_id = ?`),
  // 自定义售价（人民币固定价）
  getOverrides: db.prepare(`SELECT product_id, price_cny FROM price_overrides`),
  setOverride: db.prepare(`
    INSERT INTO price_overrides (product_id, price_cny, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      price_cny = excluded.price_cny, updated_at = excluded.updated_at`),
  clearOverride: db.prepare(`DELETE FROM price_overrides WHERE product_id = ?`),
  // 通用设置
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, updated_at = excluded.updated_at`),
};

/** 环境变量价格底稿：PRICE_OVERRIDES 为 JSON 字符串，如 {"商品id": 29.9}。
    重建后自动恢复这些价格；后台修改立即生效，但重建后会恢复为这里的值
    （除非同步更新环境变量）。解析失败则忽略。 */
function getEnvPriceOverrides() {
  const out = {};
  try {
    const raw = (process.env.PRICE_OVERRIDES || '').trim();
    if (!raw) return out;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return out;
    for (const k of Object.keys(obj)) {
      const n = Number(obj[k]);
      if (k && Number.isFinite(n) && n > 0) out[k] = Math.round(n * 100) / 100;
    }
  } catch {
    /* 忽略，返回空 */
  }
  return out;
}
const ENV_PRICED_IDS = new Set(Object.keys(getEnvPriceOverrides()));
// 启动时用环境变量底稿恢复自定义价格（REPLACE：重建后以环境变量为准）
try {
  if (ENV_PRICED_IDS.size > 0) {
    const envPrices = getEnvPriceOverrides();
    const now = new Date().toISOString(); // 注意：nowIso() 在下方才定义，此处直接取值
    for (const pid of ENV_PRICED_IDS) stmts.setOverride.run(pid, envPrices[pid], now);
    console.log(`[jayshop] 已从 PRICE_OVERRIDES 恢复 ${ENV_PRICED_IDS.size} 个自定义价格`);
  }
} catch (e) {
  console.error('[jayshop] 恢复环境变量价格失败:', e.message);
}

/** 币安 UID：优先用后台设置的值，未设置过则用环境变量 BINANCE_UID */
function getBinanceUid() {
  try {
    const row = stmts.getSetting.get('binance_uid');
    if (row && row.value && String(row.value).trim()) return String(row.value).trim();
  } catch {
    /* 忽略，转用环境变量 */
  }
  return BINANCE_UID;
}

/** 读取全部自定义售价：{ productId: priceCny } */
function priceOverrideMap() {
  const m = {};
  try {
    for (const r of stmts.getOverrides.all()) {
      const v = Number(r.price_cny);
      if (Number.isFinite(v) && v > 0) m[r.product_id] = Math.round(v * 100) / 100;
    }
  } catch {
    /* 表不存在等异常时视为无自定义价 */
  }
  return m;
}

/** 对外公开商品应用店主自定义价（有则覆盖 price，并标记 customPrice） */
function applyPriceOverride(pub, overrides) {
  const o = overrides && overrides[pub.id];
  if (o !== undefined) {
    pub.price = o;
    pub.customPrice = true;
  }
  return pub;
}

// ---------------- 限流 ----------------
const ordersLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 每 IP 每分钟最多 10 次下单
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '下单过于频繁，请稍后再试' },
});
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 管理员登录防暴力破解
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
});
// 管理后台接口通用限流：因支持 X-Admin-Password 头（每请求都带密码），
// 需防范针对管理接口的密码暴力破解
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 每 IP 每分钟最多 60 次管理接口请求
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api/admin', adminLimiter);
// 客户"标记已付款"接口限流（带可选截图上传）
const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试' },
});

// ---------------- 文件上传（multer） ----------------
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function imageFileFilter(req, file, cb) {
  if (IMAGE_MIMES.has(file.mimetype) && MIME_EXT[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('只允许上传 PNG / JPG / GIF / WebP 图片'));
  }
}

// 支付宝收款码：存为 data/alipay_qr.<ext>（单文件，上传即替换），≤2MB
const qrUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DATA_DIR),
    filename: (req, file, cb) => cb(null, 'alipay_qr' + MIME_EXT[file.mimetype]),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

// 付款截图：存 data/uploads/<随机名>.<ext>，≤5MB
const shotUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + MIME_EXT[file.mimetype]),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

/** 包装 multer，统一把上传错误转为 400/413 JSON。 */
function withUpload(upload, field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: '图片超过大小限制' });
        }
        return res.status(400).json({ error: err.message || '文件上传失败' });
      }
      next();
    });
  };
}

/** 找到店主上传的收款码文件（data/alipay_qr.*），没有则返回 null。 */
function findQrFile() {
  try {
    const f = fs.readdirSync(DATA_DIR).find((n) => /^alipay_qr\.(png|jpg|gif|webp)$/.test(n));
    return f ? path.join(DATA_DIR, f) : null;
  } catch {
    return null;
  }
}
// 仓库内置收款码：public/alipay-qr.{png,jpg,jpeg,gif,webp}，随代码部署，永久有效，无需重复上传
function findBundledQr() {
  try {
    const dir = path.join(__dirname, 'public');
    const f = fs.readdirSync(dir).find((n) => /^alipay-qr\.(png|jpg|jpeg|gif|webp)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

// ---------------- 工具 ----------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const nowIso = () => new Date().toISOString();

/**
 * 无 key 模式的商品数据源：
 * - 本地真实目录 catalog.json：price 为 USDT 成本价，需加价并按汇率换算（costInUsdt=true）；
 * - 内置演示商品：price 已是人民币售价，不再换算（costInUsdt=false）。
 */
function demoCatalogSource() {
  const local = loadLocalCatalog();
  if (local) return { items: local, markup: MARKUP_PCT, costInUsdt: true };
  return { items: DEMO_PRODUCTS, markup: 0, costInUsdt: false };
}

function publicOpts(costInUsdt, markup) {
  return { markupPct: markup, rate: USDT_CNY_RATE, costInUsdt };
}

async function getCatalog() {
  const overrides = priceOverrideMap();
  const finalize = (p) => applyFeatured(applyPriceOverride(p, overrides));
  if (DEMO) {
    const src = demoCatalogSource();
    return src.items.map((p) =>
      finalize(toPublicProduct(p, publicOpts(src.costInUsdt, src.markup))));
  }
  const list = await fetchCatalog();
  return list.map((p) =>
    finalize(toPublicProduct(p, publicOpts(true, MARKUP_PCT))));
}

/** 返回 { raw, costInUsdt, costUsdt }：raw 为原始商品，costUsdt 为 USDT 成本（未知时为 null）。 */
async function getRawProduct(id) {
  const sid = String(id);
  if (DEMO) {
    const src = demoCatalogSource();
    const raw = src.items.find((x) => String(x.id) === sid) || null;
    return {
      raw,
      costInUsdt: src.costInUsdt,
      costUsdt: raw && src.costInUsdt ? Number(raw.price) : null,
    };
  }
  try {
    const raw = await fetchProduct(sid);
    return { raw, costInUsdt: true, costUsdt: raw ? Number(raw.price) : null };
  } catch (e) {
    if (e && e.status === 404) return { raw: null, costInUsdt: true, costUsdt: null };
    throw e;
  }
}

async function getProduct(id) {
  const { raw, costInUsdt } = await getRawProduct(id);
  if (!raw) return null;
  const markup = DEMO ? (costInUsdt ? MARKUP_PCT : 0) : MARKUP_PCT;
  return applyFeatured(applyPriceOverride(
    toPublicProduct(raw, publicOpts(costInUsdt, markup)), priceOverrideMap()));
}

function publicOrderRow(o) {
  const out = {
    orderId: o.order_id,
    status: o.status,
    productName: o.product_name,
    quantity: o.quantity,
    totalPrice: o.total_price, // 人民币售价总额（¥）
    // USDT 付款金额（= 人民币售价 / 汇率，保留 2 位），供币安内部转账使用
    usdtAmount: o.total_price != null && USDT_CNY_RATE > 0
      ? Math.round((Number(o.total_price) / USDT_CNY_RATE) * 100) / 100
      : null,
    binanceUid: getBinanceUid(), // 币安内部转账 UID（USDT 付款用，后台可改）
    payMethod: o.pay_method || 'usdt',
    payState: o.pay_state || 'unpaid',
    createdAt: o.created_at,
  };
  if (o.status === 'delivered' && o.delivered_key) out.deliveredKey = o.delivered_key;
  return out;
}

function adminOrderRow(o) {
  return {
    orderId: o.order_id,
    productId: o.product_id,
    productName: o.product_name,
    quantity: o.quantity,
    unitPrice: o.unit_price, // 人民币售价（¥）
    totalPrice: o.total_price, // 人民币售价总额（¥）
    unitCostUsdt: o.unit_cost_usdt != null ? o.unit_cost_usdt : null, // USDT 成本（供应商侧）
    totalCostUsdt: o.total_cost_usdt != null ? o.total_cost_usdt : null,
    email: o.email || null,
    payMethod: o.pay_method || 'usdt',
    payState: o.pay_state || 'unpaid',
    payNote: o.pay_note || null,
    hasScreenshot: Boolean(o.screenshot_path),
    screenshotName: o.screenshot_path ? String(o.screenshot_path).split(/[\\/]/).pop() : null,
    status: o.status,
    prodsellerId: o.prodseller_id || null,
    lastError: o.last_error || null,
    deliveredKey: o.delivered_key || null,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

// ---------------- 后台轮询（requiresEmailActivation 类订单） ----------------
const polls = new Map(); // orderId -> timer
const POLL_INTERVAL_MS = 30 * 1000;
const POLL_MAX_ATTEMPTS = 40;

function stopPolling(orderId) {
  const timer = polls.get(orderId);
  if (timer) {
    clearInterval(timer);
    polls.delete(orderId);
  }
}

function startPolling(orderId, prodsellerId) {
  if (polls.has(orderId)) return;
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    try {
      const remote = await psFetchOrder(prodsellerId);
      const st = String((remote && remote.status) || '').toLowerCase();
      const key = extractDeliveredKey(remote);
      if (st === 'delivered' || key) {
        stmts.setDelivered.run(key || '', null, nowIso(), orderId);
        stopPolling(orderId);
        console.log(`[jayshop] 订单 ${orderId} 轮询完成：已发货`);
        return;
      }
      if (st === 'failed' || st === 'cancelled' || st === 'error') {
        stmts.setFailed.run(nowIso(), orderId);
        stopPolling(orderId);
        console.log(`[jayshop] 订单 ${orderId} 轮询完成：供应商标记为 ${st}`);
        return;
      }
    } catch {
      /* 单次轮询失败继续重试 */
    }
    if (attempts >= POLL_MAX_ATTEMPTS) {
      stmts.setFailed.run(nowIso(), orderId);
      stopPolling(orderId);
      console.log(`[jayshop] 订单 ${orderId} 轮询 ${POLL_MAX_ATTEMPTS} 次仍未发货，标记为 failed`);
    }
  }, POLL_INTERVAL_MS);
  polls.set(orderId, timer);
}

// ---------------- 管理员鉴权 ----------------
const adminSessions = new Map(); // token -> 登录时间戳

function requireAdmin(req, res, next) {
  // 方式一（优先）：X-Admin-Password 请求头（前端 admin.html 采用此方式）
  const headerPwd = req.get('X-Admin-Password');
  if (typeof headerPwd === 'string' && headerPwd && headerPwd === ADMIN_PASSWORD) {
    return next();
  }
  // 方式二：POST /api/admin/login 设置的 httpOnly cookie session
  const token = req.cookies && req.cookies[ADMIN_COOKIE];
  if (token && adminSessions.has(token)) return next();
  return res.status(401).json({ error: '未登录或登录已过期' });
}

// ---------------- 公开 API ----------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, demoMode: DEMO });
});

// 公开配置：店主联系方式 + 店铺公告
// （环境变量 CONTACT_QQ / CONTACT_TELEGRAM / ANNOUNCEMENT 配置；都没配则前台不显示对应元素）
app.get('/api/config', (req, res) => {
  let announcement = '';
  try {
    const row = stmts.getSetting.get('announcement');
    if (row && row.value && String(row.value).trim()) announcement = String(row.value).trim().slice(0, 200);
  } catch {
    /* 忽略 */
  }
  if (!announcement) announcement = ANNOUNCEMENT_ENV;
  res.json({
    contact: {
      qq: CONTACT_QQ,
      telegram: CONTACT_TELEGRAM,
    },
    announcement,
  });
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await getCatalog();
    res.json({ demoMode: DEMO, products });
  } catch {
    res.status(502).json({ error: '商品列表获取失败，请稍后重试' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) return res.status(404).json({ error: '商品不存在' });
    res.json({ demoMode: DEMO, product });
  } catch {
    res.status(502).json({ error: '商品信息获取失败，请稍后重试' });
  }
});

app.post('/api/orders', ordersLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const productId = typeof body.productId === 'string' ? body.productId.trim().slice(0, 100) : '';
  const quantity = body.quantity;
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
  const payMethod = body.payMethod === 'alipay' ? 'alipay' : 'usdt';

  if (!productId) return res.status(400).json({ error: '缺少 productId' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return res.status(400).json({ error: 'quantity 必须为 1~999 的整数' });
  }

  let raw;
  try {
    raw = await getRawProduct(productId);
  } catch {
    return res.status(502).json({ error: '商品校验失败，请稍后重试' });
  }
  if (!raw.raw) return res.status(404).json({ error: '商品不存在' });
  const markup = DEMO ? (raw.costInUsdt ? MARKUP_PCT : 0) : MARKUP_PCT;
  const product = applyPriceOverride(
    toPublicProduct(raw.raw, publicOpts(raw.costInUsdt, markup)), priceOverrideMap());
  if (!product.inStock) return res.status(409).json({ error: '商品已售罄' });
  if (product.requiresEmailActivation && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: '该商品需要提供有效的邮箱地址' });
  }

  const orderId = crypto.randomUUID();
  const createdAt = nowIso();
  const unitPrice = product.price; // 人民币售价（¥）
  const totalPrice = Math.round(unitPrice * quantity * 100) / 100;
  // USDT 成本（供应商侧核算用；内置演示商品成本未知则为 null）
  const unitCostUsdt =
    raw.costUsdt != null && Number.isFinite(Number(raw.costUsdt))
      ? Math.round(Number(raw.costUsdt) * 100) / 100
      : null;
  const totalCostUsdt = unitCostUsdt != null ? Math.round(unitCostUsdt * quantity * 100) / 100 : null;

  stmts.insertOrder.run(
    orderId, String(raw.raw.id), product.name, quantity,
    unitPrice, totalPrice, email || null, payMethod,
    unitCostUsdt, totalCostUsdt, createdAt, createdAt
  );

  // Telegram 新订单通知（fire-and-forget）
  notifyNewOrder({ productName: product.name, quantity, totalPrice, orderId, payMethod });

  res.status(201).json({ orderId, status: 'pending', totalPrice, payMethod });
});

app.get('/api/orders/:id', (req, res) => {
  const o = stmts.getOrder.get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  res.json(publicOrderRow(o));
});

// ---------------- 支付宝收款码（公开） ----------------
// 优先级：店主上传的文件（data/alipay_qr.*）> 环境变量 ALIPAY_QR_URL > 404
app.get('/api/qr', (req, res) => {
  const file = findQrFile();
  if (file) return res.sendFile(file);
  if (ALIPAY_QR_URL) return res.redirect(302, ALIPAY_QR_URL);
  // 仓库内置收款码（public/alipay-qr.*）：永久有效
  const bundled = findBundledQr();
  if (bundled) return res.sendFile(bundled);
  return res.status(404).json({ error: '店主尚未设置支付宝收款码，请联系店主' });
});

// ---------------- 客户标记已付款（支付宝 / USDT 订单） ----------------
// multipart/form-data：screenshot（可选图片）+ note（可选，昵称/备注）
app.post('/api/orders/:id/mark-paid', payLimiter, withUpload(shotUpload, 'screenshot'), (req, res) => {
  const o = stmts.getOrder.get(req.params.id);
  // 上传了文件但订单校验失败时，删除孤儿文件
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };
  if (!o) {
    cleanup();
    return res.status(404).json({ error: '订单不存在' });
  }
  const payMethod = o.pay_method || 'usdt';
  if (payMethod !== 'alipay' && payMethod !== 'usdt') {
    cleanup();
    return res.status(400).json({ error: '该订单不支持标记付款' });
  }
  if (o.status !== 'pending') {
    cleanup();
    return res.status(409).json({ error: `订单当前状态为 ${o.status}，无法标记付款` });
  }
  if ((o.pay_state || 'unpaid') !== 'unpaid') {
    cleanup();
    return res.status(409).json({ error: '该订单已标记过付款，请等待店主确认' });
  }
  // 付款截图必填：无截图不允许标记付款
  if (!req.file) {
    return res.status(400).json({ error: '请上传付款截图后再提交' });
  }

  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  const shotPath = req.file ? req.file.path : null;
  stmts.markPaid.run(note || null, shotPath, nowIso(), o.order_id);

  // 通知店主（文字 + 截图照片，fire-and-forget）
  notifyPaidClaimed({ orderId: o.order_id, totalPrice: o.total_price, payNote: note, payMethod });
  if (shotPath) {
    notifyPaidClaimedPhoto({ orderId: o.order_id, totalPrice: o.total_price, screenshotPath: shotPath }).catch(() => {});
  }

  const updated = stmts.getOrder.get(o.order_id);
  res.json(publicOrderRow(updated));
});

// ---------------- 管理员 API ----------------
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now());
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const rows = stmts.listOrders.all();
  res.json({ orders: rows.map(adminOrderRow) });
});

app.post('/api/admin/orders/:id/confirm', requireAdmin, async (req, res) => {
  const o = stmts.getOrder.get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status === 'delivered') {
    return res.json({ orderId: o.order_id, status: 'delivered', deliveredKey: o.delivered_key });
  }
  if (o.status !== 'pending') {
    return res.status(409).json({ error: `订单当前状态为 ${o.status}，无法确认发货` });
  }
  // 支付宝订单：客户必须先标记"已付款"（店主在支付宝 App 核对到账后点确认）
  if ((o.pay_method || 'usdt') === 'alipay' && (o.pay_state || 'unpaid') !== 'paid_claimed') {
    return res.status(409).json({ error: '客户尚未标记已付款，请先核对支付宝到账' });
  }

  // 演示模式：直接标记发货
  if (DEMO) {
    const key = 'DEMO-KEY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    stmts.setDelivered.run(key, null, nowIso(), o.order_id);
    return res.json({ orderId: o.order_id, status: 'delivered', deliveredKey: key });
  }

  // 真实模式：调用供应商下单，Idempotency-Key 使用本地 orderId
  try {
    const remote = await psCreateOrder(
      { productId: o.product_id, quantity: o.quantity, email: o.email || undefined },
      o.order_id
    );
    const key = extractDeliveredKey(remote);
    const st = String((remote && remote.status) || '').toLowerCase();
    const remoteId = remote && remote.id != null ? String(remote.id) : null;

    if (key || st === 'delivered') {
      stmts.setDelivered.run(key || '', remoteId, nowIso(), o.order_id);
      return res.json({
        orderId: o.order_id,
        status: 'delivered',
        ...(key ? { deliveredKey: key } : {}),
      });
    }
    if (st === 'paid' && remoteId) {
      stmts.setProdsellerId.run(remoteId, nowIso(), o.order_id);
      startPolling(o.order_id, remoteId);
      return res.status(202).json({
        orderId: o.order_id,
        status: 'pending',
        message: '供应商已受理，正在等待发货，系统将自动轮询更新状态',
      });
    }
    throw new Error('unexpected supplier response');
  } catch (e) {
    // 402 余额不足：保持 pending 可重试，不标记失败
    if (e && e.status === 402) {
      stmts.setLastError.run('余额不足', nowIso(), o.order_id);
      return res.status(402).json({
        orderId: o.order_id,
        status: 'pending',
        error: 'ProdSeller 余额不足（当前约 0.01 USDT），请充值后再试',
      });
    }
    stmts.setFailed.run(nowIso(), o.order_id);
    return res.status(502).json({
      orderId: o.order_id,
      status: 'failed',
      error: '供应商下单失败，订单已标记为失败',
    });
  }
});

app.post('/api/admin/orders/:id/cancel', requireAdmin, (req, res) => {
  const o = stmts.getOrder.get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status !== 'pending') {
    return res.status(409).json({ error: `订单当前状态为 ${o.status}，仅 pending 订单可取消` });
  }
  stopPolling(o.order_id);
  stmts.setCancelled.run(nowIso(), o.order_id);
  res.json({ orderId: o.order_id, status: 'cancelled' });
});

// 上传/更换支付宝收款码（图片 ≤2MB，旧文件会被替换删除）
app.post('/api/admin/qr', requireAdmin, withUpload(qrUpload, 'qr'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择要上传的收款码图片' });
  // 清理同名旧文件（不同扩展名残留）
  try {
    for (const n of fs.readdirSync(DATA_DIR)) {
      if (/^alipay_qr\.(png|jpg|gif|webp)$/.test(n) && n !== path.basename(req.file.path)) {
        fs.unlinkSync(path.join(DATA_DIR, n));
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
  res.json({ ok: true, message: '收款码已更新' });
});

// 查看客户上传的付款截图（防路径穿越：仅允许 data/uploads 下的随机文件名）
app.get('/api/admin/uploads/:name', requireAdmin, (req, res) => {
  const name = req.params.name;
  if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) {
    return res.status(400).json({ error: '文件名非法' });
  }
  const file = path.join(UPLOADS_DIR, name);
  fs.access(file, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).json({ error: '截图不存在' });
    res.sendFile(file);
  });
});

// 供应商余额（USDT，真实模式实时查询；演示模式无余额概念）
app.get('/api/admin/balance', requireAdmin, async (req, res) => {
  if (DEMO) return res.json({ demoMode: true, balance: null, currency: 'USDT' });
  try {
    const { psBalance } = require('./lib/prodseller');
    const b = await psBalance();
    res.json({ demoMode: false, balance: b && b.balance != null ? b.balance : null, currency: 'USDT' });
  } catch {
    res.status(502).json({ error: '余额查询失败，请稍后重试' });
  }
});

// 商品定价管理：全部商品的成本 / 公式价 / 自定义价 / 当前售价
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const overrides = priceOverrideMap();
    let raws;
    if (DEMO) {
      const src = demoCatalogSource();
      raws = src.items.map((p) => ({ raw: p, costInUsdt: src.costInUsdt, markup: src.markup }));
    } else {
      const list = await fetchCatalog();
      raws = list.map((p) => ({ raw: p, costInUsdt: true, markup: MARKUP_PCT }));
    }
    const products = raws.map(({ raw, costInUsdt, markup }) => {
      const pub = toPublicProduct(raw, publicOpts(costInUsdt, markup));
      const cost = costInUsdt && raw.price != null ? Number(raw.price) : NaN;
      const override = overrides[pub.id];
      const envPrice = ENV_PRICED_IDS.has(pub.id) ? getEnvPriceOverrides()[pub.id] : null;
      return {
        id: pub.id,
        name: pub.name,
        inStock: pub.inStock,
        featured: Boolean(pub.featured), // 是否热门（首页🔥分类）
        costUsdt: Number.isFinite(cost) ? Math.round(cost * 100) / 100 : null,
        formulaPrice: pub.price,
        overridePrice: override !== undefined ? override : null,
        finalPrice: override !== undefined ? override : pub.price,
        fromEnv: ENV_PRICED_IDS.has(pub.id), // 环境变量中有底稿价（重建后以它为准）
        envPrice, // 环境变量中的底稿价（无则为 null）
      };
    });
    res.json({ products, markupPct: MARKUP_PCT, rate: USDT_CNY_RATE });
  } catch {
    res.status(502).json({ error: '商品定价数据获取失败，请稍后重试' });
  }
});

// 设置单个商品自定义售价（人民币固定价）；price 为空则清除，恢复公式价
app.post('/api/admin/products/:id/price', requireAdmin, async (req, res) => {
  const pid = String(req.params.id || '').slice(0, 100);
  if (!pid) return res.status(400).json({ error: '缺少商品 id' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawPrice = body.price;
  if (rawPrice === null || rawPrice === undefined || rawPrice === '') {
    stmts.clearOverride.run(pid);
    return res.json({ ok: true, cleared: true, productId: pid });
  }
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0 || price > 9999999) {
    return res.status(400).json({ error: '价格必须是大于 0 的数字（最高 9999999）' });
  }
  try {
    const r = await getRawProduct(pid);
    if (!r.raw) return res.status(404).json({ error: '商品不存在' });
  } catch {
    return res.status(502).json({ error: '商品校验失败，请稍后重试' });
  }
  const fixed = Math.round(price * 100) / 100;
  stmts.setOverride.run(pid, fixed, nowIso());
  res.json({ ok: true, productId: pid, price: fixed });
});

// 通用设置查询（目前：币安 UID、店铺公告、热门商品）
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  let binanceUid = '';
  let announcement = '';
  let featuredIds = [];
  try {
    const r1 = stmts.getSetting.get('binance_uid');
    if (r1 && r1.value) binanceUid = String(r1.value);
    const r2 = stmts.getSetting.get('announcement');
    if (r2 && r2.value) announcement = String(r2.value);
    const r3 = stmts.getSetting.get('featured_ids');
    if (r3 && r3.value) {
      const arr = JSON.parse(String(r3.value));
      if (Array.isArray(arr)) featuredIds = arr.filter((s) => typeof s === 'string');
    }
  } catch {
    /* 忽略 */
  }
  res.json({
    binanceUid, binanceUidEnv: BINANCE_UID || '',
    announcement, announcementEnv: ANNOUNCEMENT_ENV,
    featuredIds,
  });
});

// 通用设置保存：币安 UID、店铺公告、热门商品 id 列表（空字符串/空数组 = 清除，恢复用环境变量的值）
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const out = {};
  if (body.binanceUid !== undefined) {
    const uid = typeof body.binanceUid === 'string' ? body.binanceUid.trim().slice(0, 64) : '';
    if (uid && !/^[0-9]{5,20}$/.test(uid)) {
      return res.status(400).json({ error: '币安 UID 应为 5~20 位数字' });
    }
    stmts.setSetting.run('binance_uid', uid, nowIso());
    out.binanceUid = uid;
  }
  if (body.announcement !== undefined) {
    const ann = typeof body.announcement === 'string' ? body.announcement.trim().slice(0, 200) : '';
    stmts.setSetting.run('announcement', ann, nowIso());
    out.announcement = ann;
  }
  if (body.featuredIds !== undefined) {
    if (!Array.isArray(body.featuredIds)) {
      return res.status(400).json({ error: 'featuredIds 应为数组' });
    }
    const ids = body.featuredIds
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 100))
      .slice(0, 50);
    stmts.setSetting.run('featured_ids', JSON.stringify(ids), nowIso());
    out.featuredIds = ids;
  }
  res.json(Object.assign({ ok: true }, out));
});

// ---------------- 静态托管与兜底 ----------------
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// ---------------- 启动 ----------------
const server = app.listen(PORT, () => {
  console.log(`[jayshop] 服务已启动，监听端口 ${PORT}（demoMode=${DEMO}）`);
});

function shutdown() {
  server.close(() => {
    for (const timer of polls.values()) clearInterval(timer);
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
