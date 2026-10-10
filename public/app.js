const PROVIDERS = {
  newapi: {
    label: "New API",
    icon: "i-server",
    accent: "#38bdf8",
    soft: "rgba(56, 189, 248, 0.14)",
    basePlaceholder: "https://your-newapi.example.com",
    keyLabel: "系统访问令牌",
    keyPlaceholder: "粘贴系统访问令牌",
  },
  sub2api: {
    label: "Sub2API",
    icon: "i-activity",
    accent: "#34d399",
    soft: "rgba(52, 211, 153, 0.14)",
    basePlaceholder: "https://your-sub2api.example.com",
    keyLabel: "Access Token",
    keyPlaceholder: "粘贴 access_token",
  },
  opencode: {
    label: "OpenCode Go",
    icon: "i-sparkles",
    accent: "#f59e0b",
    soft: "rgba(245, 158, 11, 0.15)",
    basePlaceholder: "https://opencode.ai",
    keyLabel: "API Key",
    keyPlaceholder: "粘贴 API Key",
  },
  custom: {
    label: "自定义",
    icon: "i-link",
    accent: "#a78bfa",
    soft: "rgba(167, 139, 250, 0.15)",
    basePlaceholder: "https://api.example.com",
    keyLabel: "密钥",
    keyPlaceholder: "粘贴密钥（可留空）",
  },
};

const CURRENCY_SYMBOLS = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", JPY: "¥", GBP: "£", HKD: "HK$", TWD: "NT$" };

const STATUS_LABELS = { "rate-limited": "已限流", limited: "已限流", blocked: "已停用", expired: "已过期" };

const WEBHOOK_TYPES = [
  { value: "dingtalk", label: "钉钉" },
  { value: "wecom", label: "企业微信" },
  { value: "feishu", label: "飞书" },
];

const state = {
  accounts: [],
  results: {},
  refreshing: new Set(),
  lastUpdated: null,
  editing: null,
  pendingDelete: null,
  timer: null,
  intervalMs: 60000,
  authRequired: false,
};

const TOKEN_KEY = "aimonitor.token";

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

const icon = (name, extraClass = "") => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${extraClass}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
};

function formatNumber(value, { digits = 2 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const maximumFractionDigits = absolute >= 1000 ? 0 : absolute >= 100 ? 1 : digits;
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits)}%`;
}

// 大数字用万/亿做紧凑展示（Sub2API 的累计 tokens 等）
function formatCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(2)} 万`;
  return formatNumber(value);
}

function currencyOf(code) {
  if (!code) return "";
  return CURRENCY_SYMBOLS[String(code).toUpperCase()] ?? `${code} `;
}

function unitSuffix(entity) {
  if (!entity) return "";
  if (entity.unit === "%") return "";
  return currencyOf(entity.currency);
}

function formatMoney(value, entity) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${unitSuffix(entity)}${formatNumber(value)}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatClock(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatCountdown(iso) {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const diff = target - Date.now();
  // 已经过去的重置时间说明上游数据尚未刷新，宁可不显示也不要给出误导性倒计时
  if (diff <= 0) return null;
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

async function api(path, options = {}) {
  const token = readToken();
  const headers = { ...(options.headers ?? {}) };
  if (options.body) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) {
    state.authRequired = true;
    openAuthDialog(payload?.error);
    const error = new Error(payload?.error ?? "需要访问令牌");
    error.handled = true;
    throw error;
  }
  if (!response.ok) {
    throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

/* --------------------------------- rendering -------------------------------- */

const dom = {
  grid: document.getElementById("grid"),
  stats: document.getElementById("stats"),
  empty: document.getElementById("empty"),
  brandSub: document.getElementById("brandSub"),
  refreshAll: document.getElementById("refreshAll"),
  addAccount: document.getElementById("addAccount"),
  emptyAdd: document.getElementById("emptyAdd"),
  refreshInterval: document.getElementById("refreshInterval"),
  accountDialog: document.getElementById("accountDialog"),
  accountForm: document.getElementById("accountForm"),
  accountDialogTitle: document.getElementById("accountDialogTitle"),
  accountName: document.getElementById("accountName"),
  accountKey: document.getElementById("accountKey"),
  accountBaseUrl: document.getElementById("accountBaseUrl"),
  keyLabel: document.getElementById("keyLabel"),
  quotaPerUnit: document.getElementById("quotaPerUnit"),
  currency: document.getElementById("currency"),
  newapiFields: document.getElementById("newapiFields"),
  sub2apiFields: document.getElementById("sub2apiFields"),
  sub2AuthMode: document.getElementById("sub2AuthMode"),
  sub2Email: document.getElementById("sub2Email"),
  sub2EmailField: document.getElementById("sub2EmailField"),
  sub2Hint: document.getElementById("sub2Hint"),
  customFields: document.getElementById("customFields"),
  customMethod: document.getElementById("customMethod"),
  customAuthStyle: document.getElementById("customAuthStyle"),
  customPath: document.getElementById("customPath"),
  customHeaders: document.getElementById("customHeaders"),
  customBody: document.getElementById("customBody"),
  customBodyField: document.getElementById("customBodyField"),
  customMapping: document.getElementById("customMapping"),
  formError: document.getElementById("formError"),
  accountSubmit: document.getElementById("accountSubmit"),
  detailsDialog: document.getElementById("detailsDialog"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsRaw: document.getElementById("detailsRaw"),
  copyRaw: document.getElementById("copyRaw"),
  authDialog: document.getElementById("authDialog"),
  authForm: document.getElementById("authForm"),
  authToken: document.getElementById("authToken"),
  authError: document.getElementById("authError"),
  authState: document.getElementById("authState"),
  authButton: document.getElementById("authButton"),
  clearAuthToken: document.getElementById("clearAuthToken"),
  notifySettings: document.getElementById("notifySettings"),
  notifyDialog: document.getElementById("notifyDialog"),
  notifyEnabled: document.getElementById("notifyEnabled"),
  windowPercent: document.getElementById("windowPercent"),
  balanceAmount: document.getElementById("balanceAmount"),
  digestEnabled: document.getElementById("digestEnabled"),
  digestTimes: document.getElementById("digestTimes"),
  digestTimezone: document.getElementById("digestTimezone"),
  webhookList: document.getElementById("webhookList"),
  webhookEmpty: document.getElementById("webhookEmpty"),
  addWebhook: document.getElementById("addWebhook"),
  saveNotify: document.getElementById("saveNotify"),
  previewDigest: document.getElementById("previewDigest"),
  notifyError: document.getElementById("notifyError"),
  accountGroup: document.getElementById("accountGroup"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmText: document.getElementById("confirmText"),
  confirmDelete: document.getElementById("confirmDelete"),
  toasts: document.getElementById("toasts"),
};

function renderStats() {
  const total = state.accounts.length;
  const okCount = state.accounts.filter((account) => state.results[account.id]?.ok).length;
  const errorCount = state.accounts.filter((account) => state.results[account.id] && !state.results[account.id].ok).length;
  dom.stats.replaceChildren(
    el("span", { class: "stat" }, [el("span", { text: "账户" }), el("strong", { text: String(total) })]),
    el("span", { class: "stat" }, [el("span", { class: "dot ok" }), el("span", { text: "正常" }), el("strong", { text: String(okCount) })]),
    el("span", { class: "stat" }, [el("span", { class: "dot bad" }), el("span", { text: "异常" }), el("strong", { text: String(errorCount) })]),
    el("span", { class: "stat" }, [icon("i-clock"), el("span", { text: "更新于" }), el("strong", { text: formatClock(state.lastUpdated) })]),
  );
  dom.brandSub.textContent = total === 0 ? "尚未添加账户" : `${total} 个账户 · 自动刷新 ${state.intervalMs === 0 ? "关闭" : `${Math.round(state.intervalMs / 1000)} 秒`}`;
}

function windowsOf(result) {
  return Array.isArray(result?.windows) ? result.windows.filter(Boolean) : [];
}

function headlineOf(result) {
  const balance = result?.balance;
  if (balance && Number.isFinite(balance.remaining)) {
    const noteParts = [];
    if (Number.isFinite(balance.used)) noteParts.push(`已用 ${formatMoney(balance.used, balance)}`);
    if (Number.isFinite(balance.total)) noteParts.push(`总额 ${formatMoney(balance.total, balance)}`);
    const note = noteParts.length > 0 ? noteParts.join(" · ") : null;
    const symbol = balance.currency ? currencyOf(balance.currency) : null;
    return {
      amount: formatNumber(balance.remaining),
      unit: symbol ?? balance.unit ?? "剩余",
      unitFirst: Boolean(symbol),
      note,
    };
  }
  const windows = windowsOf(result);
  const main = windows.find((window) => window.key === "monthly") ?? windows[windows.length - 1];
  if (!main) return null;
  const limited = main.status && main.status !== "ok" ? STATUS_LABELS[main.status] ?? main.status : null;
  const note = limited ? `${main.label} · ${limited}` : main.label;
  if (main.unit === "%" && Number.isFinite(main.remaining)) {
    return { amount: formatPercent(main.remaining), unit: "剩余", note };
  }
  if (Number.isFinite(main.remaining)) {
    return {
      amount: formatNumber(main.remaining),
      unit: `${main.label}剩余`,
      note: Number.isFinite(main.limit) ? `额度 ${formatMoney(main.limit, main)}${limited ? ` · ${limited}` : ""}` : limited,
    };
  }
  if (Number.isFinite(main.percent)) {
    return { amount: formatPercent(Math.max(0, 100 - main.percent)), unit: "剩余", note };
  }
  return null;
}

function metaRow(result) {
  const meta = Array.isArray(result?.meta) ? result.meta.filter((item) => item && item.label) : [];
  if (meta.length === 0) return null;
  const chips = meta.map((item) => {
    let value = item.text;
    if (value === undefined) {
      const prefix = item.currency ? currencyOf(item.currency) : "";
      value = `${prefix}${item.compact ? formatCompact(item.value) : formatNumber(item.value)}${item.suffix ?? ""}`;
    }
    return el("span", { class: "meta-chip" }, [
      el("span", { class: "meta-label", text: item.label }),
      el("span", { class: "meta-value", text: value, title: `${item.label} ${value}` }),
    ]);
  });
  return el("div", { class: "meta-row" }, chips);
}

function windowRow(window) {
  const percent = Number.isFinite(window.percent) ? Math.max(0, window.percent) : null;
  const barClass = percent === null ? "" : percent >= 90 ? " danger" : percent >= 70 ? " warn" : "";
  const headValue = window.unit === "%"
    ? `已用 ${formatPercent(percent)}`
    : percent === null
      ? "—"
      : `${formatPercent(percent)}`;
  const leftMeta = window.unit === "%"
    ? `剩余 ${formatPercent(window.remaining)}`
    : Number.isFinite(window.limit)
      ? `剩余 ${formatMoney(window.remaining, window)} / ${formatMoney(window.limit, window)}`
      : `剩余 ${formatMoney(window.remaining, window)}`;
  const resetText = formatCountdown(window.resetAt);
  const meta = [el("span", { text: leftMeta })];
  if (resetText) {
    const reset = el("span", { class: "reset" }, [icon("i-clock"), el("span", { text: `${resetText} 后重置` })]);
    if (window.resetAt) reset.dataset.countdown = window.resetAt;
    meta.push(reset);
  }
  const nameCell = el("span", { class: "name" }, [document.createTextNode(window.label)]);
  const statusLabel = window.status && window.status !== "ok" ? STATUS_LABELS[window.status] ?? window.status : null;
  if (statusLabel) {
    nameCell.append(el("span", { class: "status-tag", text: statusLabel }));
  }
  return el("div", { class: "window" }, [
    el("div", { class: "window-head" }, [
      nameCell,
      el("span", { class: "value", text: headValue }),
    ]),
    el("div", { class: "bar" }, [
      el("div", { class: `bar-fill${barClass}`, style: `width:${Math.min(100, Math.max(0, percent ?? 0))}%` }),
    ]),
    el("div", { class: "window-meta" }, meta),
  ]);
}

function planLine(result) {
  const plan = result.plan;
  if (!plan || (!plan.name && !plan.expireAt)) return null;
  const pieces = [];
  if (plan.name) {
    pieces.push(el("span", { class: "plan-chip" }, [icon("i-zap"), el("span", { text: plan.name })]));
  }
  if (plan.active === false) {
    pieces.push(el("span", { class: "plan-meta" }, [icon("i-alert"), el("span", { text: "未激活" })]));
  }
  if (plan.expireAt) {
    const meta = el("span", { class: "plan-meta" }, [icon("i-calendar"), el("span", { text: `到期 ${formatCountdown(plan.expireAt) ?? "—"}` })]);
    meta.dataset.countdown = plan.expireAt;
    meta.dataset.countdownPrefix = "到期";
    pieces.push(meta);
  }
  return el("div", { class: "plan-line" }, pieces);
}

function autoReloadLine(result) {
  const reload = result.autoReload;
  if (!reload || reload.enabled !== true) return null;
  const threshold = Number.isFinite(reload.threshold) ? `${currencyOf(reload.currency)}${formatNumber(reload.threshold)}` : "—";
  const amount = Number.isFinite(reload.amount) ? `${currencyOf(reload.currency)}${formatNumber(reload.amount)}` : "—";
  return el("div", { class: "plan-line" }, [
    el("span", { class: "plan-meta" }, [icon("i-refresh"), el("span", { text: `自动充值：低于 ${threshold} 补 ${amount}` })]),
  ]);
}

function skeletonCardBody() {
  return el("div", { class: "windows" }, [
    el("div", { class: "skeleton", style: "height:26px;width:52%" }),
    el("div", { class: "skeleton", style: "height:6px;width:100%" }),
    el("div", { class: "skeleton", style: "height:18px;width:38%" }),
  ]);
}

function createCard(account) {
  const provider = PROVIDERS[account.type] ?? PROVIDERS.custom;
  const result = state.results[account.id];
  const loading = state.refreshing.has(account.id);
  const card = el("article", { class: "card" });
  card.style.setProperty("--accent", provider.accent);
  card.style.setProperty("--accent-soft", provider.soft);

  const statusDot = el("span", {
    class: `status-dot${loading ? " loading" : result ? (result.ok ? " ok" : " bad") : ""}`,
  });

  const refreshButton = el("button", { class: "icon-btn", type: "button", title: "刷新该账户" }, [
    icon("i-refresh", loading ? "spinning" : ""),
  ]);
  refreshButton.addEventListener("click", () => refreshBalances(true, [account.id]));

  const editButton = el("button", { class: "icon-btn", type: "button", title: "编辑账户" }, [icon("i-pencil")]);
  editButton.addEventListener("click", () => openAccountDialog(account));

  const detailsButton = el("button", { class: "icon-btn", type: "button", title: "查看接口原始数据" }, [icon("i-info")]);
  detailsButton.addEventListener("click", () => openDetails(account));

  const deleteButton = el("button", { class: "icon-btn", type: "button", title: "删除账户" }, [icon("i-trash")]);
  deleteButton.addEventListener("click", () => openConfirm(account));

  const subtitle = hostOf(account.baseUrl || "") || result?.subject?.detail || "";
  card.append(
    // 第一行只放类型标签与操作按钮，账户名单独占一行（否则长名字会被挤到几乎不可见）
    el("div", { class: "card-top" }, [
      el("span", { class: "provider-chip" }, [icon(provider.icon), el("span", { text: provider.label })]),
      el("div", { class: "card-actions" }, [statusDot, refreshButton, editButton, detailsButton, deleteButton]),
    ]),
    el("div", { class: "card-title" }, [
      el("h3", { text: account.name, title: account.name }),
      el("p", { text: subtitle, title: account.baseUrl || "" }),
    ]),
  );

  if (!result && loading) {
    card.append(skeletonCardBody());
  } else if (result && !result.ok) {
    card.append(
      el("div", { class: "error-box" }, [icon("i-alert"), el("span", { text: result.error ?? "请求失败" })]),
    );
  } else if (result?.ok) {
    const headline = headlineOf(result);
    if (headline) {
      const amountNode = el("span", { class: "amount", text: headline.amount });
      const unitNode = el("span", { class: "unit", text: headline.unit });
      card.append(
        el("div", { class: "headline" }, [
          el("div", { class: "headline-value" }, headline.unitFirst ? [unitNode, amountNode] : [amountNode, unitNode]),
          headline.note ? el("div", { class: "headline-note", text: headline.note }) : null,
        ]),
      );
    }
    const plan = planLine(result);
    if (plan) card.append(plan);
    const meta = metaRow(result);
    if (meta) card.append(meta);
    const windows = windowsOf(result);
    if (windows.length > 0) {
      card.append(el("div", { class: "windows" }, windows.map(windowRow)));
    }
    const reload = autoReloadLine(result);
    if (reload) card.append(reload);
  } else {
    card.append(el("div", { class: "headline-note", text: "等待数据" }));
  }

  const subject = result?.subject?.label ?? "";
  card.append(
    el("div", { class: "card-foot" }, [
      el("span", { text: result?.fetchedAt ? `更新于 ${formatClock(result.fetchedAt)}` : "尚未更新" }),
      el("span", { text: subject, title: subject }),
    ]),
  );
  return card;
}

function render() {
  renderStats();
  dom.empty.hidden = state.accounts.length !== 0;
  dom.grid.replaceChildren(...state.accounts.map(createCard));
}

/* ---------------------------------- data ----------------------------------- */

async function loadAccounts() {
  const payload = await api("/api/accounts");
  state.accounts = payload.accounts ?? [];
  const known = new Set(state.accounts.map((account) => account.id));
  for (const id of Object.keys(state.results)) {
    if (!known.has(id)) delete state.results[id];
  }
  render();
}

async function refreshBalances(force = false, ids = null) {
  const targets = ids ? state.accounts.filter((account) => ids.includes(account.id)) : state.accounts;
  if (targets.length === 0) {
    state.lastUpdated = new Date().toISOString();
    render();
    return;
  }
  for (const account of targets) state.refreshing.add(account.id);
  render();
  try {
    const query = new URLSearchParams();
    if (force) query.set("force", "1");
    if (ids) query.set("ids", ids.join(","));
    const payload = await api(`/api/balances${query.toString() ? `?${query}` : ""}`);
    Object.assign(state.results, payload.results ?? {});
    state.lastUpdated = payload.fetchedAt ?? new Date().toISOString();
  } catch (error) {
    if (!error.handled) toast(error.message, "error");
  } finally {
    for (const account of targets) state.refreshing.delete(account.id);
    render();
  }
}

/* --------------------------------- dialogs --------------------------------- */

function selectedType() {
  const input = dom.accountForm.querySelector('input[name="type"]:checked');
  return input?.value ?? "newapi";
}

function syncProviderFields() {
  const type = selectedType();
  const provider = PROVIDERS[type];
  dom.newapiFields.hidden = type !== "newapi";
  dom.sub2apiFields.hidden = type !== "sub2api";
  dom.customFields.hidden = type !== "custom";
  const sub2Mode = dom.sub2AuthMode.value;
  dom.sub2EmailField.hidden = type !== "sub2api" || sub2Mode !== "password";
  dom.customBodyField.hidden = dom.customMethod.value !== "POST";
  dom.accountBaseUrl.placeholder = provider.basePlaceholder;
  if (type === "sub2api") {
    const perMode = {
      apikey: { label: "API 密钥", placeholder: "粘贴 Sub2API 网关密钥", hint: "请求 {base}/v1/usage，返回钱包余额或额度/速率限制，适用于 Sub2API 网关密钥。" },
      token: { label: "面板令牌", placeholder: "粘贴面板 access_token", hint: "使用面板登录态请求 /api/v1 账户与订阅接口。" },
      password: { label: "面板密码", placeholder: "面板登录密码", hint: "用邮箱 + 密码登录面板后请求 /api/v1 接口，令牌会在服务端缓存。" },
    }[sub2Mode];
    dom.keyLabel.textContent = perMode.label;
    dom.accountKey.placeholder = perMode.placeholder;
    dom.sub2Hint.textContent = perMode.hint;
  } else {
    dom.keyLabel.textContent = provider.keyLabel;
    dom.accountKey.placeholder = provider.keyPlaceholder;
  }
  if (!state.editing) {
    if (type === "opencode") dom.accountBaseUrl.value = "https://opencode.ai";
    else if (dom.accountBaseUrl.value.startsWith("https://opencode.ai")) dom.accountBaseUrl.value = "";
  }
}

function openAccountDialog(account = null) {
  state.editing = account;
  dom.accountForm.reset();
  dom.formError.hidden = true;
  dom.accountSubmit.textContent = account ? "保存修改" : "保存";
  dom.accountDialogTitle.textContent = account ? "编辑账户" : "添加账户";

  const type = account?.type ?? "newapi";
  const typeInput = dom.accountForm.querySelector(`input[name="type"][value="${type}"]`);
  if (typeInput) typeInput.checked = true;

  dom.accountName.value = account?.name ?? "";
  dom.accountBaseUrl.value = account?.baseUrl ?? "";
  dom.accountGroup.value = account?.group ?? "";
  dom.accountKey.value = "";
  dom.accountKey.placeholder = account ? "留空则保持原密钥" : PROVIDERS[type].keyPlaceholder;

  const options = account?.options ?? {};
  dom.quotaPerUnit.value = options.quotaPerUnit ?? "";
  dom.currency.value = options.currency ?? "";
  dom.sub2AuthMode.value = ["apikey", "token", "password"].includes(options.authMode) ? options.authMode : "apikey";
  dom.sub2Email.value = options.email ?? "";
  dom.customMethod.value = options.method === "POST" ? "POST" : "GET";
  dom.customAuthStyle.value = options.authStyle ?? "bearer";
  dom.customPath.value = options.path ?? "";
  dom.customHeaders.value = options.headers ?? "";
  dom.customBody.value = options.body ?? "";
  dom.customMapping.value = options.mapping ?? "";

  syncProviderFields();
  dom.accountDialog.showModal();
  dom.accountName.focus();
}

function collectAccountPayload() {
  const type = selectedType();
  const payload = {
    type,
    name: dom.accountName.value.trim(),
    baseUrl: dom.accountBaseUrl.value.trim(),
    key: dom.accountKey.value.trim(),
    group: dom.accountGroup.value.trim(),
  };
  if (type === "newapi") {
    payload.options = {
      quotaPerUnit: dom.quotaPerUnit.value.trim(),
      currency: dom.currency.value.trim(),
    };
  } else if (type === "sub2api") {
    payload.options = {
      authMode: dom.sub2AuthMode.value,
      email: dom.sub2Email.value.trim(),
    };
  } else if (type === "custom") {
    for (const [label, text] of [
      ["请求头", dom.customHeaders.value.trim()],
      ["字段映射", dom.customMapping.value.trim()],
      ["请求体", dom.customMethod.value === "POST" ? dom.customBody.value.trim() : ""],
    ]) {
      if (text === "" || text.startsWith("{{")) continue;
      try {
        JSON.parse(text);
      } catch {
        throw new Error(`${label} 不是合法 JSON`);
      }
    }
    payload.options = {
      method: dom.customMethod.value,
      path: dom.customPath.value.trim(),
      authStyle: dom.customAuthStyle.value,
      headers: dom.customHeaders.value.trim(),
      body: dom.customBody.value.trim(),
      mapping: dom.customMapping.value.trim(),
    };
  }
  if (state.editing && payload.key === "") delete payload.key;
  return payload;
}

async function submitAccount(event) {
  event.preventDefault();
  let payload;
  try {
    payload = collectAccountPayload();
  } catch (error) {
    dom.formError.textContent = error.message;
    dom.formError.hidden = false;
    return;
  }
  dom.accountSubmit.disabled = true;
  try {
    if (state.editing) {
      await api(`/api/accounts/${state.editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("账户已更新", "success");
    } else {
      await api("/api/accounts", { method: "POST", body: JSON.stringify(payload) });
      toast("账户已添加", "success");
    }
    dom.accountDialog.close();
    const id = state.editing?.id ?? null;
    state.editing = null;
    await loadAccounts();
    await refreshBalances(true, id ? [id] : null);
  } catch (error) {
    dom.formError.textContent = error.message;
    dom.formError.hidden = false;
  } finally {
    dom.accountSubmit.disabled = false;
  }
}

function openDetails(account) {
  const result = state.results[account.id];
  dom.detailsTitle.textContent = account.name;
  dom.detailsRaw.textContent = JSON.stringify(result?.raw ?? result ?? { message: "暂无数据" }, null, 2);
  dom.detailsDialog.showModal();
}

function openConfirm(account) {
  state.pendingDelete = account;
  dom.confirmText.textContent = `确定删除「${account.name}」？该操作不可撤销。`;
  dom.confirmDialog.showModal();
}

function updateAuthButton() {
  const token = readToken();
  const authorized = token !== "" && !state.authRequired;
  dom.authButton.title = state.authRequired
    ? (token ? "访问令牌无效，点击重新输入" : "需要访问令牌，点击输入")
    : authorized
      ? "已授权访问（点击可更换令牌）"
      : "访问令牌";
  dom.authButton.style.color = state.authRequired ? "var(--warn)" : authorized ? "var(--ok)" : "";
}

function openAuthDialog(message = null) {
  const token = readToken();
  dom.authToken.value = token;
  dom.authError.textContent = message ?? "";
  dom.authError.hidden = !message;
  dom.authState.textContent = state.authRequired
    ? token
      ? "令牌无效或已变更，请重新输入服务端的 AIMONITOR_TOKEN。"
      : "服务端已启用访问令牌，请输入 AIMONITOR_TOKEN 后继续。"
    : "服务端设置 AIMONITOR_TOKEN 后，每台设备首次访问需要输入一次。";
  if (!dom.authDialog.open) dom.authDialog.showModal();
  dom.authToken.focus();
  updateAuthButton();
}

async function saveAuthToken(event) {
  event.preventDefault();
  const token = dom.authToken.value.trim();
  if (token === "") {
    dom.authError.textContent = "请输入访问令牌";
    dom.authError.hidden = false;
    return;
  }
  const previous = readToken();
  storeToken(token);
  try {
    await api("/api/accounts");
    state.authRequired = false;
    dom.authDialog.close();
    toast("访问令牌已保存", "success");
    await loadAccounts();
    await refreshBalances(true);
  } catch (error) {
    if (!error.handled) {
      storeToken(previous);
      dom.authError.textContent = error.message;
      dom.authError.hidden = false;
    }
  } finally {
    updateAuthButton();
  }
}

async function clearAuthToken() {
  storeToken("");
  dom.authDialog.close();
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    /* 忽略：清理本地状态即可 */
  }
  toast("已清除本机访问令牌");
  updateAuthButton();
  loadAccounts()
    .then(() => refreshBalances(true))
    .catch(() => {});
}

async function confirmDelete() {
  const account = state.pendingDelete;
  state.pendingDelete = null;
  dom.confirmDialog.close();
  if (!account) return;
  try {
    await api(`/api/accounts/${account.id}`, { method: "DELETE" });
    toast("账户已删除", "success");
    await loadAccounts();
  } catch (error) {
    toast(error.message, "error");
  }
}

function toast(message, type = "info") {
  const node = el("div", { class: `toast ${type}` }, [
    icon(type === "error" ? "i-alert" : type === "success" ? "i-check" : "i-info"),
    el("span", { text: message }),
  ]);
  dom.toasts.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, 3200);
}

/* ------------------------------ 通知设置 ------------------------------ */

function webhookRow(webhook = {}) {
  const row = el("div", { class: "webhook-item" });
  row.dataset.id = webhook.id ?? "";
  row.dataset.urlHint = webhook.urlHint ?? "";
  row.dataset.hasSecret = webhook.hasSecret ? "1" : "";

  const typeSelect = el(
    "select",
    { class: "input compact" },
    WEBHOOK_TYPES.map((item) => {
      const option = el("option", { value: item.value, text: item.label });
      if ((webhook.type ?? "dingtalk") === item.value) option.selected = true;
      return option;
    }),
  );
  typeSelect.addEventListener("change", () => {
    row.querySelector(".webhook-url").placeholder = typeSelect.value === "wecom"
      ? "企业微信机器人地址（含 key）"
      : typeSelect.value === "feishu"
        ? "飞书机器人地址（含 hook id）"
        : "钉钉机器人地址（含 access_token）";
  });

  const nameInput = el("input", { class: "input", type: "text", value: webhook.name ?? "", placeholder: "名称，如 运维群" });
  const enabledLabel = el("label", { class: "toggle-inline", title: "启用该 Webhook" });
  const enabledBox = el("input", { type: "checkbox" });
  enabledBox.checked = webhook.enabled !== false;
  enabledLabel.append(enabledBox, el("span", { text: "启用" }));

  const removeButton = el("button", { class: "icon-btn", type: "button", title: "删除该 Webhook" }, [icon("i-trash")]);
  removeButton.addEventListener("click", () => {
    row.remove();
    updateWebhookEmpty();
  });

  const urlInput = el("input", {
    class: "input webhook-url",
    type: "text",
    placeholder: webhook.urlHint ? `留空保持不变（当前 ${webhook.urlHint}）` : "Webhook 地址",
    spellcheck: "false",
  });
  const secretInput = el("input", {
    class: "input",
    type: "password",
    placeholder: webhook.hasSecret ? "留空保持原密钥（已配置）" : "加签密钥（可选）",
    autocomplete: "off",
  });

  const eventsBox = el("div", { class: "webhook-events" });
  for (const [value, label] of [["threshold", "阈值告警"], ["digest", "定时汇总"]]) {
    const box = el("input", { type: "checkbox", value });
    box.checked = (webhook.events ?? ["threshold", "digest"]).includes(value);
    eventsBox.append(el("label", { class: "toggle-inline" }, [box, el("span", { text: label })]));
  }

  const testButton = el("button", { class: "btn ghost small", type: "button" }, [
    icon("i-activity"),
    el("span", { text: "发送测试" }),
  ]);
  testButton.addEventListener("click", () => testWebhook(row, testButton));

  const hint = el("span", { class: "webhook-hint", text: webhook.urlHint ? `已配置：${webhook.urlHint}` : "尚未保存" });

  row.append(
    el("div", { class: "webhook-head" }, [typeSelect, nameInput, enabledLabel, removeButton]),
    urlInput,
    secretInput,
    el("div", { class: "webhook-foot" }, [eventsBox, el("div", { class: "webhook-actions" }, [hint, testButton])]),
  );
  return row;
}

function updateWebhookEmpty() {
  dom.webhookEmpty.hidden = dom.webhookList.children.length > 0;
}

function collectWebhooks() {
  return [...dom.webhookList.querySelectorAll(".webhook-item")].map((row) => {
    const events = [...row.querySelectorAll(".webhook-events input:checked")].map((box) => box.value);
    const payload = {
      id: row.dataset.id || undefined,
      type: row.querySelector("select").value,
      name: row.querySelector(".webhook-head input[type=text]").value.trim(),
      enabled: row.querySelector(".toggle-inline input[type=checkbox]").checked,
      events,
    };
    const url = row.querySelector(".webhook-url").value.trim();
    if (url !== "") payload.url = url;
    const secret = row.querySelector('input[type="password"]').value;
    if (secret !== "") payload.secret = secret;
    return payload;
  });
}

function renderNotifySettings(settings) {
  dom.notifyEnabled.checked = settings.enabled !== false;
  dom.windowPercent.value = settings.rules?.windowPercent ?? 20;
  dom.balanceAmount.value = settings.rules?.balanceAmount ?? 10;
  dom.digestEnabled.checked = settings.digest?.enabled !== false;
  dom.digestTimes.value = (settings.digest?.times ?? []).join(", ");
  dom.digestTimezone.value = settings.digest?.timezone ?? "Asia/Shanghai";
  dom.webhookList.replaceChildren(...(settings.webhooks ?? []).map((webhook) => webhookRow(webhook)));
  updateWebhookEmpty();
}

async function openNotifyDialog() {
  dom.notifyError.hidden = true;
  try {
    const payload = await api("/api/notifications");
    renderNotifySettings(payload.settings ?? {});
    dom.notifyDialog.showModal();
  } catch (error) {
    if (!error.handled) toast(error.message, "error");
  }
}

async function saveNotifySettings() {
  dom.saveNotify.disabled = true;
  dom.notifyError.hidden = true;
  try {
    const payload = {
      enabled: dom.notifyEnabled.checked,
      rules: {
        windowPercent: Number(dom.windowPercent.value || 0),
        balanceAmount: Number(dom.balanceAmount.value || 0),
      },
      digest: {
        enabled: dom.digestEnabled.checked,
        times: dom.digestTimes.value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
        timezone: dom.digestTimezone.value.trim() || "Asia/Shanghai",
      },
      webhooks: collectWebhooks(),
    };
    const saved = await api("/api/notifications", { method: "PUT", body: JSON.stringify(payload) });
    renderNotifySettings(saved.settings ?? {});
    dom.notifyDialog.close();
    toast("通知设置已保存", "success");
  } catch (error) {
    dom.notifyError.textContent = error.message;
    dom.notifyError.hidden = false;
  } finally {
    dom.saveNotify.disabled = false;
  }
}

async function testWebhook(row, button) {
  button.disabled = true;
  try {
    let id = row.dataset.id;
    if (!id) {
      // 尚未保存：先保存一次拿到 id，再发送测试
      await api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({
          enabled: dom.notifyEnabled.checked,
          rules: {
            windowPercent: Number(dom.windowPercent.value || 0),
            balanceAmount: Number(dom.balanceAmount.value || 0),
          },
          digest: {
            enabled: dom.digestEnabled.checked,
            times: dom.digestTimes.value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
            timezone: dom.digestTimezone.value.trim() || "Asia/Shanghai",
          },
          webhooks: collectWebhooks(),
        }),
      });
      const fresh = await api("/api/notifications");
      renderNotifySettings(fresh.settings ?? {});
      toast("已先保存设置，请再点一次「发送测试」", "info");
      return;
    }
    await api("/api/notifications/test", { method: "POST", body: JSON.stringify({ webhookId: id }) });
    toast("测试消息已发送", "success");
  } catch (error) {
    toast(`测试失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function previewDigest() {
  try {
    const payload = await api("/api/notifications/preview?kind=digest");
    dom.detailsTitle.textContent = "汇总消息预览";
    dom.detailsRaw.textContent = payload.message?.markdown ?? "暂无数据";
    dom.detailsDialog.showModal();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------- countdowns ------------------------------- */

function updateCountdowns() {
  for (const node of document.querySelectorAll("[data-countdown]")) {
    const text = formatCountdown(node.dataset.countdown);
    if (!text) continue;
    const prefix = node.dataset.countdownPrefix ?? "";
    const suffix = prefix === "" ? " 后重置" : "";
    const label = node.querySelector("span:last-child");
    if (label) label.textContent = `${prefix ? `${prefix} ` : ""}${text}${suffix}`;
  }
}

/* ---------------------------------- wiring --------------------------------- */

function restartTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  renderStats();
  if (state.intervalMs > 0) {
    state.timer = setInterval(() => refreshBalances(false), state.intervalMs);
  }
}

function init() {
  const stored = localStorage.getItem("aimonitor.interval");
  if (stored !== null && [0, 30000, 60000, 300000].includes(Number(stored))) {
    state.intervalMs = Number(stored);
  }
  dom.refreshInterval.value = String(state.intervalMs);

  dom.refreshInterval.addEventListener("change", () => {
    state.intervalMs = Number(dom.refreshInterval.value);
    localStorage.setItem("aimonitor.interval", String(state.intervalMs));
    restartTimer();
  });
  dom.refreshAll.addEventListener("click", () => refreshBalances(true));
  dom.addAccount.addEventListener("click", () => openAccountDialog(null));
  dom.emptyAdd.addEventListener("click", () => openAccountDialog(null));
  dom.authButton.addEventListener("click", () => openAuthDialog());
  dom.notifySettings.addEventListener("click", openNotifyDialog);
  dom.saveNotify.addEventListener("click", saveNotifySettings);
  dom.previewDigest.addEventListener("click", previewDigest);
  dom.addWebhook.addEventListener("click", () => {
    dom.webhookList.append(webhookRow({ type: "dingtalk", events: ["threshold", "digest"] }));
    updateWebhookEmpty();
  });
  dom.authForm.addEventListener("submit", saveAuthToken);
  dom.clearAuthToken.addEventListener("click", clearAuthToken);
  dom.accountForm.addEventListener("submit", submitAccount);
  dom.confirmDelete.addEventListener("click", confirmDelete);
  dom.copyRaw.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(dom.detailsRaw.textContent ?? "");
      toast("已复制原始数据", "success");
    } catch {
      toast("复制失败", "error");
    }
  });
  dom.accountForm.querySelectorAll('input[name="type"]').forEach((input) => {
    input.addEventListener("change", syncProviderFields);
  });
  dom.sub2AuthMode.addEventListener("change", syncProviderFields);
  dom.customMethod.addEventListener("change", syncProviderFields);
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  restartTimer();
  setInterval(updateCountdowns, 1000);
  updateCountdowns();
  updateAuthButton();

  (async () => {
    try {
      const urlToken = new URLSearchParams(location.search).get("token");
      if (urlToken && urlToken.trim() !== "") {
        storeToken(urlToken.trim());
        const cleaned = new URL(location.href);
        cleaned.searchParams.delete("token");
        history.replaceState(null, "", `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
      }
      const health = await api("/api/health");
      state.authRequired = Boolean(health?.authRequired) && readToken() === "";
      updateAuthButton();
      await loadAccounts();
      state.authRequired = false;
      updateAuthButton();
      await refreshBalances(false);
    } catch (error) {
      if (!error.handled) toast(error.message, "error");
    }
  })();
}

init();
