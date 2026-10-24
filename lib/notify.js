'use strict';

/**
 * Jayshop 新订单通知（fire-and-forget，多通道）。
 *
 * 通道：
 * 1. Telegram：需同时配置 BOT_TOKEN 与 CHAT_ID（原有逻辑不变）
 * 2. 飞书：配置 FEISHU_WEBHOOK（飞书群 → 群设置 → 机器人 → 自定义机器人 → 复制 webhook 地址）
 * 3. 微信：配置 SERVERCHAN_KEY（Server酱 https://sctapi.ftqq.com 注册绑定微信后拿到的 SendKey）
 *
 * 每个通道独立判断、失败静默忽略，不影响下单主流程。
 * 只配其中几个就只推那几个，全不配则静默。
 */

const fs = require('fs');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const FEISHU_WEBHOOK = (process.env.FEISHU_WEBHOOK || '').trim();
const SERVERCHAN_KEY = (process.env.SERVERCHAN_KEY || '').trim();

// ---------------- Telegram ----------------
function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  }).catch(() => {
    /* 通知失败不影响业务 */
  });
}

// ---------------- 飞书群机器人 ----------------
// webhook 来源：后台设置（优先，由 server.js 传入）或环境变量 FEISHU_WEBHOOK
function sendFeishu(text, webhook) {
  const hook = (webhook || FEISHU_WEBHOOK || '').trim();
  if (!hook) return null;
  // 飞书自定义机器人 webhook：POST { msg_type: "text", content: { text } }
  return fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  }).catch(() => {
    /* 通知失败不影响业务 */
  });
}

// 发一条测试消息并返回真实结果（供后台"发送测试"按钮用）
async function sendFeishuTest(webhook) {
  const hook = (webhook || '').trim();
  if (!hook) return { ok: false, error: '未配置飞书 webhook' };
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: '🔔 Jayshop 通知测试：飞书通道已接通，新订单和付款提醒会发到这里。' } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.code === 0) return { ok: true };
    return { ok: false, error: data.msg ? ('飞书返回：' + data.msg) : ('飞书返回异常（HTTP ' + res.status + '）') };
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e && e.message ? e.message : '网络错误') };
  }
}

// ---------------- 微信（Server酱） ----------------
function sendWechat(title, desp) {
  if (!SERVERCHAN_KEY) return;
  // Server酱 Turbo：POST https://sctapi.ftqq.com/{SendKey}.send
  const url = `https://sctapi.ftqq.com/${encodeURIComponent(SERVERCHAN_KEY)}.send`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: title.slice(0, 32), desp: desp.slice(0, 4000) }),
  }).catch(() => {
    /* 通知失败不影响业务 */
  });
}

// ---------------- 统一分发 ----------------
function fanout(title, text, opts) {
  const hook = opts && opts.feishuWebhook;
  sendTelegram(text);
  sendFeishu(text, hook);
  sendWechat(title, text);
}

const PAY_LABEL = { alipay: '支付宝', usdt: 'USDT' };

function notifyNewOrder({ productName, quantity, totalPrice, orderId, payMethod, feishuWebhook }) {
  const shortId = String(orderId).slice(0, 8);
  const text =
    `🛒 新订单\n` +
    `商品：${productName} × ${quantity}\n` +
    `金额：¥${totalPrice}\n` +
    `支付：${PAY_LABEL[payMethod] || 'USDT'}\n` +
    `订单号：${shortId}`;
  fanout('🛒 Jayshop 新订单', text, { feishuWebhook });
}

function notifyPaidClaimed({ orderId, totalPrice, payNote, payMethod, feishuWebhook }) {
  const shortId = String(orderId).slice(0, 8);
  const isUsdt = payMethod === 'usdt';
  const text =
    `💰 客户已标记付款（${isUsdt ? '币安 USDT' : '支付宝'}）\n` +
    `金额：¥${totalPrice}\n` +
    (payNote ? `备注：${String(payNote).slice(0, 60)}\n` : '') +
    `订单号：${shortId}\n` +
    (isUsdt
      ? `请打开币安核对 UID 转账到账后，在管理后台确认并发货`
      : `请打开支付宝核对到账后，在管理后台确认收款并发货`);
  fanout('💰 客户已付款', text, { feishuWebhook });
}

/**
 * 客户上传付款截图：Telegram 推原图；
 * 飞书/微信只推文字提醒（截图请去 Telegram 或管理后台查看）。
 */
async function notifyPaidClaimedPhoto({ orderId, totalPrice, screenshotPath, feishuWebhook }) {
  const shortId = String(orderId).slice(0, 8);

  // 飞书 / 微信：文字提醒
  if (screenshotPath) {
    const text = `🧾 收到付款截图（订单 ${shortId}，¥${totalPrice}）\n截图请去 Telegram 或管理后台查看`;
    sendFeishu(text, feishuWebhook);
    sendWechat('🧾 收到付款截图', text);
  }

  // Telegram：推原图（原有逻辑不变）
  if (!BOT_TOKEN || !CHAT_ID || !screenshotPath) return;
  try {
    const buf = await fs.promises.readFile(screenshotPath);
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'payment.jpg');
    form.append('caption', `🧾 付款截图（订单 ${shortId}，¥${totalPrice}）`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
  } catch {
    /* 通知失败不影响业务 */
  }
}

module.exports = { notifyNewOrder, notifyPaidClaimed, notifyPaidClaimedPhoto, sendFeishuTest };
