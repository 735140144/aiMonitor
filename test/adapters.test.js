import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderError,
  failureResult,
  fetchCustom,
  fetchNewApi,
  fetchOpenCodeGo,
  fetchSub2Api,
  fetchSub2ApiUsage,
  normalizeCustomBalance,
  normalizeSub2Usage,
  resolveOpenCodeUsageUrl,
} from "../src/adapters.js";
import { startMockProvider } from "./helpers/mock-server.js";

const SAMPLE_CUSTOM_PAYLOAD = {
  auto_reload_amount: "0",
  auto_reload_enabled: false,
  auto_reload_threshold: "0",
  banked_resets: [],
  currency: "CNY",
  expire_at: "2026-10-20T13:31:14.171139Z",
  has_active_plan: true,
  monthly_spend_limit: "0",
  monthly_spend_used: "0",
  plan_name: "示例套餐 A",
  plan_type: "quota_subscription",
  quota_5h: "39",
  quota_monthly: "299",
  quota_weekly: "99",
  reset_5h_at: "2026-10-10T13:31:14.171139Z",
  reset_monthly_at: "2026-10-20T13:31:14.171139Z",
  reset_weekly_at: "2026-10-12T10:42:25.745196Z",
  used_5h: "15.62613328",
  used_monthly: "299.0907776",
  used_weekly: "59.1221858",
};

function customAccount(payloadMapping, extra = {}) {
  return {
    id: "custom-1",
    name: "示例套餐",
    type: "custom",
    baseUrl: "https://example.com",
    key: "",
    options: { authStyle: "none", mapping: payloadMapping ? JSON.stringify(payloadMapping) : "", ...extra },
  };
}

test("自定义接口：自动识别示例套餐结构", () => {
  const result = normalizeCustomBalance(SAMPLE_CUSTOM_PAYLOAD, customAccount());
  assert.equal(result.ok, true);
  assert.equal(result.currency, "CNY");
  assert.equal(result.plan.name, "示例套餐 A");
  assert.equal(result.plan.active, true);
  assert.equal(result.plan.type, "quota_subscription");
  assert.equal(result.plan.expireAt, "2026-10-20T13:31:14.171Z");
  assert.deepEqual(
    result.windows.map((window) => window.key),
    ["5h", "weekly", "monthly"],
  );
  const fiveHour = result.windows[0];
  assert.equal(fiveHour.limit, 39);
  assert.equal(fiveHour.used, 15.626133);
  assert.equal(fiveHour.remaining, 23.373867);
  assert.equal(fiveHour.resetAt, "2026-10-10T13:31:14.171Z");
  const monthly = result.windows[2];
  assert.equal(monthly.limit, 299);
  assert.equal(monthly.remaining, -0.090778);
  assert.ok(monthly.percent > 100);
  assert.equal(result.balance.remaining, -0.090778);
  assert.equal(result.balance.total, 299);
  assert.equal(result.autoReload.enabled, false);
});

test("自定义接口：识别余额字段与货币", () => {
  const result = normalizeCustomBalance(
    { data: { balance: "¥1,204.50", used: "295.50", total: "1500", currency: "CNY", username: "ops" } },
    customAccount(),
  );
  assert.equal(result.balance.remaining, 1204.5);
  assert.equal(result.balance.used, 295.5);
  assert.equal(result.balance.total, 1500);
  assert.equal(result.currency, "CNY");
  assert.equal(result.subject.label, "ops");
});

test("自定义接口：识别百分比窗口", () => {
  const result = normalizeCustomBalance(
    {
      usage: {
        rolling: { status: "ok", percent: 12.5, resetsAt: "2026-10-10T18:00:00Z" },
        weekly: { status: "ok", percent: 40, resetsAt: "2026-10-12T00:00:00Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-01T00:00:00Z" },
      },
    },
    customAccount(),
  );
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[0].unit, "%");
  assert.equal(result.windows[0].remaining, 87.5);
  assert.equal(result.windows[2].status, "rate-limited");
});

test("自定义接口：显式字段映射", () => {
  const mapping = {
    root: "data",
    balanceRemaining: "credit.left",
    balanceUsed: "credit.spent",
    currency: "unit",
    planName: "plan.title",
    windows: {
      monthly: { limit: "plan.quota", used: "plan.used", resetAt: "plan.reset_at" },
    },
  };
  const result = normalizeCustomBalance(
    {
      data: {
        credit: { left: 42.5, spent: 7.5 },
        unit: "USD",
        plan: { title: "团队版", quota: 50, used: 7.5, reset_at: "2026-11-01T00:00:00Z" },
      },
    },
    customAccount(mapping),
  );
  assert.equal(result.currency, "USD");
  assert.equal(result.balance.remaining, 42.5);
  assert.equal(result.plan.name, "团队版");
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remaining, 42.5);
});

test("New API：读取 /api/user/self 余额并换算货币", async () => {
  const provider = await startMockProvider({
    "/api/user/self": {
      body: { success: true, data: { quota: 2500000, used_quota: 1000000, username: "alice", group: "default" } },
    },
    "/api/status": { body: { success: true, data: { quota_per_unit: 500000, quota_display_type: "USD" } } },
  });
  try {
    const result = await fetchNewApi({ id: "n1", type: "newapi", baseUrl: provider.baseUrl, key: "pat-1", options: {} });
    assert.equal(result.ok, true);
    assert.equal(result.currency, "USD");
    assert.equal(result.balance.remaining, 5);
    assert.equal(result.balance.used, 2);
    assert.equal(result.balance.total, 7);
    assert.equal(result.subject.label, "alice");
    assert.equal(result.subject.detail, "分组 default");
    assert.equal(provider.calls[0].headers.authorization, "Bearer pat-1");
  } finally {
    await provider.close();
  }
});

test("New API：自定义配额单位与货币", async () => {
  const provider = await startMockProvider({
    "/api/user/self": { body: { success: true, data: { quota: 100, used_quota: 50, username: "bob" } } },
  });
  try {
    const result = await fetchNewApi({
      id: "n2",
      type: "newapi",
      baseUrl: provider.baseUrl,
      key: "pat-2",
      options: { quotaPerUnit: "10", currency: "CNY" },
    });
    assert.equal(result.currency, "CNY");
    assert.equal(result.balance.remaining, 10);
    assert.equal(result.balance.total, 15);
  } finally {
    await provider.close();
  }
});

test("New API：拒绝访问时抛出错误", async () => {
  const provider = await startMockProvider({
    "/api/user/self": { status: 401, body: { success: false, message: "无效的访问令牌" } },
  });
  try {
    const account = { id: "n3", type: "newapi", name: "bad", baseUrl: provider.baseUrl, key: "x", options: {} };
    await assert.rejects(
      () => fetchNewApi({ ...account }),
      (error) => error instanceof ProviderError && error.message.includes("401"),
    );
    const failure = failureResult(account, new ProviderError("New API 返回 HTTP 401"));
    assert.equal(failure.ok, false);
    assert.equal(failure.accountId, "n3");
  } finally {
    await provider.close();
  }
});

test("OpenCode Go：解析 5 小时 / 周 / 月用量", async () => {
  const provider = await startMockProvider({
    "/zen/go/v1/usage": {
      body: {
        usage: {
          rolling: { status: "ok", percent: 12.5, resetsAt: "2026-10-10T18:00:00Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-10-12T00:00:00Z" },
          monthly: { status: "ok", percent: 91.2, resetsAt: "2026-11-01T00:00:00Z" },
        },
      },
    },
  });
  try {
    const result = await fetchOpenCodeGo({
      id: "oc1",
      type: "opencode",
      baseUrl: provider.baseUrl,
      key: "zen-key",
      options: {},
    });
    assert.equal(result.windows.length, 3);
    assert.equal(result.windows[0].key, "5h");
    assert.equal(result.windows[0].remaining, 87.5);
    assert.equal(result.windows[2].percent, 91.2);
    assert.equal(result.plan.name, "OpenCode Go");
    assert.equal(provider.calls[0].headers.authorization, "Bearer zen-key");
  } finally {
    await provider.close();
  }
});

test("OpenCode Go：缺少授权时透传错误信息", async () => {
  const provider = await startMockProvider({
    "/zen/go/v1/usage": {
      status: 401,
      body: { type: "error", error: { type: "AuthError", message: "Unauthorized" } },
    },
  });
  try {
    await assert.rejects(
      () => fetchOpenCodeGo({ id: "oc2", type: "opencode", baseUrl: provider.baseUrl, key: "bad", options: {} }),
      /Unauthorized/,
    );
  } finally {
    await provider.close();
  }
});

// 用户提供的真实 OpenCode Go 响应：5h 为 0%、本月已限流
const OPENCODE_GO_PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-10-10T21:00:51.277Z" },
    weekly: { status: "ok", percent: 22, resetsAt: "2026-10-12T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-16T02:23:18.000Z" },
  },
};

test("OpenCode Go：解析真实响应（含 rate-limited）", async () => {
  const provider = await startMockProvider({ "/zen/go/v1/usage": { body: OPENCODE_GO_PAYLOAD } });
  try {
    const result = await fetchOpenCodeGo({
      id: "oc3",
      name: "OpenCode Go",
      type: "opencode",
      baseUrl: provider.baseUrl,
      key: "sk-zen",
      options: {},
    });
    assert.deepEqual(
      result.windows.map((window) => [window.key, window.percent, window.remaining, window.status]),
      [
        ["5h", 0, 100, "ok"],
        ["weekly", 22, 78, "ok"],
        ["monthly", 100, 0, "rate-limited"],
      ],
    );
    assert.equal(result.windows[2].resetAt, "2026-10-16T02:23:18.000Z");
  } finally {
    await provider.close();
  }
});

test("OpenCode Go：baseUrl 归一化，避免重复拼接路径", () => {
  const cases = [
    ["https://opencode.ai", "https://opencode.ai/zen/go/v1/usage"],
    ["https://opencode.ai/", "https://opencode.ai/zen/go/v1/usage"],
    ["https://opencode.ai/zen/go/v1/usage", "https://opencode.ai/zen/go/v1/usage"],
    ["https://opencode.ai/zen/go/v1/usage/", "https://opencode.ai/zen/go/v1/usage"],
    ["https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/usage"],
    ["https://proxy.example.com/opencode/", "https://proxy.example.com/opencode/zen/go/v1/usage"],
    ["", "https://opencode.ai/zen/go/v1/usage"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveOpenCodeUsageUrl(input), expected, `baseUrl=${JSON.stringify(input)}`);
  }
});

test("OpenCode Go：直接粘贴完整接口地址时只请求一次正确路径", async () => {
  const provider = await startMockProvider({ "/zen/go/v1/usage": { body: OPENCODE_GO_PAYLOAD } });
  try {
    const result = await fetchOpenCodeGo({
      id: "oc4",
      name: "粘贴完整地址",
      type: "opencode",
      baseUrl: `${provider.baseUrl}/zen/go/v1/usage`,
      key: "sk-zen",
      options: {},
    });
    assert.equal(result.windows.length, 3);
    assert.deepEqual(
      provider.calls.map((call) => call.path),
      ["/zen/go/v1/usage"],
    );
  } finally {
    await provider.close();
  }
});

test("Sub2API：使用 Access Token 读取余额与订阅进度", async () => {
  const provider = await startMockProvider({
    "/api/v1/user/profile": {
      body: { code: 0, message: "success", data: { user: { username: "bob", balance: 12.5 } } },
    },
    "/api/v1/subscriptions/progress": {
      body: {
        code: 0,
        message: "success",
        data: [
          {
            subscription: { group_name: "Pro" },
            progress: {
              group_name: "Pro",
              expires_at: "2026-11-01T00:00:00Z",
              daily: {
                limit_usd: 5,
                used_usd: 1.25,
                remaining_usd: 3.75,
                percentage: 25,
                resets_at: "2026-10-11T00:00:00Z",
              },
              weekly: {
                limit_usd: 20,
                used_usd: 8,
                remaining_usd: 12,
                percentage: 40,
                resets_at: "2026-10-13T00:00:00Z",
              },
              monthly: {
                limit_usd: 50,
                used_usd: 30,
                remaining_usd: 20,
                percentage: 60,
                resets_at: "2026-11-01T00:00:00Z",
              },
            },
          },
        ],
      },
    },
  });
  try {
    const result = await fetchSub2Api({
      id: "s1",
      type: "sub2api",
      baseUrl: provider.baseUrl,
      key: "jwt-token",
      options: { authMode: "token" },
    });
    assert.equal(result.balance.remaining, 12.5);
    assert.equal(result.balance.used, 30);
    assert.equal(result.balance.total, 50);
    assert.equal(result.windows.length, 3);
    assert.equal(result.windows[2].key, "monthly");
    assert.equal(result.windows[2].remaining, 20);
    assert.equal(result.plan.name, "Pro");
    assert.equal(result.plan.expireAt, "2026-11-01T00:00:00.000Z");
    assert.equal(provider.calls[0].headers.authorization, "Bearer jwt-token");
  } finally {
    await provider.close();
  }
});

test("Sub2API：邮箱密码模式自动登录并缓存令牌", async () => {
  const provider = await startMockProvider({
    "/api/v1/auth/login": ({ body }) => {
      const parsed = JSON.parse(body);
      if (parsed.email !== "me@example.com" || parsed.password !== "secret") {
        return { status: 401, body: { code: 401, message: "invalid credentials" } };
      }
      return { body: { code: 0, message: "success", data: { access_token: "jwt-1", expires_in: 3600 } } };
    },
    "/api/v1/user/profile": ({ request }) => {
      if (request.headers.authorization !== "Bearer jwt-1") {
        return { status: 401, body: { code: 401, message: "unauthorized" } };
      }
      return { body: { code: 0, data: { user: { username: "carol", balance: 3 } } } };
    },
    "/api/v1/subscriptions/progress": {
      body: { code: 0, data: [] },
    },
  });
  try {
    const account = {
      id: "s2",
      type: "sub2api",
      baseUrl: provider.baseUrl,
      key: "secret",
      options: { authMode: "password", email: "me@example.com" },
    };
    const first = await fetchSub2Api(account);
    const second = await fetchSub2Api(account);
    assert.equal(first.balance.remaining, 3);
    assert.equal(second.balance.remaining, 3);
    const loginCalls = provider.calls.filter((call) => call.path === "/api/v1/auth/login");
    assert.equal(loginCalls.length, 1);
  } finally {
    await provider.close();
  }
});

test("Sub2API：业务错误码转为异常", async () => {
  const provider = await startMockProvider({
    "/api/v1/user/profile": { body: { code: 500, message: "服务异常" } },
    "/api/v1/subscriptions/progress": { body: { code: 0, data: [] } },
  });
  try {
    await assert.rejects(
      () =>
        fetchSub2Api({
          id: "s3",
          type: "sub2api",
          baseUrl: provider.baseUrl,
          key: "jwt",
          options: { authMode: "token" },
        }),
      /服务异常/,
    );
  } finally {
    await provider.close();
  }
});

// 用户提供的真实 /v1/usage 响应（钱包余额模式）
const SUB2_USAGE_BALANCE_PAYLOAD = {
  balance: 43.91152113,
  daily_usage: [
    { date: "2026-09-14", requests: 11, total_tokens: 598916, cost: 8.5842972, actual_cost: 0.19685944 },
    { date: "2026-09-17", requests: 4, total_tokens: 15383, cost: 32, actual_cost: 0.32 },
  ],
  isValid: true,
  mode: "unrestricted",
  model_stats: [
    { model: "gpt-5.6-terra", requests: 33, total_tokens: 1421213, cost: 1.7569352, actual_cost: 0.35138704 },
    { model: "gpt-image-2", requests: 17, total_tokens: 38616, cost: 136, actual_cost: 1.36 },
    { model: "codex-auto-review", requests: 4, total_tokens: 5591, cost: 0.00041974, actual_cost: 0.000083948 },
  ],
  planName: "钱包余额",
  remaining: 43.91152113,
  unit: "USD",
  usage: {
    average_duration_ms: 30828.216279069766,
    rpm: 0,
    today: {
      actual_cost: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost: 0,
      input_tokens: 0, output_tokens: 0, requests: 0, total_tokens: 0,
    },
    total: {
      actual_cost: 5.866622632, cache_creation_tokens: 0, cache_read_tokens: 22776481,
      cost: 232.30968266, input_tokens: 4274138, output_tokens: 161965,
      requests: 430, total_tokens: 27212584,
    },
    tpm: 0,
  },
};

test("Sub2API /v1/usage：钱包余额模式（用户实际返回）", () => {
  const result = normalizeSub2Usage(SUB2_USAGE_BALANCE_PAYLOAD, { id: "u1", name: "钱包账户", type: "sub2api" });
  assert.equal(result.ok, true);
  assert.equal(result.currency, "USD");
  assert.equal(result.balance.remaining, 43.911521);
  assert.equal(result.balance.used, 5.866623, "已用取实际扣费 actual_cost");
  assert.equal(result.balance.total, null);
  assert.equal(result.plan.name, "钱包余额");
  assert.equal(result.plan.type, "wallet");
  assert.equal(result.plan.active, true);
  assert.equal(result.windows.length, 0);
  assert.deepEqual(result.meta, [
    { label: "累计请求", value: 430, suffix: " 次" },
    { label: "累计 Tokens", value: 27212584, compact: true },
    { label: "模型", text: "gpt-5.6-terra 等 3 个" },
  ]);
  assert.equal(result.raw.balance, 43.91152113);
});

test("Sub2API /v1/usage：订阅分组模式输出日/周/月额度", () => {
  const result = normalizeSub2Usage(
    {
      mode: "unrestricted",
      isValid: true,
      planName: "Pro 订阅",
      remaining: 8.5,
      unit: "USD",
      subscription: {
        daily_usage_usd: 1.2, daily_limit_usd: 5,
        weekly_usage_usd: 11.5, weekly_limit_usd: 20,
        monthly_usage_usd: 62.4, monthly_limit_usd: 80,
        weekly_window_start: "2026-10-10T00:00:00Z",
        expires_at: "2026-11-01T00:00:00Z",
      },
      usage: { total: { requests: 12, total_tokens: 3456, actual_cost: 62.4 } },
    },
    { id: "u2", name: "订阅账户", type: "sub2api" },
  );
  assert.equal(result.plan.type, "subscription");
  assert.equal(result.plan.name, "Pro 订阅");
  assert.deepEqual(result.windows.map((w) => w.key), ["daily", "weekly", "monthly"]);
  assert.equal(result.windows[0].remaining, 3.8);
  assert.equal(result.windows[1].remaining, 8.5);
  assert.equal(result.windows[1].resetAt, "2026-10-17T00:00:00.000Z");
  assert.equal(result.plan.expireAt, "2026-11-01T00:00:00.000Z");
});

test("Sub2API /v1/usage：quota_limited 模式输出总额度与 5h/日/周速率限制", () => {
  const result = normalizeSub2Usage(
    {
      mode: "quota_limited",
      isValid: true,
      status: "active",
      quota: { limit: 100, used: 30, remaining: 70, unit: "USD" },
      remaining: 70,
      unit: "USD",
      rate_limits: [
        { window: "5h", limit: 10, used: 2, remaining: 8, reset_at: "2026-10-10T18:00:00Z" },
        { window: "1d", limit: 30, used: 5, remaining: 25 },
        { window: "7d", limit: 60, used: 20, remaining: 40 },
      ],
    },
    { id: "u3", name: "额度 Key", type: "sub2api" },
  );
  assert.equal(result.balance.remaining, 70);
  assert.equal(result.balance.used, 30);
  assert.equal(result.balance.total, 100);
  assert.equal(result.plan.type, "quota");
  assert.equal(result.subject.detail, "状态 active");
  assert.deepEqual(result.windows.map((w) => w.key), ["5h", "daily", "weekly"]);
  assert.equal(result.windows[0].remaining, 8);
  assert.equal(result.windows[2].limit, 60);
});

test("Sub2API /v1/usage：isValid=false 视为错误", () => {
  assert.throws(
    () => normalizeSub2Usage({ isValid: false, status: "disabled", mode: "quota_limited" }, { id: "u4", type: "sub2api" }),
    /密钥不可用/,
  );
});

test("Sub2API：默认走 API 密钥模式请求 /v1/usage", async () => {
  const provider = await startMockProvider({
    "/v1/usage": ({ request }) => {
      assert.equal(request.headers.authorization, "Bearer sk-gateway");
      return { body: SUB2_USAGE_BALANCE_PAYLOAD };
    },
  });
  try {
    const result = await fetchSub2Api({
      id: "u5",
      name: "默认模式",
      type: "sub2api",
      baseUrl: provider.baseUrl,
      key: "sk-gateway",
      options: {},
    });
    assert.equal(result.balance.remaining, 43.911521);
    assert.equal(provider.calls[0].path, "/v1/usage");
  } finally {
    await provider.close();
  }
});

test("Sub2API /v1/usage：404 时提示改用面板令牌", async () => {
  const provider = await startMockProvider({});
  try {
    await assert.rejects(
      () =>
        fetchSub2ApiUsage({
          id: "u6",
          name: "没有该接口",
          type: "sub2api",
          baseUrl: provider.baseUrl,
          key: "sk",
          options: { authMode: "apikey" },
        }),
      /面板令牌/,
    );
  } finally {
    await provider.close();
  }
});

test("Sub2API /v1/usage：401 时提示确认 API 密钥", async () => {
  const provider = await startMockProvider({
    "/v1/usage": { status: 401, body: { message: "Invalid API key" } },
  });
  try {
    await assert.rejects(
      () =>
        fetchSub2ApiUsage({
          id: "u7",
          name: "密钥错误",
          type: "sub2api",
          baseUrl: provider.baseUrl,
          key: "bad",
          options: { authMode: "apikey" },
        }),
      /请确认填的是 Sub2API 网关的 API 密钥/,
    );
  } finally {
    await provider.close();
  }
});

test("Sub2API：面板令牌模式遇到网关密钥时自动降级到 /v1/usage", async () => {
  const provider = await startMockProvider({
    "/api/v1/user/profile": { status: 401, body: { code: 401, message: "Invalid token" } },
    "/v1/usage": ({ request }) => {
      assert.equal(request.headers.authorization, "Bearer sk-gateway");
      return { body: SUB2_USAGE_BALANCE_PAYLOAD };
    },
  });
  try {
    const result = await fetchSub2Api({
      id: "u8",
      name: "旧账户",
      type: "sub2api",
      baseUrl: provider.baseUrl,
      key: "sk-gateway",
      options: { authMode: "token" },
    });
    assert.equal(result.balance.remaining, 43.911521);
    assert.equal(result.plan.name, "钱包余额");
    assert.match(result.subject.detail, /已按网关密钥解析/);
    assert.deepEqual(
      provider.calls.map((call) => call.path),
      ["/api/v1/user/profile", "/v1/usage"],
    );
  } finally {
    await provider.close();
  }
});

test("Sub2API：面板令牌可用时不会降级", async () => {
  const provider = await startMockProvider({
    "/api/v1/user/profile": { body: { code: 0, data: { user: { username: "panel", balance: 9.5 } } } },
    "/api/v1/subscriptions/progress": { body: { code: 0, data: [] } },
  });
  try {
    const result = await fetchSub2Api({
      id: "u9",
      name: "面板账户",
      type: "sub2api",
      baseUrl: provider.baseUrl,
      key: "panel-token",
      options: { authMode: "token" },
    });
    assert.equal(result.balance.remaining, 9.5);
    assert.equal(provider.calls.some((call) => call.path === "/v1/usage"), false);
  } finally {
    await provider.close();
  }
});

test("自定义接口：通过 HTTP 请求读取并应用认证头", async () => {
  const provider = await startMockProvider({
    "/api/quota": ({ request }) => {
      assert.equal(request.headers.authorization, "Bearer custom-key");
      return { body: SAMPLE_CUSTOM_PAYLOAD };
    },
  });
  try {
    const result = await fetchCustom({
      id: "c1",
      name: "自定义",
      type: "custom",
      baseUrl: provider.baseUrl,
      key: "custom-key",
      options: { authStyle: "bearer", path: "/api/quota", method: "GET" },
    });
    assert.equal(result.plan.name, "示例套餐 A");
    assert.equal(result.windows.length, 3);
  } finally {
    await provider.close();
  }
});
