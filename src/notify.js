import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { clamp } from "./util.js";

/**
 * 通知模块职责：
 *  1) 阈值告警：套餐窗口（5 小时 / 周 / 月）余量首次低于阈值、钱包余额首次低于阈值时各推送一次；
 *     对应窗口重置（或余额回升到阈值之上）后解除，可再次触发。
 *  2) 定时汇总：用户设定时间点推送全局余量，按分组、有效优先、余量低的在前、限额的在后。
 *  3) Webhook 投递：钉钉 / 企业微信 / 飞书。
 */

export const WEBHOOK_TYPES = {
  dingtalk: { label: "钉钉" },
  wecom: { label: "企业微信" },
  feishu: { label: "飞书" },
};

export const WEBHOOK_EVENTS = ["threshold", "digest"];

const CURRENCY_SYMBOLS = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", JPY: "¥", GBP: "£", HKD: "HK$", TWD: "NT$" };
const DIGEST_GRACE_MS = 30 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  enabled: true,
  rules: { windowPercent: 20, balanceAmount: 10 },
  digest: { enabled: true, times: ["09:00"], timezone: "Asia/Shanghai" },
  webhooks: [],
};

export class NotificationError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = "NotificationError";
    this.statusCode = status;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function cleanNumber(value, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const parsed = firstNumber(value);
  if (parsed === null) return fallback;
  return clamp(parsed, min, max);
}

export function formatAmount(value, currency) {
  if (!Number.isFinite(value)) return "—";
  const symbol = currency ? CURRENCY_SYMBOLS[String(currency).toUpperCase()] ?? "" : "";
  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 0 : absolute >= 100 ? 1 : 2;
  return `${symbol}${value.toFixed(digits)}`;
}

export function formatPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

export function formatLocalDateTime(iso, timezone) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** 按指定时区取本地日期与 HH:MM（用于定时汇总的时间槽判断）。 */
export function localTimeParts(date, timezone) {
  const build = (timeZone) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  let formatter;
  try {
    formatter = build(timezone);
    formatter.format(date);
  } catch {
    formatter = build("UTC");
  }
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

/** webhook 地址里通常带着机器人 token，返回给前端时做掩码。 */
export function maskUrl(url) {
  const raw = cleanString(url);
  if (raw === "") return "";
  try {
    const parsed = new URL(raw);
    for (const [key, value] of parsed.searchParams) {
      if (value.length <= 8) continue;
      parsed.searchParams.set(key, `${value.slice(0, 4)}***${value.slice(-3)}`);
    }
    return parsed.toString();
  } catch {
    return raw.length > 16 ? `${raw.slice(0, 8)}***${raw.slice(-4)}` : "***";
  }
}

/* ------------------------------- 指标计算 ------------------------------- */

export function windowRemainingPercent(window) {
  if (!isPlainObject(window)) return null;
  if (window.unit === "%" && Number.isFinite(window.remaining)) return clamp(window.remaining, 0, 100);
  if (Number.isFinite(window.limit) && window.limit > 0 && Number.isFinite(window.remaining)) {
    return clamp((window.remaining / window.limit) * 100, 0, 100);
  }
  if (Number.isFinite(window.percent)) return clamp(100 - window.percent, 0, 100);
  return null;
}

function windowIsLimited(window) {
  if (window.status && window.status !== "ok") return true;
  return Number.isFinite(window.percent) && window.percent >= 100;
}

export function balanceRemainingRatio(balance) {
  if (!isPlainObject(balance) || !Number.isFinite(balance.remaining)) return null;
  if (Number.isFinite(balance.total) && balance.total > 0) return clamp(balance.remaining / balance.total, -1, 1);
  return null;
}

/** 汇总单个账户在汇总消息里需要的指标。 */
export function computeAccountMetrics(account, result, { typeLabels = {} } = {}) {
  const windows = Array.isArray(result?.windows) ? result.windows.filter(isPlainObject) : [];
  const group = cleanString(account.group) || typeLabels[account.type] || account.type;
  const metrics = {
    accountId: account.id,
    name: account.name,
    type: account.type,
    typeLabel: typeLabels[account.type] ?? account.type,
    group,
    ok: Boolean(result?.ok),
    status: result?.ok ? "ok" : "error",
    error: result?.error ?? null,
    remainingRatio: null,
    remainingPercent: null,
    worstWindow: null,
    planName: result?.plan?.name ?? null,
    balance: result?.balance ?? null,
    windows,
  };

  if (!result?.ok) return metrics;

  const percents = [];
  for (const window of windows) {
    const percent = windowRemainingPercent(window);
    if (percent !== null) percents.push({ window, percent });
  }
  if (percents.length > 0) {
    const worst = percents.reduce((a, b) => (b.percent < a.percent ? b : a));
    metrics.worstWindow = { key: worst.window.key, label: worst.window.label, remainingPercent: worst.percent };
    metrics.remainingPercent = worst.percent;
    metrics.remainingRatio = worst.percent / 100;
  } else {
    const ratio = balanceRemainingRatio(result.balance);
    if (ratio !== null) {
      metrics.remainingRatio = ratio;
      metrics.remainingPercent = ratio * 100;
    }
  }

  const limited =
    windows.some(windowIsLimited) ||
    (Number.isFinite(result.balance?.remaining) && result.balance.remaining <= 0) ||
    result.plan?.active === false;
  metrics.status = limited ? "limited" : "ok";
  return metrics;
}

function metricRank(metrics) {
  if (metrics.status === "error") return 3;
  if (metrics.status === "limited") return 2;
  return metrics.remainingRatio === null ? 1 : 0;
}

/** 有效在前、余量低的在前、限额的在后、出错最后。 */
export function compareMetrics(a, b) {
  const rankA = metricRank(a);
  const rankB = metricRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 0) return a.remainingRatio - b.remainingRatio;
  return String(a.name).localeCompare(String(b.name), "zh-CN");
}

function metricLine(metrics) {
  if (metrics.status === "error") return `请求失败：${metrics.error ?? "未知错误"}`;
  const parts = [];
  const balance = metrics.balance;
  if (Number.isFinite(balance?.remaining)) {
    let text = formatAmount(balance.remaining, balance.currency);
    if (Number.isFinite(balance.total) && balance.total > 0) {
      text += ` / ${formatAmount(balance.total, balance.currency)}`;
    }
    parts.push(text);
  }
  if (metrics.worstWindow) {
    parts.push(`最低余量 ${metrics.worstWindow.label} ${formatPercent(metrics.worstWindow.remainingPercent)}`);
  } else if (Number.isFinite(metrics.remainingPercent)) {
    parts.push(`剩余 ${formatPercent(metrics.remainingPercent)}`);
  }
  if (parts.length === 0) parts.push("无可用余量数据");
  const suffix = metrics.status === "limited" ? "（已限额）" : "";
  return `${parts.join(" · ")}${suffix}`;
}

/* ------------------------------ 阈值判定 ------------------------------- */

function windowStateKey(accountId, windowKey) {
  return `${accountId}|window:${windowKey}`;
}

function balanceStateKey(accountId) {
  return `${accountId}|balance`;
}

function thresholdFor(account, settings) {
  const override = isPlainObject(account.thresholds) ? account.thresholds : {};
  return {
    windowPercent: cleanNumber(override.windowPercent, {
      min: 0,
      max: 100,
      fallback: settings.rules.windowPercent,
    }),
    balanceAmount: cleanNumber(override.balanceAmount, { min: 0, fallback: settings.rules.balanceAmount }),
  };
}

/**
 * 单个窗口/余额的状态机：
 *  - 低于阈值且未处于已通知状态 → 触发
 *  - 回升到阈值之上（重置）或 resetAt 前进到新一轮 → 解除，可再次触发
 *  - resetAt 已过期但数值仍低于阈值（上游尚未刷新）→ 保持已通知，不重复触发
 * 这样短周期窗口刷新时，不会让尚未刷新的长周期窗口反复告警。
 */
function evaluateThresholdEntry({ previous, below, resetAt, value, now }) {
  const state = previous && isPlainObject(previous) ? { ...previous } : { notified: false };
  let fire = false;

  const recovered = !below;
  const resetAdvanced =
    Boolean(resetAt) && Boolean(state.resetAt) && new Date(resetAt).getTime() > new Date(state.resetAt).getTime();

  if (recovered || resetAdvanced) state.notified = false;

  if (below && !state.notified) {
    state.notified = true;
    fire = true;
  }

  state.value = value;
  state.below = below;
  if (resetAt) state.resetAt = resetAt;
  state.checkedAt = now;
  return { state, fire };
}

export function evaluateThresholds(accounts, results, settings, previousState, now = new Date()) {
  const nowIso = now.toISOString();
  const state = isPlainObject(previousState) ? { ...previousState } : {};
  const events = [];
  const activeKeys = new Set();

  for (const account of accounts) {
    const result = results?.[account.id];
    if (!result) continue;
    const thresholds = thresholdFor(account, settings);

    // 套餐窗口：5 小时 / 周 / 月（以及上游返回的其它窗口）各自独立计数
    for (const window of Array.isArray(result.windows) ? result.windows : []) {
      if (!isPlainObject(window) || !window.key) continue;
      const remainingPercent = windowRemainingPercent(window);
      if (remainingPercent === null) continue;
      const key = windowStateKey(account.id, window.key);
      activeKeys.add(key);
      const { state: next, fire } = evaluateThresholdEntry({
        previous: state[key],
        below: remainingPercent < thresholds.windowPercent,
        resetAt: window.resetAt,
        value: remainingPercent,
        now: nowIso,
      });
      state[key] = next;
      if (fire) {
        events.push({
          kind: "window",
          accountId: account.id,
          accountName: account.name,
          group: cleanString(account.group) || account.type,
          typeLabel: account.type,
          planName: result.plan?.name ?? null,
          windowKey: window.key,
          windowLabel: window.label ?? window.key,
          remainingPercent,
          limit: window.limit,
          remaining: window.remaining,
          currency: window.currency,
          unit: window.unit,
          resetAt: window.resetAt ?? null,
          thresholdPercent: thresholds.windowPercent,
        });
      }
    }

    // 钱包余额：没有窗口额度时才按金额阈值判断（套餐账户走上面的窗口规则）
    const hasWindows = Array.isArray(result.windows) && result.windows.length > 0;
    if (!hasWindows && Number.isFinite(result.balance?.remaining) && thresholds.balanceAmount > 0) {
      const key = balanceStateKey(account.id);
      activeKeys.add(key);
      const { state: next, fire } = evaluateThresholdEntry({
        previous: state[key],
        below: result.balance.remaining < thresholds.balanceAmount,
        resetAt: null,
        value: result.balance.remaining,
        now: nowIso,
      });
      state[key] = next;
      if (fire) {
        events.push({
          kind: "balance",
          accountId: account.id,
          accountName: account.name,
          group: cleanString(account.group) || account.type,
          typeLabel: account.type,
          planName: result.plan?.name ?? null,
          remaining: result.balance.remaining,
          currency: result.balance.currency,
          thresholdAmount: thresholds.balanceAmount,
        });
      }
    }
  }

  // 账号被删除后清理其状态，避免残留
  for (const key of Object.keys(state)) {
    if (!activeKeys.has(key)) delete state[key];
  }

  return { events, state };
}

/* ------------------------------ 消息构建 ------------------------------- */

function header(title, now, timezone) {
  const stamp = formatLocalDateTime(now.toISOString(), timezone) ?? now.toISOString();
  return `**【${title}】** ${stamp}`;
}

export function buildThresholdMessage(events, { now = new Date(), timezone } = {}) {
  const lines = [header("余量告警", now, timezone), ""];
  const byAccount = new Map();
  for (const event of events) {
    if (!byAccount.has(event.accountId)) byAccount.set(event.accountId, []);
    byAccount.get(event.accountId).push(event);
  }
  for (const group of byAccount.values()) {
    const first = group[0];
    const plan = first.planName ? ` · ${first.planName}` : "";
    lines.push(`**${first.accountName}**（${first.typeLabel}${plan}）`);
    for (const event of group) {
      if (event.kind === "window") {
        const remainingText =
          event.unit === "%"
            ? `剩余 ${formatPercent(event.remainingPercent)}`
            : `剩余 ${formatAmount(event.remaining, event.currency)}${
                Number.isFinite(event.limit) ? ` / ${formatAmount(event.limit, event.currency)}` : ""
              }（${formatPercent(event.remainingPercent)}）`;
        const reset = event.resetAt ? `，重置 ${formatLocalDateTime(event.resetAt, timezone) ?? event.resetAt}` : "";
        lines.push(
          `- ${event.windowLabel}：${remainingText}，低于阈值 ${formatPercent(event.thresholdPercent, 0)}${reset}`,
        );
      } else {
        lines.push(
          `- 钱包余额：${formatAmount(event.remaining, event.currency)}，低于阈值 ${formatAmount(
            event.thresholdAmount,
            event.currency,
          )}，恢复后重新计数`,
        );
      }
    }
    lines.push("");
  }
  return { title: "余量告警", markdown: lines.join("\n").trim() };
}

export function buildDigestSections(accounts, results, { typeLabels = {} } = {}) {
  const byGroup = new Map();
  for (const account of accounts) {
    const result = results?.[account.id];
    if (!result) continue;
    const metrics = computeAccountMetrics(account, result, { typeLabels });
    if (!byGroup.has(metrics.group)) byGroup.set(metrics.group, []);
    byGroup.get(metrics.group).push(metrics);
  }
  const sections = [...byGroup.entries()].map(([group, items]) => {
    items.sort(compareMetrics);
    return { group, items, worst: items[0] };
  });
  sections.sort((a, b) => compareMetrics(a.worst, b.worst));
  return sections;
}

export function buildDigestMessage(sections, { now = new Date(), timezone } = {}) {
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  const limited = sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.status === "limited").length,
    0,
  );
  const failed = sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.status === "error").length,
    0,
  );
  const summary = [`共 ${total} 个账户`];
  if (limited > 0) summary.push(`${limited} 个限额`);
  if (failed > 0) summary.push(`${failed} 个异常`);

  const lines = [header("全局余量汇总", now, timezone), summary.join(" · "), ""];
  if (sections.length === 0) lines.push("暂无账户数据");
  for (const section of sections) {
    lines.push(`**${section.group}**（${section.items.length} 个）`);
    for (const item of section.items) lines.push(`- ${item.name}：${metricLine(item)}`);
    lines.push("");
  }
  return { title: "全局余量汇总", markdown: lines.join("\n").trim() };
}

/* ------------------------------ Webhook 投递 ------------------------------ */

/**
 * 钉钉与飞书虽然都用 HMAC-SHA256，但 key / data 的位置相反：
 *  - 钉钉：key = secret，data = `${timestamp}\n${secret}`
 *  - 飞书：key = `${timestamp}\n${secret}`，data = 空
 * 用错会导致平台返回 310000 / sign not match。
 */
function dingTalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
}

function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

export function buildWebhookPayload(webhook, title, markdown) {
  if (webhook.type === "dingtalk") {
    return { msgtype: "markdown", markdown: { title, text: markdown }, at: { isAtAll: false } };
  }
  if (webhook.type === "wecom") {
    return { msgtype: "markdown", markdown: { content: markdown } };
  }
  if (webhook.type === "feishu") {
    return {
      msg_type: "interactive",
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: "plain_text", content: title }, template: "blue" },
        elements: [{ tag: "div", text: { tag: "lark_md", content: markdown } }],
      },
    };
  }
  throw new NotificationError(`不支持的通知类型：${webhook.type}`);
}

export function buildWebhookUrl(webhook, now = new Date()) {
  const url = cleanString(webhook.url);
  if (!url) throw new NotificationError("Webhook 地址为空");
  const secret = cleanString(webhook.secret);
  // 企业微信的 key 直接在 URL 上，不需要加签
  if (!secret || webhook.type !== "dingtalk") return url;
  const timestamp = String(now.getTime());
  const parsed = new URL(url);
  parsed.searchParams.set("timestamp", timestamp);
  parsed.searchParams.set("sign", dingTalkSign(secret, timestamp));
  return parsed.toString();
}

function webhookError(payload) {
  if (!isPlainObject(payload)) return null;
  const code = firstNumber(payload.errcode, payload.code, payload.StatusCode);
  if (code === null || code === 0) return null;
  return cleanString(payload.errmsg) || cleanString(payload.msg) || cleanString(payload.error) || `返回码 ${code}`;
}

export async function sendWebhook(webhook, message, { now = new Date(), timeoutMs = 10000 } = {}) {
  const payload = buildWebhookPayload(webhook, message.title, message.markdown);
  const url = buildWebhookUrl(webhook, now);
  if (webhook.type === "feishu" && cleanString(webhook.secret)) {
    const timestamp = String(Math.floor(now.getTime() / 1000));
    payload.timestamp = timestamp;
    payload.sign = feishuSign(cleanString(webhook.secret), timestamp);
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.message ?? "网络错误";
    throw new NotificationError(`Webhook 请求失败：${reason}`, { status: 502 });
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new NotificationError(`Webhook 返回 HTTP ${response.status}：${text.slice(0, 200)}`, { status: 502 });
  }
  const error = webhookError(parsed);
  if (error) throw new NotificationError(`Webhook 返回错误：${error}`, { status: 502 });
  return { ok: true, response: parsed ?? text };
}

export async function deliverToWebhooks(webhooks, event, message, options = {}) {
  const targets = webhookTargets(webhooks, event);
  const results = [];
  for (const webhook of targets) {
    try {
      await sendWebhook(webhook, message, options);
      results.push({ id: webhook.id, name: webhook.name, ok: true });
    } catch (error) {
      results.push({ id: webhook.id, name: webhook.name, ok: false, error: error.message });
    }
  }
  return results;
}

export function webhookTargets(webhooks, event) {
  return (webhooks ?? []).filter(
    (webhook) => webhook && webhook.enabled !== false && (webhook.events ?? WEBHOOK_EVENTS).includes(event),
  );
}

/* ------------------------------ 定时汇总判定 ------------------------------ */

function normalizeTimes(times) {
  const list = Array.isArray(times) ? times : cleanString(times).split(/[,，\s]+/);
  const valid = [];
  for (const item of list) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(cleanString(item));
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    valid.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return [...new Set(valid)].sort();
}

/** 返回当前应发送 / 应跳过的定时汇总槽位（超出补发窗口的槽位记为 skipped）。 */
export function dueDigestSlots(settings, state, now = new Date(), graceMs = DIGEST_GRACE_MS) {
  const digest = settings?.digest ?? {};
  const slots = { due: [], consumed: [] };
  if (!settings?.enabled || digest.enabled === false) return slots;
  const times = normalizeTimes(digest.times);
  if (times.length === 0) return slots;
  const timezone = digest.timezone || "UTC";
  const { date, time } = localTimeParts(now, timezone);
  const nowMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const sent = state?.digests ?? {};

  for (const slot of times) {
    const key = `${date}@${slot}`;
    if (sent[key]) continue;
    const slotMinutes = Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3));
    if (nowMinutes < slotMinutes) continue;
    if ((nowMinutes - slotMinutes) * 60 * 1000 <= graceMs) slots.due.push({ key, slot });
    else slots.consumed.push({ key, slot });
  }
  return slots;
}

/* ------------------------------ 设置持久化 ------------------------------ */

function normalizeWebhook(input, existing) {
  const source = isPlainObject(input) ? input : {};
  const type = cleanString(source.type);
  if (!WEBHOOK_TYPES[type]) throw new NotificationError(`不支持的通知类型：${type || "(空)"}`);
  const url = cleanString(source.url);
  const resolvedUrl = url !== "" ? url : cleanString(existing?.url);
  if (resolvedUrl === "") throw new NotificationError("Webhook 地址不能为空");
  if (!/^https?:\/\//i.test(resolvedUrl)) throw new NotificationError("Webhook 地址需要以 http:// 或 https:// 开头");
  const events = Array.isArray(source.events)
    ? source.events.map((item) => cleanString(item)).filter((item) => WEBHOOK_EVENTS.includes(item))
    : existing?.events ?? [...WEBHOOK_EVENTS];
  return {
    id: cleanString(source.id) || existing?.id || crypto.randomUUID(),
    name: cleanString(source.name) || existing?.name || WEBHOOK_TYPES[type].label,
    type,
    url: resolvedUrl,
    secret: source.secret === undefined ? existing?.secret ?? "" : cleanString(source.secret),
    enabled: source.enabled === undefined ? existing?.enabled !== false : Boolean(source.enabled),
    events: events.length > 0 ? events : [...WEBHOOK_EVENTS],
  };
}

const TIMEZONE_RE = /^[A-Za-z_]+\/[A-Za-z_+-]+$|^UTC$/;

export function normalizeSettings(input, existing = DEFAULT_SETTINGS) {
  const source = isPlainObject(input) ? input : {};
  const previous = isPlainObject(existing) ? existing : DEFAULT_SETTINGS;
  const rulesInput = isPlainObject(source.rules) ? source.rules : {};
  const digestInput = isPlainObject(source.digest) ? source.digest : {};
  const previousById = new Map((previous.webhooks ?? []).map((webhook) => [webhook.id, webhook]));

  const webhooks = [];
  if (Array.isArray(source.webhooks)) {
    for (const item of source.webhooks) {
      const id = cleanString(item?.id);
      webhooks.push(normalizeWebhook(item, id ? previousById.get(id) : null));
    }
  } else {
    webhooks.push(...(previous.webhooks ?? []));
  }

  const timezone = cleanString(digestInput.timezone) || previous.digest?.timezone || "Asia/Shanghai";
  return {
    enabled: source.enabled === undefined ? previous.enabled !== false : Boolean(source.enabled),
    rules: {
      windowPercent: cleanNumber(rulesInput.windowPercent, {
        min: 0,
        max: 100,
        fallback: previous.rules?.windowPercent ?? DEFAULT_SETTINGS.rules.windowPercent,
      }),
      balanceAmount: cleanNumber(rulesInput.balanceAmount, {
        min: 0,
        fallback: previous.rules?.balanceAmount ?? DEFAULT_SETTINGS.rules.balanceAmount,
      }),
    },
    digest: {
      enabled: digestInput.enabled === undefined ? previous.digest?.enabled !== false : Boolean(digestInput.enabled),
      times: normalizeTimes(digestInput.times ?? previous.digest?.times ?? DEFAULT_SETTINGS.digest.times),
      timezone: TIMEZONE_RE.test(timezone) ? timezone : "Asia/Shanghai",
    },
    webhooks,
  };
}

export function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    rules: settings.rules,
    digest: settings.digest,
    webhooks: (settings.webhooks ?? []).map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      type: webhook.type,
      typeLabel: WEBHOOK_TYPES[webhook.type]?.label ?? webhook.type,
      urlHint: maskUrl(webhook.url),
      hasSecret: Boolean(cleanString(webhook.secret)),
      enabled: webhook.enabled !== false,
      events: webhook.events ?? [...WEBHOOK_EVENTS],
    })),
  };
}

export class NotificationStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.settings = { ...DEFAULT_SETTINGS, webhooks: [] };
    this.state = { thresholds: {}, digests: {} };
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.settings = normalizeSettings(parsed.settings ?? {}, DEFAULT_SETTINGS);
      this.state = {
        thresholds: isPlainObject(parsed.state?.thresholds) ? parsed.state.thresholds : {},
        digests: isPlainObject(parsed.state?.digests) ? parsed.state.digests : {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[notify] 无法读取 ${this.filePath}: ${error.message}`);
    }
    return this;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: 1, settings: this.settings, state: this.state }, null, 2);
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  getSettings() {
    return this.settings;
  }

  updateSettings(input) {
    const previousRules = this.settings.rules ?? {};
    this.settings = normalizeSettings(input, this.settings);
    const nextRules = this.settings.rules ?? {};
    // 阈值变化会让历史的“已通知”判断失效，这里重新计数，避免改了阈值却不再告警
    if (
      previousRules.windowPercent !== nextRules.windowPercent ||
      previousRules.balanceAmount !== nextRules.balanceAmount
    ) {
      this.state.thresholds = {};
    }
    this.persist();
    return this.settings;
  }

  getThresholdState() {
    return this.state.thresholds;
  }

  setThresholdState(state) {
    this.state.thresholds = state;
  }

  markDigest(key, value) {
    this.state.digests[key] = value;
    const keys = Object.keys(this.state.digests).sort();
    for (const stale of keys.slice(0, Math.max(0, keys.length - 60))) delete this.state.digests[stale];
  }

  pruneDigests(now = new Date()) {
    const cutoff = now.getTime() - 30 * 24 * 3600 * 1000;
    for (const [key, value] of Object.entries(this.state.digests)) {
      const iso = value?.sentAt ?? value?.skippedAt;
      if (iso && new Date(iso).getTime() < cutoff) delete this.state.digests[key];
    }
  }
}

/* ------------------------------ 调度器 ------------------------------ */

/**
 * 后台循环：定期拉取余量 → 判定阈值 → 发送告警；到点发送全局汇总。
 * 返回 { stop, runOnce }，测试可直接调用 runOnce 驱动。
 */
export function startNotificationScheduler({
  store,
  notificationStore,
  getBalances,
  typeLabels = {},
  intervalMs = 60000,
  now = () => new Date(),
  logger = console,
} = {}) {
  let running = false;

  const runOnce = async ({ force = false } = {}) => {
    if (running) return { skipped: true };
    running = true;
    const at = now();
    try {
      const accounts = store.list();
      const settings = notificationStore.getSettings();
      const summary = { thresholds: [], digests: [] };
      if (!settings.enabled) return summary;

      const list = await getBalances(accounts, { force });
      const results = {};
      for (const result of list) results[result.accountId] = result;

      const { events, state } = evaluateThresholds(
        accounts,
        results,
        settings,
        notificationStore.getThresholdState(),
        at,
      );
      if (events.length > 0) {
        if (webhookTargets(settings.webhooks, "threshold").length === 0) {
          // 还没配置可用的 Webhook：不消费事件，等配置好之后仍会告警
          logger.warn?.("[notify] 检测到余量低于阈值，但没有可用的 Webhook，暂不记录告警状态");
        } else {
          const message = buildThresholdMessage(events, { now: at, timezone: settings.digest.timezone });
          summary.thresholds = await deliverToWebhooks(settings.webhooks, "threshold", message);
          for (const failure of summary.thresholds.filter((item) => !item.ok)) {
            logger.warn?.(`[notify] 阈值告警发送失败（${failure.name}）：${failure.error}`);
          }
          // 只有至少一个 Webhook 投递成功才落状态，否则下个周期继续重试
          if (summary.thresholds.some((item) => item.ok)) {
            notificationStore.setThresholdState(state);
          } else {
            logger.warn?.("[notify] 本轮阈值告警全部投递失败，将在下个周期重试");
          }
        }
      } else {
        notificationStore.setThresholdState(state);
      }

      const slots = dueDigestSlots(settings, notificationStore.state, at);
      for (const item of slots.consumed) {
        notificationStore.markDigest(item.key, { skippedAt: at.toISOString(), reason: "超出补发窗口" });
      }
      if (slots.due.length > 0) {
        if (webhookTargets(settings.webhooks, "digest").length === 0) {
          // 没有可投递目标时保留槽位，用户补上 Webhook 后仍能在补发窗口内收到
          logger.warn?.("[notify] 到了汇总时间点但没有可用的 Webhook，本次跳过并等待配置");
        } else {
          const fresh = await getBalances(accounts, { force: true });
          const freshResults = {};
          for (const result of fresh) freshResults[result.accountId] = result;
          const sections = buildDigestSections(accounts, freshResults, { typeLabels });
          const message = buildDigestMessage(sections, { now: at, timezone: settings.digest.timezone });
          for (const item of slots.due) {
            const deliveries = await deliverToWebhooks(settings.webhooks, "digest", message);
            summary.digests.push({ slot: item.key, deliveries });
            for (const failure of deliveries.filter((entry) => !entry.ok)) {
              logger.warn?.(`[notify] 定时汇总发送失败（${failure.name}）：${failure.error}`);
            }
            if (deliveries.some((entry) => entry.ok)) {
              notificationStore.markDigest(item.key, {
                sentAt: at.toISOString(),
                results: deliveries.map((entry) => ({ id: entry.id, ok: entry.ok, error: entry.error ?? null })),
              });
            } else {
              logger.warn?.("[notify] 本轮汇总全部投递失败，将在补发窗口内重试");
            }
          }
        }
      }
      notificationStore.pruneDigests(at);
      notificationStore.persist();
      return summary;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    runOnce().catch((error) => logger.error?.(`[notify] 调度失败：${error.message}`));
  }, Math.max(15000, intervalMs));
  timer.unref?.();

  return { runOnce, stop: () => clearInterval(timer) };
}
