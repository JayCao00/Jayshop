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

  /* ============ 联系店主悬浮窗 ============
     从 /api/config 读取环境变量配置的 QQ / Telegram。
     两个都没配置时不显示按钮；后台页面（admin.html）不注入。 */
  (function initContactWidget() {
    if (/admin\.html$/.test(location.pathname)) return;
    var fab = document.createElement('button');
    fab.id = 'contactFab';
    fab.className = 'contact-fab';
    fab.style.display = 'none';
    fab.textContent = '💬 联系店主';
    var modal = document.createElement('div');
    modal.id = 'contactModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-inner contact-modal">' +
        '<div class="modal-head"><span>联系店主</span>' +
        '<button class="link-btn" id="contactClose">✕ 关闭</button></div>' +
        '<div id="contactBody"></div>' +
      '</div>';
    document.body.appendChild(fab);
    document.body.appendChild(modal);
    function openModal() { modal.style.display = 'flex'; }
    function closeModal() { modal.style.display = 'none'; }
    fab.addEventListener('click', openModal);
    modal.querySelector('#contactClose').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

    api('/api/config').then(function (r) {
      if (!r.ok || !r.data) return;

      // ---- 店铺公告横幅（顶栏下方，可关闭；换新公告后重新出现） ----
      (function showAnnouncement(text) {
        if (!text) return;
        var dismissed = null;
        try { dismissed = localStorage.getItem('jayshop_ann_dismissed'); } catch (e) { /* 忽略 */ }
        if (dismissed === text) return;
        var bar = document.createElement('div');
        bar.className = 'announce-bar';
        var txt = document.createElement('span');
        txt.className = 'announce-text';
        txt.textContent = '📢 ' + text;
        var close = document.createElement('button');
        close.className = 'announce-close';
        close.setAttribute('aria-label', '关闭公告');
        close.textContent = '✕';
        close.addEventListener('click', function () {
          try { localStorage.setItem('jayshop_ann_dismissed', text); } catch (e) { /* 忽略 */ }
          bar.remove();
        });
        bar.appendChild(txt);
        bar.appendChild(close);
        var topbar = document.querySelector('.topbar');
        if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(bar, topbar.nextSibling);
        else document.body.insertBefore(bar, document.body.firstChild);
      })(r.data.announcement);

      var c = r.data.contact;
      if (!c) return;
      var rows = '';
      if (c.qq) {
        rows +=
          '<div class="contact-row">' +
            '<div><div class="contact-label">QQ</div>' +
            '<div class="contact-value">' + esc(c.qq) + '</div></div>' +
            '<div class="contact-actions">' +
              '<button class="btn small ghost" data-copy="' + esc(c.qq) + '">复制</button>' +
              '<a class="btn small" target="_blank" rel="noopener" href="https://wpa.qq.com/msgrd?v=3&uin=' +
                encodeURIComponent(c.qq) + '&site=qq&menu=yes">加好友</a>' +
            '</div>' +
          '</div>';
      }
      if (c.telegram) {
        var tg = String(c.telegram).replace(/^@/, '');
        rows +=
          '<div class="contact-row">' +
            '<div><div class="contact-label">Telegram</div>' +
            '<div class="contact-value">@' + esc(tg) + '</div></div>' +
            '<div class="contact-actions">' +
              '<a class="btn small" target="_blank" rel="noopener" href="https://t.me/' +
                encodeURIComponent(tg) + '">去 Telegram</a>' +
            '</div>' +
          '</div>';
      }
      if (!rows) return; // 都没配置就不显示按钮
      document.getElementById('contactBody').innerHTML = rows +
        '<p class="contact-tip">下单遇到问题？直接联系店主，附上订单号更快解决。</p>';
      fab.style.display = '';
      var copyBtns = modal.querySelectorAll('[data-copy]');
      for (var i = 0; i < copyBtns.length; i++) {
        (function (b) {
          b.addEventListener('click', function () {
            copyText(b.getAttribute('data-copy')).then(function (ok) {
              toast(ok ? '已复制' : '复制失败，请手动复制', !ok);
            });
          });
        })(copyBtns[i]);
      }
    });
  })();

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
