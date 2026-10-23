'use strict';

/**
 * ProdSeller 供应商 API 客户端。
 * - 无 PRODSELLER_API_KEY 时进入演示模式，返回内置演示商品。
 * - 真实模式下代理 https://prodseller.com/v1，售价 = 成本价 × (1 + MARKUP_PCT)。
 * - 注意：API Key 只出现在发往 prodseller.com 的请求头里，绝不写入日志或响应。
 */
const BASE = process.env.PRODSELLER_BASE_URL || 'https://prodseller.com/v1';
const API_KEY = process.env.PRODSELLER_API_KEY || '';

/** 本地真实商品目录（无 key 模式使用），带 mtime 缓存。 */
const path = require('path');
const fs = require('fs');
const LOCAL_CATALOG_PATH = path.join(__dirname, '..', 'catalog.json');
let localCatalogCache = null;
let localCatalogMtime = 0;

function loadLocalCatalog() {
  try {
    const stat = fs.statSync(LOCAL_CATALOG_PATH);
    if (localCatalogCache && stat.mtimeMs === localCatalogMtime) return localCatalogCache;
    const raw = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf8'));
    const items = Array.isArray(raw) ? raw : raw.products || [];
    localCatalogCache = items;
    localCatalogMtime = stat.mtimeMs;
    console.log(`[jayshop] 已加载本地商品目录：${items.length} 个商品`);
    return items;
  } catch (e) {
    return null; // 文件不存在或损坏时由调用方回退到 DEMO_PRODUCTS
  }
}

function isDemoMode() {
  return !API_KEY;
}

/** 演示模式商品（售价，非成本价）。 */
const DEMO_PRODUCTS = [
  {
    id: 'demo-1',
    name: 'Steam 国区 100 元充值卡',
    description: '国区 Steam 钱包充值卡，卡密自动发货，充值即时到账。',
    price: 98.0,
    imageUrl: '',
    delivery: '自动发货 · 卡密',
    inStock: true,
    requiresEmailActivation: false,
    sold: 342,
  },
  {
    id: 'demo-2',
    name: 'Netflix 高级会员 1 个月',
    description: 'Netflix Premium 独享账号一个月，支持 4K + HDR。',
    price: 32.0,
    imageUrl: '',
    delivery: '24 小时内发货 · 独享账号',
    inStock: true,
    requiresEmailActivation: false,
    sold: 518,
  },
  {
    id: 'demo-3',
    name: 'ChatGPT Plus 1 个月代充',
    description: '为你的 OpenAI 账号代充 Plus 会员一个月，需提供账号邮箱。',
    price: 148.0,
    imageUrl: '',
    delivery: '需提供 OpenAI 账号邮箱 · 1-2 天到账',
    inStock: true,
    requiresEmailActivation: true,
    sold: 127,
  },
  {
    id: 'demo-4',
    name: 'Spotify Premium 个人版 3 个月',
    description: 'Spotify 高级会员兑换码，三个月无广告畅听。',
    price: 59.0,
    imageUrl: '',
    delivery: '自动发货 · 兑换码',
    inStock: true,
    requiresEmailActivation: false,
    sold: 264,
  },
  {
    id: 'demo-5',
    name: 'Adobe Creative Cloud 全家桶 1 年',
    description: 'Adobe 全家桶正版订阅一年，含 PS / AI / PR 等全套应用。',
    price: 419.0,
    imageUrl: '',
    delivery: '需提供 Adobe 账号邮箱 · 人工开通',
    inStock: true,
    requiresEmailActivation: true,
    sold: 89,
  },
  {
    id: 'demo-6',
    name: '任天堂 Switch Online 会员 12 个月',
    description: 'NSO 港服 / 日服 12 个月会员兑换码（当前缺货，补货中）。',
    price: 129.0,
    imageUrl: '',
    delivery: '自动发货 · 兑换码',
    inStock: false,
    requiresEmailActivation: false,
    sold: 176,
  },
];

/** 保留两位小数的售价计算：售价(¥) = 成本(U) × (1 + 加价率) × 汇率。 */
function sellPrice(costUsdt, markupPct, rate) {
  return Math.round(Number(costUsdt) * (1 + markupPct) * Number(rate) * 100) / 100;
}

/**
 * 把供应商商品映射为对外公开结构。
 * 绝不包含成本价（price 字段在此即供应商的成本价，单位 USDT）与任何鉴权信息。
 * opts.costInUsdt 为 true 时 price 按公式换算为人民币售价；
 * 为 false 时（如内置演示商品）price 已是人民币售价，直接保留两位小数。
 */

// 商品分类：按名称关键词归类（名称与关键词统一转小写后匹配，顺序优先；命中不了的进 other）
const CATEGORY_RULES = [
  ['ai', ['gemini', 'claude', 'muse', 'codex', 'elevenlabs', 'framer ai', 'wispr']],
  ['media', ['prime video', 'apple tv', 'youtube', 'shahid', 'amazon prime', 'spotify', 'scribd', 'deezer']],
  ['office', ['office 365', 'notion', 'canva', 'adobe express', 'capcut', 'miro', 'figma', 'ilovepdf', 'autodesk', 'jetbrains']],
  ['edu', ['duolingo', 'edx']],
  ['network', ['vpn', 'v2ray', 'proxy', 'hma']],
  ['account', ['gmail', 'outlook', 'hotmail', 'telegram account', 'emails']],
].map(([key, words]) => [key, words.map((w) => w.toLowerCase())]);
function getCategory(name) {
  const n = String(name || '').toLowerCase();
  for (const [key, kws] of CATEGORY_RULES) {
    if (kws.some((k) => n.includes(k))) return key;
  }
  return 'other';
}

/**
 * 库存判断：兼容供应商两种字段——
 * - 列表接口给 inStock 布尔值；
 * - 详情接口给 stock 剩余数量（无 inStock 字段）。
 * 都没有时默认有货（与列表页 p.inStock !== false 的逻辑一致）。
 */
function resolveInStock(p) {
  if (typeof p.inStock === 'boolean') return p.inStock;
  if (p.stock !== undefined && p.stock !== null) return Number(p.stock) > 0;
  return true;
}

function toPublicProduct(p, opts) {
  const { markupPct = 0, rate = 7.2, costInUsdt = true } = opts || {};
  const price = costInUsdt
    ? sellPrice(p.price, markupPct, rate)
    : Math.round(Number(p.price) * 100) / 100;
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    price,
    category: getCategory(p.name),
    imageUrl: p.imageUrl || '',
    delivery: p.delivery || '',
    inStock: resolveInStock(p),
    requiresEmailActivation: Boolean(p.requiresEmailActivation),
    sold: Number(p.sold) || 0,
  };
}

async function psFetch(p, { method = 'GET', body, idempotencyKey } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE + p, {
      method,
      signal: ctrl.signal,
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`ProdSeller request failed with status ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCatalog() {
  const data = await psFetch('/products');
  return Array.isArray(data) ? data : data.products || [];
}

async function fetchProduct(id) {
  return psFetch(`/products/${encodeURIComponent(String(id))}`);
}

async function createOrder({ productId, quantity, email }, idempotencyKey) {
  const body = { productId, quantity };
  if (email) body.email = email;
  return psFetch('/orders', { method: 'POST', body, idempotencyKey });
}

async function fetchOrder(prodsellerId) {
  return psFetch(`/orders/${encodeURIComponent(String(prodsellerId))}`);
}

/** 查询供应商 USDT 余额。 */
async function psBalance() {
  return psFetch('/balance');
}

/** 从供应商订单响应里提取发货 key（兼容几种常见字段名）。 */
function extractDeliveredKey(order) {
  if (!order || typeof order !== 'object') return null;
  return order.deliveredKey || order.key || order.activationKey || null;
}

module.exports = {
  isDemoMode,
  DEMO_PRODUCTS,
  loadLocalCatalog,
  sellPrice,
  toPublicProduct,
  fetchCatalog,
  fetchProduct,
  createOrder,
  fetchOrder,
  psBalance,
  extractDeliveredKey,
};
