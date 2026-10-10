import {
  asDate,
  clamp,
  firstBoolean,
  firstNumber,
  firstString,
  isPlainObject,
  normalizeBaseUrl,
  parseNumber,
  pathGet,
  percentOf,
  round,
} from "./util.js";

const WINDOW_RANK = { "5h": 0, daily: 1, weekly: 2, monthly: 3 };
export const WINDOW_LABELS = { "5h": "5 小时", daily: "今日", weekly: "本周", monthly: "本月" };

export class ProviderError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

function errorMessage(payload, fallback) {
  if (isPlainObject(payload)) {
    return (
      firstString(
        payload.message,
        payload.msg,
        payload.error?.message,
        typeof payload.error === "string" ? payload.error : null,
        payload.detail,
      ) ?? fallback
    );
  }
  if (typeof payload === "string" && payload.trim() !== "") return payload.slice(0, 300);
  return fallback;
}

const NETWORK_ERROR_HINTS = {
  ECONNREFUSED: "连接被拒绝",
  ECONNRESET: "连接被重置",
  ENOTFOUND: "域名无法解析",
  EAI_AGAIN: "DNS 解析失败",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "目标主机不可达",
  ENETUNREACH: "网络不可达",
  CERT_HAS_EXPIRED: "TLS 证书已过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书为自签名",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书链无法验证",
};

function describeFetchError(error) {
  const code = error?.cause?.code ?? error?.code;
  const hint = code ? NETWORK_ERROR_HINTS[code] : null;
  if (hint) return `${hint}（${code}）`;
  if (error?.cause?.message) return `${error.message}：${error.cause.message}`;
  return error?.message ?? "未知错误";
}

export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000, label = "接口" } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new ProviderError(`${label} 请求超时`, { status: 0 });
    }
    throw new ProviderError(`${label} 请求失败：${describeFetchError(error)}`, { status: 0 });
  }

  const text = await response.text();
  let payload = null;
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError(`${label} 返回了非 JSON 内容`, { status: response.status, body: text.slice(0, 300) });
    }
  }

  if (!response.ok) {
    throw new ProviderError(`${label} 返回 HTTP ${response.status}：${errorMessage(payload, response.statusText)}`, {
      status: response.status,
      body: payload ?? text.slice(0, 300),
    });
  }
  if (payload === null) {
    throw new ProviderError(`${label} 返回了空响应`, { status: response.status });
  }
  return payload;
}

function makeWindow({ key, label, limit, used, remaining, percent, resetAt, currency, unit, status }) {
  const numericLimit = parseNumber(limit);
  const numericUsed = parseNumber(used);
  let numericRemaining = parseNumber(remaining);
  if (numericRemaining === null && numericLimit !== null && numericUsed !== null) {
    numericRemaining = numericLimit - numericUsed;
  }
  let numericPercent = parseNumber(percent);
  if (numericPercent === null) numericPercent = percentOf(numericUsed ?? 0, numericLimit);
  if (numericLimit === null && numericRemaining !== null && numericUsed !== null) {
    // 仅知道剩余与已用时，补全额度
    const implicitLimit = numericRemaining + numericUsed;
    return makeWindow({
      key,
      label,
      limit: implicitLimit,
      used: numericUsed,
      remaining: numericRemaining,
      percent: numericPercent,
      resetAt,
      currency,
      unit,
      status,
    });
  }
  if (numericLimit === null && numericRemaining === null && numericUsed === null && numericPercent === null) return null;
  return {
    key,
    label: label ?? WINDOW_LABELS[key] ?? key,
    limit: round(numericLimit, 6),
    used: round(numericUsed, 6),
    remaining: round(numericRemaining, 6),
    percent: numericPercent === null ? null : round(numericPercent, 3),
    resetAt: asDate(resetAt),
    currency: currency ?? null,
    unit: unit ?? null,
    status: status ?? null,
  };
}

function sortWindows(windows) {
  return windows
    .filter(Boolean)
    .sort((a, b) => (WINDOW_RANK[a.key] ?? 9) - (WINDOW_RANK[b.key] ?? 9));
}

function baseResult(account) {
  return {
    accountId: account.id,
    name: account.name,
    type: account.type,
    ok: true,
    fetchedAt: new Date().toISOString(),
    currency: null,
    subject: null,
    balance: null,
    windows: [],
    plan: null,
    autoReload: null,
    raw: null,
  };
}

/* ------------------------------- New API ------------------------------- */

export async function fetchNewApi(account, { timeoutMs = 15000 } = {}) {
  const base = normalizeBaseUrl(account.baseUrl);
  const headers = {
    Authorization: `Bearer ${account.key}`,
    Accept: "application/json",
  };
  const self = await fetchJson(`${base}/api/user/self`, { headers, timeoutMs, label: "New API" });
  if (self.success === false) {
    throw new ProviderError(errorMessage(self, "New API 拒绝访问"), { status: 401, body: self });
  }
  const data = isPlainObject(self.data) ? self.data : self;
  const quota = firstNumber(data.quota);
  const usedQuota = firstNumber(data.used_quota) ?? 0;
  if (quota === null) {
    throw new ProviderError("New API 响应中缺少 quota 字段", { body: self });
  }

  let quotaPerUnit = parseNumber(account.options?.quotaPerUnit);
  let currency = firstString(account.options?.currency);
  let unit = null;
  if (quotaPerUnit === null || quotaPerUnit <= 0 || !currency) {
    try {
      const status = await fetchJson(`${base}/api/status`, { headers, timeoutMs, label: "New API 状态" });
      const statusData = isPlainObject(status.data) ? status.data : status;
      const displayType = firstString(statusData.quota_display_type, statusData.display_in_currency === false ? "TOKENS" : null);
      if (quotaPerUnit === null || quotaPerUnit <= 0) {
        quotaPerUnit = firstNumber(statusData.quota_per_unit) ?? 500000;
      }
      if (!currency) {
        if (displayType === "TOKENS") {
          unit = "额度";
          quotaPerUnit = 1;
        } else if (displayType && displayType !== "TOKENS") {
          currency = displayType;
        } else {
          currency = "USD";
        }
      }
    } catch {
      quotaPerUnit = quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 500000;
      currency = currency ?? "USD";
    }
  }

  const result = baseResult(account);
  result.currency = currency ?? null;
  result.subject = {
    label: firstString(data.username, data.display_name, data.email) ?? "New API 账户",
    detail: firstString(data.group) ? `分组 ${data.group}` : null,
  };
  result.balance = {
    remaining: round(quota / quotaPerUnit, 4),
    used: round(usedQuota / quotaPerUnit, 4),
    total: round((quota + usedQuota) / quotaPerUnit, 4),
    currency: currency ?? null,
    unit: unit,
  };
  result.raw = self;
  return result;
}

/* ------------------------------- Sub2API ------------------------------- */

const sub2TokenCache = new Map();

export function sub2AuthMode(account) {
  const mode = account?.options?.authMode;
  return mode === "token" || mode === "password" ? mode : "apikey";
}

function plusDays(value, days) {
  const iso = asDate(value);
  if (!iso) return null;
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function sub2UsageWindowKey(raw) {
  if (raw === "5h") return "5h";
  if (raw === "1d" || raw === "24h") return "daily";
  if (raw === "7d") return "weekly";
  if (raw === "30d") return "monthly";
  return typeof raw === "string" && raw !== "" ? raw : "window";
}

function unwrapSub2(payload) {
  if (isPlainObject(payload) && typeof payload.code === "number") {
    if (payload.code !== 0) {
      throw new ProviderError(errorMessage(payload, `Sub2API 返回 code ${payload.code}`), { status: 400, body: payload });
    }
    return payload.data;
  }
  return payload;
}

async function sub2Login(account, timeoutMs) {
  const base = normalizeBaseUrl(account.baseUrl);
  const payload = await fetchJson(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: account.options?.email, password: account.key }),
    timeoutMs,
    label: "Sub2API 登录",
  });
  const data = unwrapSub2(payload);
  const token = firstString(data?.access_token, data?.token);
  if (!token) throw new ProviderError("Sub2API 登录未返回 access_token", { body: payload });
  const expiresIn = firstNumber(data?.expires_in) ?? 3600;
  sub2TokenCache.set(account.id, {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  });
  return token;
}

async function sub2Token(account, timeoutMs, { forceLogin = false } = {}) {
  const usePasswordLogin = account.options?.authMode === "password";
  if (!usePasswordLogin) return account.key;
  const cached = sub2TokenCache.get(account.id);
  if (!forceLogin && cached && cached.expiresAt > Date.now()) return cached.token;
  return sub2Login(account, timeoutMs);
}

function progressWindows(progressEntries, currency) {
  const windows = [];
  const entries = Array.isArray(progressEntries) ? progressEntries : [];
  const multiple = entries.length > 1;
  for (const entry of entries) {
    const progress = entry?.progress ?? entry;
    if (!isPlainObject(progress)) continue;
    const groupName = firstString(progress.group_name, entry?.subscription?.group_name);
    for (const [key, aliases] of [
      ["daily", ["daily"]],
      ["weekly", ["weekly"]],
      ["monthly", ["monthly"]],
    ]) {
      const window = progress[key];
      if (!isPlainObject(window)) continue;
      const label = multiple && groupName ? `${groupName} · ${WINDOW_LABELS[key]}` : WINDOW_LABELS[key];
      windows.push(
        makeWindow({
          key,
          label,
          limit: firstNumber(window.limit_usd, window.limit, window.total_usd),
          used: firstNumber(window.used_usd, window.used),
          remaining: firstNumber(window.remaining_usd, window.remaining),
          percent: firstNumber(window.percentage, window.percent),
          resetAt: firstString(window.resets_at, window.resetsAt),
          currency,
          unit: aliases[0],
        }),
      );
    }
  }
  return sortWindows(windows);
}

function summaryWindows(summary, currency) {
  const subscriptions = Array.isArray(summary?.subscriptions) ? summary.subscriptions : [];
  const multiple = subscriptions.length > 1;
  const windows = [];
  for (const item of subscriptions) {
    const groupName = firstString(item.group_name, item.groupName);
    for (const key of ["daily", "weekly", "monthly"]) {
      const limit = firstNumber(item[`${key}_limit_usd`], item[`${key}LimitUsd`]);
      const used = firstNumber(item[`${key}_used_usd`], item[`${key}UsedUsd`]);
      if (limit === null && used === null) continue;
      const label = multiple && groupName ? `${groupName} · ${WINDOW_LABELS[key]}` : WINDOW_LABELS[key];
      windows.push(makeWindow({ key, label, limit, used, currency }));
    }
  }
  return sortWindows(windows);
}

/**
 * 解析 Sub2API 网关 /v1/usage 的响应（API Key 鉴权）。上游有三种模式：
 *  - unrestricted + 钱包余额：balance / remaining / unit / usage / daily_usage / model_stats
 *  - unrestricted + 订阅分组：planName + subscription.{daily,weekly,monthly}_{usage,limit}_usd
 *  - quota_limited：quota{limit,used,remaining} + rate_limits[{window:5h|1d|7d,...}]
 */
export function normalizeSub2Usage(payload, account) {
  const data = unwrapSub2(payload);
  if (!isPlainObject(data)) {
    throw new ProviderError("Sub2API /v1/usage 返回了非对象响应", { body: payload });
  }

  const mode = firstString(data.mode) ?? "unrestricted";
  const isValid = firstBoolean(data.isValid);
  const status = firstString(data.status);
  const quota = isPlainObject(data.quota) ? data.quota : null;
  const subscription = isPlainObject(data.subscription) ? data.subscription : null;
  const usage = isPlainObject(data.usage) ? data.usage : null;
  const total = isPlainObject(usage?.total) ? usage.total : null;
  const today = isPlainObject(usage?.today) ? usage.today : null;
  const currency = firstString(data.unit, data.currency, quota?.unit) ?? "USD";
  const planName =
    firstString(data.planName, data.plan_name) ??
    (mode === "quota_limited" ? "API Key 额度" : subscription ? "订阅套餐" : "钱包余额");

  if (isValid === false) {
    throw new ProviderError(`Sub2API 密钥不可用${status ? `（${status}）` : ""}`, { status: 401, body: payload });
  }

  // 周期额度：优先 rate_limits（quota_limited），其次订阅分组信息
  const windows = [];
  for (const entry of Array.isArray(data.rate_limits) ? data.rate_limits : []) {
    if (!isPlainObject(entry)) continue;
    const key = sub2UsageWindowKey(firstString(entry.window));
    windows.push(
      makeWindow({
        key,
        label: WINDOW_LABELS[key] ?? firstString(entry.window) ?? key,
        limit: firstNumber(entry.limit),
        used: firstNumber(entry.used),
        remaining: firstNumber(entry.remaining),
        resetAt: firstString(entry.reset_at, entry.resets_at),
        currency,
      }),
    );
  }
  if (subscription) {
    windows.push(
      makeWindow({
        key: "daily",
        limit: firstNumber(subscription.daily_limit_usd, subscription.daily_limit),
        used: firstNumber(subscription.daily_usage_usd, subscription.daily_used_usd),
        currency,
      }),
      makeWindow({
        key: "weekly",
        limit: firstNumber(subscription.weekly_limit_usd, subscription.weekly_limit),
        used: firstNumber(subscription.weekly_usage_usd, subscription.weekly_used_usd),
        resetAt: plusDays(firstString(subscription.weekly_window_start), 7),
        currency,
      }),
      makeWindow({
        key: "monthly",
        limit: firstNumber(subscription.monthly_limit_usd, subscription.monthly_limit),
        used: firstNumber(subscription.monthly_usage_usd, subscription.monthly_used_usd),
        currency,
      }),
    );
  }

  const remaining = firstNumber(quota?.remaining, data.remaining, data.balance);
  const limit = firstNumber(quota?.limit, data.limit);
  let used = firstNumber(quota?.used, data.used);
  if (used === null && mode !== "quota_limited") {
    // 钱包/订阅模式没有额度已用值，用实际扣费（回退到标价）表示已用金额
    used = firstNumber(total?.actual_cost, total?.cost);
  }

  const result = baseResult(account);
  result.currency = currency;
  result.subject = {
    label: "Sub2API 密钥",
    detail: status ? `状态 ${status}` : mode === "quota_limited" ? "额度限制模式" : subscription ? "订阅模式" : "余额模式",
  };
  if (remaining !== null || used !== null || limit !== null) {
    result.balance = {
      remaining: round(remaining, 6),
      used: round(used, 6),
      total: round(limit, 6),
      currency,
      unit: null,
    };
  }
  result.windows = sortWindows(windows);
  result.plan = {
    name: planName,
    type: mode === "quota_limited" ? "quota" : subscription ? "subscription" : "wallet",
    active: isValid,
    expireAt: asDate(firstString(data.expires_at, subscription?.expires_at)),
  };

  // 累计用量、今日消费与模型分布，作为卡片上的补充信息
  const meta = [];
  const requests = firstNumber(total?.requests);
  if (requests !== null) meta.push({ label: "累计请求", value: requests, suffix: " 次" });
  const tokens = firstNumber(total?.total_tokens);
  if (tokens !== null) meta.push({ label: "累计 Tokens", value: tokens, compact: true });
  const todayCost = firstNumber(today?.actual_cost, today?.cost);
  if (todayCost !== null && todayCost > 0) meta.push({ label: "今日消费", value: todayCost, currency });
  const models = (Array.isArray(data.model_stats) ? data.model_stats : []).filter(isPlainObject);
  if (models.length > 0) {
    const top = [...models].sort((a, b) => (firstNumber(b.total_tokens) ?? 0) - (firstNumber(a.total_tokens) ?? 0))[0];
    const topName = firstString(top?.model);
    if (topName) meta.push({ label: "模型", text: models.length === 1 ? topName : `${topName} 等 ${models.length} 个` });
  }
  result.meta = meta;

  result.raw = payload;
  return result;
}

export async function fetchSub2ApiUsage(account, { timeoutMs = 15000 } = {}) {
  const base = normalizeBaseUrl(account.baseUrl);
  let payload;
  try {
    payload = await fetchJson(`${base}/v1/usage`, {
      headers: { Authorization: `Bearer ${account.key}`, Accept: "application/json" },
      timeoutMs,
      label: "Sub2API",
    });
  } catch (error) {
    if (error.status === 404) {
      throw new ProviderError(
        `${error.message}：该地址没有 /v1/usage 接口，若要用面板登录态查询，请在账户设置里把认证方式改为「面板令牌」。`,
        { status: 404, body: error.body },
      );
    }
    if (error.status === 401 || error.status === 403) {
      throw new ProviderError(
        `${error.message}：请确认填的是 Sub2API 网关的 API 密钥（面板登录令牌请改选「面板令牌」）。`,
        { status: error.status, body: error.body },
      );
    }
    throw error;
  }
  return normalizeSub2Usage(payload, account);
}

async function fetchSub2ApiPanel(account, { timeoutMs = 15000 } = {}) {
  const base = normalizeBaseUrl(account.baseUrl);
  let token = await sub2Token(account, timeoutMs);
  const request = async (path, init = {}) =>
    fetchJson(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      timeoutMs,
      label: "Sub2API",
    });

  let profilePayload;
  try {
    profilePayload = await request("/api/v1/user/profile");
  } catch (error) {
    if (error.status === 401 && account.options?.authMode === "password") {
      token = await sub2Token(account, timeoutMs, { forceLogin: true });
      profilePayload = await request("/api/v1/user/profile");
    } else {
      throw error;
    }
  }
  const profileData = unwrapSub2(profilePayload);
  const user = isPlainObject(profileData?.user) ? profileData.user : profileData;

  let windows = [];
  let subscriptionRaw = null;
  try {
    const progressPayload = await request("/api/v1/subscriptions/progress");
    subscriptionRaw = unwrapSub2(progressPayload);
    windows = progressWindows(subscriptionRaw, "USD");
  } catch {
    try {
      const summaryPayload = await request("/api/v1/subscriptions/summary");
      subscriptionRaw = unwrapSub2(summaryPayload);
      windows = summaryWindows(subscriptionRaw, "USD");
    } catch {
      windows = [];
    }
  }

  const balanceValue = firstNumber(user?.balance, profileData?.balance);
  const monthly = windows.find((window) => window.key === "monthly");
  const result = baseResult(account);
  result.currency = "USD";
  result.subject = {
    label: firstString(user?.username, user?.email, user?.name) ?? "Sub2API 账户",
    detail: firstString(user?.role, user?.group) ?? null,
  };
  if (balanceValue !== null) {
    result.balance = {
      remaining: round(balanceValue, 4),
      used: monthly?.used ?? null,
      total: monthly?.limit ?? null,
      currency: "USD",
      unit: null,
    };
  } else if (monthly) {
    result.balance = {
      remaining: monthly.remaining,
      used: monthly.used,
      total: monthly.limit,
      currency: "USD",
      unit: null,
    };
  }
  result.windows = windows;
  const firstEntry = Array.isArray(subscriptionRaw) ? subscriptionRaw[0] : null;
  const progress = firstEntry?.progress ?? firstEntry;
  const groupNames = Array.isArray(subscriptionRaw)
    ? [...new Set(subscriptionRaw.map((entry) => firstString(entry?.progress?.group_name, entry?.group_name)).filter(Boolean))]
    : [];
  if (progress || groupNames.length > 0) {
    result.plan = {
      name: groupNames.length > 0 ? groupNames.join(" / ") : "订阅套餐",
      type: "subscription",
      active: true,
      expireAt: asDate(firstString(progress?.expires_at, firstEntry?.subscription?.expires_at)),
    };
  }
  result.raw = { profile: profilePayload, subscriptions: subscriptionRaw };
  return result;
}

export async function fetchSub2Api(account, options = {}) {
  const mode = sub2AuthMode(account);
  if (mode === "apikey") return fetchSub2ApiUsage(account, options);
  if (mode === "password") return fetchSub2ApiPanel(account, options);

  // 面板令牌模式：先按面板登录态查询；若密钥实际是网关密钥（/api/v1 返回 401/403/404），
  // 自动降级到 /v1/usage，兼容旧版本默认值创建出来的账户。
  try {
    return await fetchSub2ApiPanel(account, options);
  } catch (error) {
    if (![401, 403, 404].includes(error?.status)) throw error;
    try {
      const result = await fetchSub2ApiUsage(account, options);
      result.subject = {
        ...(result.subject ?? {}),
        detail: `${result.subject?.detail ?? ""}${result.subject?.detail ? " · " : ""}面板令牌不可用，已按网关密钥解析`,
      };
      return result;
    } catch {
      throw error;
    }
  }
}

/* ----------------------------- OpenCode Go ----------------------------- */

/**
 * OpenCode Go 的用量接口固定是 {domain}/zen/go/v1/usage。
 * 用户可能只填域名，也可能直接粘完整接口地址（甚至带 query），这里统一归一化，避免出现重复路径。
 */
export function resolveOpenCodeUsageUrl(baseUrl) {
  const raw = normalizeBaseUrl(baseUrl) || "https://opencode.ai";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `${raw}/zen/go/v1/usage`;
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/usage")) {
    // 已经是完整接口地址，直接用
  } else if (/\/zen\/go\/v\d+$/.test(path)) {
    path = `${path}/usage`;
  } else {
    path = `${path}/zen/go/v1/usage`;
  }
  url.pathname = path.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function openCodeWindow(key, label, entry) {
  if (!isPlainObject(entry)) return null;
  const percent = firstNumber(entry.percent, entry.usagePercent, entry.usage_percent);
  if (percent === null) return null;
  const boundedPercent = Math.max(0, percent);
  return {
    key,
    label,
    limit: 100,
    used: round(boundedPercent, 3),
    remaining: round(Math.max(0, 100 - boundedPercent), 3),
    percent: round(boundedPercent, 3),
    resetAt: asDate(firstString(entry.resetsAt, entry.resets_at, entry.reset_at)),
    currency: null,
    unit: "%",
    status: firstString(entry.status),
  };
}

export async function fetchOpenCodeGo(account, { timeoutMs = 15000 } = {}) {
  const payload = await fetchJson(resolveOpenCodeUsageUrl(account.baseUrl), {
    headers: { Authorization: `Bearer ${account.key}`, Accept: "application/json" },
    timeoutMs,
    label: "OpenCode Go",
  });
  if (payload.type === "error") {
    throw new ProviderError(errorMessage(payload, "OpenCode Go 拒绝访问"), { status: 401, body: payload });
  }
  const usage = isPlainObject(payload.usage) ? payload.usage : payload;
  const windows = sortWindows([
    openCodeWindow("5h", "5 小时", usage.rolling),
    openCodeWindow("weekly", "本周", usage.weekly),
    openCodeWindow("monthly", "本月", usage.monthly),
  ]);
  if (windows.length === 0) {
    throw new ProviderError("OpenCode Go 响应中没有可用的用量数据", { body: payload });
  }
  const result = baseResult(account);
  result.subject = { label: "OpenCode Go", detail: "Zen 订阅套餐" };
  result.windows = windows;
  result.plan = { name: firstString(payload.plan_name, payload.planName) ?? "OpenCode Go", type: "subscription", active: true, expireAt: null };
  result.raw = payload;
  return result;
}

/* ------------------------------- 自定义 ------------------------------- */

const KNOWN_HINT_KEYS = [
  "quota_5h",
  "quota_daily",
  "quota_weekly",
  "quota_monthly",
  "used_5h",
  "used_daily",
  "used_weekly",
  "used_monthly",
  "balance",
  "remaining",
  "quota",
  "used",
  "used_quota",
  "total",
  "currency",
  "plan_name",
  "plan_type",
  "has_active_plan",
  "expire_at",
  "auto_reload_enabled",
  "reset_5h_at",
  "reset_weekly_at",
  "reset_monthly_at",
];

function candidateRoots(payload) {
  const candidates = [];
  const push = (value) => {
    if (isPlainObject(value)) candidates.push(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 3)) if (isPlainObject(item)) candidates.push(item);
    }
  };
  push(payload);
  if (isPlainObject(payload)) {
    for (const key of ["data", "result", "payload", "body", "response"]) {
      const nested = payload[key];
      push(nested);
      if (isPlainObject(nested)) {
        for (const inner of ["data", "result", "user", "account", "plan", "usage", "subscription"]) {
          push(nested[inner]);
        }
      }
    }
  }
  return candidates;
}

export function pickCustomRoot(payload) {
  let best = isPlainObject(payload) ? payload : {};
  let bestScore = -1;
  for (const candidate of candidateRoots(payload)) {
    let score = 0;
    for (const key of Object.keys(candidate)) if (KNOWN_HINT_KEYS.includes(key)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

const CUSTOM_WINDOW_ALIASES = {
  "5h": ["5h", "5_h", "five_hour", "fivehour", "rolling", "5hour"],
  daily: ["daily", "day", "1d", "24h"],
  weekly: ["weekly", "week", "7d"],
  monthly: ["monthly", "month", "30d"],
};

function customWindowFromKeys(root, key, aliases, currency) {
  const limitKeys = [];
  const usedKeys = [];
  const resetKeys = [];
  for (const alias of aliases) {
    limitKeys.push(`quota_${alias}`, `limit_${alias}`, `${alias}_quota`, `${alias}_limit`, `${alias}_total`, `total_${alias}`);
    usedKeys.push(`used_${alias}`, `${alias}_used`, `usage_${alias}`, `${alias}_usage`);
    resetKeys.push(`reset_${alias}_at`, `resets_${alias}_at`, `${alias}_reset_at`, `${alias}_resets_at`, `reset_${alias}`, `${alias}_reset`);
  }
  const limit = firstNumber(...limitKeys.map((k) => root[k]));
  const used = firstNumber(...usedKeys.map((k) => root[k]));
  const resetAt = firstString(...resetKeys.map((k) => root[k]));
  const percent = firstNumber(...aliases.map((alias) => root[`percent_${alias}`]));
  if (limit === null && used === null && percent === null) return null;
  return makeWindow({ key, label: WINDOW_LABELS[key], limit, used, percent, resetAt, currency });
}

function customPercentWindows(root, currency) {
  const usage = isPlainObject(root.usage) ? root.usage : isPlainObject(root.windows) ? root.windows : null;
  if (!usage) return [];
  const mapping = [
    ["5h", ["rolling", "5h", "5_h"]],
    ["daily", ["daily", "day"]],
    ["weekly", ["weekly", "week"]],
    ["monthly", ["monthly", "month"]],
  ];
  const windows = [];
  for (const [key, aliases] of mapping) {
    for (const alias of aliases) {
      const entry = usage[alias];
      if (!isPlainObject(entry)) continue;
      const percent = firstNumber(entry.percent, entry.usagePercent, entry.usage_percent, entry.used_percent);
      if (percent === null) continue;
      windows.push(
        makeWindow({
          key,
          label: WINDOW_LABELS[key],
          limit: 100,
          used: Math.max(0, percent),
          resetAt: firstString(entry.resetsAt, entry.resets_at, entry.reset_at),
          currency,
          unit: "%",
          status: firstString(entry.status),
        }),
      );
      break;
    }
  }
  return sortWindows(windows);
}

export function normalizeCustomBalance(payload, account) {
  const mapping = (() => {
    const raw = account.options?.mapping;
    if (isPlainObject(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
      } catch {
        throw new ProviderError("自定义字段映射不是合法 JSON");
      }
    }
    return {};
  })();

  const root = mapping.root ? pathGet(payload, payload, mapping.root) : pickCustomRoot(payload);
  const scoped = isPlainObject(root) ? root : {};
  const get = (path, ...fallbacks) => firstNumber(pathGet(scoped, payload, path), ...fallbacks);
  const getText = (path, ...fallbacks) => firstString(pathGet(scoped, payload, path), ...fallbacks);

  const currency = getText(mapping.currency, scoped.currency, scoped.currency_code, scoped.unit) ?? null;
  const remaining = get(
    mapping.balanceRemaining,
    scoped.balance,
    scoped.remaining,
    scoped.balance_remaining,
    scoped.available,
    scoped.available_balance,
    scoped.credit,
    scoped.credits,
  );
  const used = get(mapping.balanceUsed, scoped.used, scoped.used_amount, scoped.used_quota, scoped.spent, scoped.total_used);
  const total = get(mapping.balanceTotal, scoped.total, scoped.quota, scoped.limit, scoped.total_amount, scoped.amount);

  let windows = [];
  if (isPlainObject(mapping.windows)) {
    for (const [key, config] of Object.entries(mapping.windows)) {
      if (!isPlainObject(config)) continue;
      windows.push(
        makeWindow({
          key,
          label: firstString(config.label) ?? WINDOW_LABELS[key] ?? key,
          limit: pathGet(scoped, payload, config.limit),
          used: pathGet(scoped, payload, config.used),
          remaining: pathGet(scoped, payload, config.remaining),
          percent: pathGet(scoped, payload, config.percent),
          resetAt: pathGet(scoped, payload, config.resetAt),
          currency,
          unit: firstString(config.unit),
        }),
      );
    }
    windows = sortWindows(windows);
  } else {
    for (const [key, aliases] of Object.entries(CUSTOM_WINDOW_ALIASES)) {
      windows.push(customWindowFromKeys(scoped, key, aliases, currency));
    }
    windows = sortWindows(windows);
    if (windows.length === 0) windows = customPercentWindows(scoped, currency);
  }

  const planName = getText(mapping.planName, scoped.plan_name, scoped.planName, scoped.plan?.name);
  const planExpire = getText(mapping.planExpireAt, scoped.expire_at, scoped.expireAt, scoped.expires_at, scoped.plan?.expire_at);
  const planActive = firstBoolean(pathGet(scoped, payload, mapping.planActive), scoped.has_active_plan, scoped.active);
  const planType = getText(mapping.planType, scoped.plan_type, scoped.planType);
  const autoReloadEnabled = firstBoolean(
    pathGet(scoped, payload, mapping.autoReloadEnabled),
    scoped.auto_reload_enabled,
    scoped.autoReloadEnabled,
  );
  const autoReloadThreshold = get(mapping.autoReloadThreshold, scoped.auto_reload_threshold);
  const autoReloadAmount = get(mapping.autoReloadAmount, scoped.auto_reload_amount);

  const result = baseResult(account);
  result.currency = currency;
  result.subject = {
    label: getText(mapping.subject, scoped.account_name, scoped.username, scoped.user?.name, scoped.name) ?? account.name,
    detail: planType,
  };

  if (remaining !== null || used !== null || total !== null) {
    const numericLimit = total ?? (remaining !== null && used !== null ? remaining + used : null);
    const numericUsed = used ?? (numericLimit !== null && remaining !== null ? numericLimit - remaining : null);
    result.balance = {
      remaining: round(remaining, 4),
      used: round(numericUsed, 4),
      total: round(numericLimit, 4),
      currency,
      unit: null,
    };
  } else if (windows.length > 0) {
    const headline = windows.find((window) => window.key === "monthly") ?? windows[windows.length - 1];
    if (headline && headline.limit !== null) {
      result.balance = {
        remaining: headline.remaining,
        used: headline.used,
        total: headline.limit,
        currency,
        unit: headline.unit,
      };
    }
  }

  result.windows = windows;
  if (planName || planExpire || planActive !== null) {
    result.plan = {
      name: planName ?? account.name,
      type: planType,
      active: planActive,
      expireAt: asDate(planExpire),
    };
  }
  if (autoReloadEnabled !== null || autoReloadThreshold !== null || autoReloadAmount !== null) {
    result.autoReload = {
      enabled: autoReloadEnabled,
      threshold: round(autoReloadThreshold, 4),
      amount: round(autoReloadAmount, 4),
      currency,
    };
  }
  result.raw = payload;
  return result;
}

function parseJsonOption(value, label) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new ProviderError(`${label} 不是合法 JSON`);
  }
}

export async function fetchCustom(account, { timeoutMs = 15000 } = {}) {
  const options = account.options ?? {};
  const base = normalizeBaseUrl(account.baseUrl);
  const path = typeof options.path === "string" ? options.path.trim() : "";
  let url = base;
  if (path !== "") {
    url = /^https?:\/\//i.test(path) ? path : `${base}/${path.replace(/^\/+/, "")}`;
  }
  const headers = parseJsonOption(options.headers, "自定义请求头") ?? {};
  if (!isPlainObject(headers)) throw new ProviderError("自定义请求头必须是 JSON 对象");
  const authStyle = options.authStyle ?? "bearer";
  const key = account.key ?? "";
  if (key) {
    if (authStyle === "bearer") headers.Authorization = headers.Authorization ?? `Bearer ${key}`;
    else if (authStyle === "x-api-key") headers["x-api-key"] = headers["x-api-key"] ?? key;
    else if (authStyle === "query") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}key=${encodeURIComponent(key)}`;
    }
  }
  const method = options.method === "POST" ? "POST" : "GET";
  let body;
  if (method === "POST") {
    const rawBody = typeof options.body === "string" ? options.body.replaceAll("{{key}}", key) : "";
    body = rawBody.trim() === "" ? undefined : rawBody;
    if (body) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const payload = await fetchJson(url, { method, headers, body, timeoutMs, label: "自定义接口" });
  return normalizeCustomBalance(payload, account);
}

/* ------------------------------- dispatch ------------------------------ */

export async function getBalance(account, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  switch (account.type) {
    case "newapi":
      return fetchNewApi(account, { timeoutMs });
    case "sub2api":
      return fetchSub2Api(account, { timeoutMs });
    case "opencode":
      return fetchOpenCodeGo(account, { timeoutMs });
    case "custom":
      return fetchCustom(account, { timeoutMs });
    default:
      throw new ProviderError(`未知账户类型：${account.type}`);
  }
}

export function failureResult(account, error) {
  return {
    accountId: account.id,
    name: account.name,
    type: account.type,
    ok: false,
    fetchedAt: new Date().toISOString(),
    error: error instanceof ProviderError ? error.message : error?.message ?? "未知错误",
  };
}

export function isUsablePercent(percent) {
  return Number.isFinite(percent) ? clamp(percent, 0, 100) : null;
}
