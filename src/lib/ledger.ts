import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LEDGER_PATH } from './paths.js'

export interface LedgerEntry {
  ts: string
  endpoint: string
  model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usdc: number | null
  balance_after_usdc: number | null
  latency_ms: number
  status: number
  error: string | null
}

let _db: Database.Database | null = null

export function getDb(path = LEDGER_PATH): Database.Database {
  if (_db) return _db
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS inference_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost_usdc REAL,
      balance_after_usdc REAL,
      latency_ms INTEGER NOT NULL,
      status INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_ts ON inference_calls(ts);
    CREATE INDEX IF NOT EXISTS idx_calls_model ON inference_calls(model);

    DROP TABLE IF EXISTS x402_payments;
    CREATE TABLE x402_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      status INTEGER NOT NULL,
      amount_usdc REAL,
      network TEXT,
      tx_hash TEXT,
      latency_ms INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payments_ts ON x402_payments(ts);
    CREATE INDEX IF NOT EXISTS idx_payments_url ON x402_payments(url);
  `)
  _db = db
  return db
}

export function logCall(entry: LedgerEntry): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO inference_calls
      (ts, endpoint, model, prompt_tokens, completion_tokens,
       cost_usdc, balance_after_usdc, latency_ms, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.endpoint,
    entry.model,
    entry.prompt_tokens,
    entry.completion_tokens,
    entry.cost_usdc,
    entry.balance_after_usdc,
    entry.latency_ms,
    entry.status,
    entry.error,
  )
}

export interface PaymentEntry {
  ts: string
  url: string
  method: string
  status: number
  amount_usdc: number | null
  network: string | null
  tx_hash: string | null
  latency_ms: number
  error: string | null
}

export function logPayment(entry: PaymentEntry): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO x402_payments
      (ts, url, method, status, amount_usdc, network, tx_hash, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.url,
    entry.method,
    entry.status,
    entry.amount_usdc,
    entry.network,
    entry.tx_hash,
    entry.latency_ms,
    entry.error,
  )
}

export interface PaymentRollup {
  count: number
  total_usdc: number | null
}

export function paymentsSince(since: Date): PaymentRollup {
  const db = getDb()
  return db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(amount_usdc) AS total_usdc
       FROM x402_payments WHERE ts >= ?`,
    )
    .get(since.toISOString()) as PaymentRollup
}

export interface PaymentRow {
  ts: string
  url: string
  method: string
  status: number
  amount_usdc: number | null
  network: string | null
  tx_hash: string | null
}

export function recentPayments(since: Date, limit = 20): PaymentRow[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT ts, url, method, status, amount_usdc, network, tx_hash
       FROM x402_payments WHERE ts >= ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(since.toISOString(), limit) as PaymentRow[]
}

export interface SpendRollup {
  count: number
  total_cost_usdc: number | null
  total_prompt_tokens: number | null
  total_completion_tokens: number | null
}

export function spendSince(since: Date): SpendRollup {
  const db = getDb()
  return db
    .prepare(
      `SELECT
        COUNT(*) AS count,
        SUM(cost_usdc) AS total_cost_usdc,
        SUM(prompt_tokens) AS total_prompt_tokens,
        SUM(completion_tokens) AS total_completion_tokens
      FROM inference_calls
      WHERE ts >= ?`,
    )
    .get(since.toISOString()) as SpendRollup
}

export interface ModelSpend {
  model: string
  calls: number
  cost: number | null
}

export function spendByModel(since: Date): ModelSpend[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT model, COUNT(*) AS calls, SUM(cost_usdc) AS cost
       FROM inference_calls
       WHERE ts >= ?
       GROUP BY model
       ORDER BY cost DESC`,
    )
    .all(since.toISOString()) as ModelSpend[]
}
