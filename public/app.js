/* ============================================================
   Jayshop - 共享 JS 工具
   纯原生 JS，无依赖。所有 API 请求走同源相对路径 /api/*
   注意：前端绝不存放 API Key / 密钥 / 成本价。
   ============================================================ */
(function () {
  'use strict';

  /** 同源 API 请求封装，返回 { ok, status, data } */

  /** 管理接口鉴权封装：GET 请求通过 X-Admin-Password 头传递密码
      （GET 不能带 body），POST 请求通过 JSON body 的 password 字段传递。 */
  async function adminApi(path, password, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var body = options.body;
    if ((options.method || 'GET').toUpperCase() === 'GET') {
      headers['X-Admin-Password'] = password || '';
    } else {
      body = Object.assign({ password: password || '' }, body || {});
    }
    return api(path, { method: options.method || 'GET', headers: headers, body: body });
  }
  async function api(path, options) {
    options = options || {};
    const opts = {
      method: options.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
    };
    if (options.body !== undefined) {
      opts.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      // 网络错误（离线 / DNS / 连接被拒）
      return { ok: false, status: 0, data: null, networkError: true };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  /** 金额格式化：直接展示后端返回的售价 */
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(Number(n))) return '¥--';
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(Number(n));
    } catch (e) {
      return '¥' + Number(n);
    }
  }

  /** 获取 URL 查询参数 */
  function param(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /** 转义 HTML，防止商品文案注入 */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 图片占位：无图或加载失败时显示商品名首字 */
  function thumbHTML(product, cls) {
    cls = cls || '';
    const first = esc((product && product.name ? product.name : '商').trim().charAt(0) || '商');
    const url = product && product.imageUrl;
    if (url) {
      return (
        '<img src="' + esc(url) + '" alt="' + esc(product.name || '') + '" loading="lazy"' +
        ' onerror="this.outerHTML=\'<div class=&quot;ph ' + cls + '&quot;&gt;' + first + '</div>\'">' +
        '<div class="ph ' + cls + '" style="display:none">' + first + '</div>'
      );
    }
    return '<div class="ph ' + cls + '">' + first + '</div>';
  }

  /** toast 提示 */
  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /** 复制文本（带降级方案） */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 格式化时间（后端 createdAt，可能是 ISO 字符串或时间戳） */
  function fmtTime(t) {
    if (!t) return '--';
    const d = new Date(t);
    if (isNaN(d.getTime())) return String(t);
    try {
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  /** 统一的加载失败状态块 */
  function errorStateHTML(title, desc) {
    return (
      '<div class="state">' +
        '<div class="emoji">😢</div>' +
        '<h2>' + esc(title || '加载失败') + '</h2>' +
        '<p>' + esc(desc || '网络似乎出了点问题，请检查连接后重试。') + '</p>' +
        '<button class="btn secondary" style="width:auto;padding:12px 32px" onclick="location.reload()">重新加载</button>' +
      '</div>'
    );
  }

  function emptyStateHTML(title, desc) {
    return (
      '<div class="state">' +
        '<div class="emoji">📦</div>' +
        '<h2>' + esc(title || '暂无商品') + '</h2>' +
        '<p>' + esc(desc || '店主正在上架更多好货，稍后再来看看～') + '</p>' +
      '</div>'
    );
  }

  function notFoundHTML(title, desc, backHref) {
    return (
      '<div class="state">' +
        '<div class="emoji">🔍</div>' +
        '<h2>' + esc(title || '页面找不到了') + '</h2>' +
        '<p>' + esc(desc || '您访问的内容不存在或已下架。') + '</p>' +
        '<a href="' + esc(backHref || 'index.html') + '" class="btn secondary" style="width:auto;padding:12px 32px;text-decoration:none;display:inline-block">返回首页</a>' +
      '</div>'
    );
  }

  // 暴露给各页面
  window.Jay = {
    api: api,
    adminApi: adminApi,
    fmtMoney: fmtMoney,
    param: param,
    esc: esc,
    thumbHTML: thumbHTML,
    toast: toast,
    copyText: copyText,
    fmtTime: fmtTime,
    errorStateHTML: errorStateHTML,
    emptyStateHTML: emptyStateHTML,
    notFoundHTML: notFoundHTML,
  };
})();
