'use strict';

/**
 * SQLite 初始化：订单表。
 * 数据文件位置由 DATA_DIR 环境变量决定。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'jayshop.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id      TEXT PRIMARY KEY,
      product_id    TEXT NOT NULL,
      product_name  TEXT NOT NULL,
      quantity      INTEGER NOT NULL,
      unit_price    REAL NOT NULL,
      total_price   REAL NOT NULL,
      email         TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      prodseller_id TEXT,
      delivered_key TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      pay_method    TEXT NOT NULL DEFAULT 'usdt',
      pay_state     TEXT NOT NULL DEFAULT 'unpaid',
      pay_note      TEXT,
      screenshot_path TEXT,
      unit_cost_usdt  REAL,
      total_cost_usdt REAL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status_created
      ON orders (status, created_at DESC);
  `);

  return db;
}

module.exports = { initDb };
