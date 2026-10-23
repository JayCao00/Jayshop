'use strict';

/**
 * Telegram 新订单通知（fire-and-forget）。
 * 仅在同时配置了 BOT_TOKEN 与 CHAT_ID 时发送；失败静默忽略，不影响下单主流程。
 */
const fs = require('fs');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';

function sendText(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  }).catch(() => {
    /* 通知失败不影响业务 */
  });
}

const PAY_LABEL = { alipay: '支付宝', usdt: 'USDT' };

function notifyNewOrder({ productName, quantity, totalPrice, orderId, payMethod }) {
  const shortId = String(orderId).slice(0, 8);
  const text =
    `🛒 新订单\n` +
    `商品：${productName} × ${quantity}\n` +
    `金额：¥${totalPrice}\n` +
    `支付：${PAY_LABEL[payMethod] || 'USDT'}\n` +
    `订单号：${shortId}`;
  sendText(text);
}

function notifyPaidClaimed({ orderId, totalPrice, payNote }) {
  const shortId = String(orderId).slice(0, 8);
  const text =
    `💰 客户已标记付款（支付宝）\n` +
    `金额：¥${totalPrice}\n` +
    (payNote ? `备注：${String(payNote).slice(0, 60)}\n` : '') +
    `订单号：${shortId}\n` +
    `请打开支付宝核对到账后，在管理后台确认收款并发货`;
  sendText(text);
}

/** 把客户上传的付款截图也推一份到 Telegram（文件在 data/，重部署可能丢失）。 */
async function notifyPaidClaimedPhoto({ orderId, totalPrice, screenshotPath }) {
  if (!BOT_TOKEN || !CHAT_ID || !screenshotPath) return;
  try {
    const buf = await fs.promises.readFile(screenshotPath);
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'payment.jpg');
    form.append('caption', `🧾 付款截图（订单 ${String(orderId).slice(0, 8)}，¥${totalPrice}）`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
  } catch {
    /* 通知失败不影响业务 */
  }
}

module.exports = { notifyNewOrder, notifyPaidClaimed, notifyPaidClaimedPhoto };
