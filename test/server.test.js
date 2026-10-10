import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server.js";
import { startMockProvider } from "./helpers/mock-server.js";

const SAMPLE_PAYLOAD = {
  currency: "CNY",
  expire_at: "2026-10-20T13:31:14.171139Z",
  has_active_plan: true,
  plan_name: "国模畅用Lite",
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

async function buildServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimonitor-test-"));
  const { server, store } = createApp({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    dataDir,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("HTTP 接口：账户增删改查与余额聚合", async () => {
  const provider = await startMockProvider({ "/quota": { body: SAMPLE_PAYLOAD } });
  const app = await buildServer();
  try {
    const createResponse = await fetch(`${app.baseUrl}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "custom",
        name: "国模畅用Lite",
        baseUrl: provider.baseUrl,
        key: "secret-key-1234",
        options: { path: "/quota", authStyle: "bearer" },
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const accountId = created.account.id;
    assert.equal(created.account.hasKey, true);
    assert.ok(!JSON.stringify(created.account).includes("secret-key-1234"));

    const listResponse = await fetch(`${app.baseUrl}/api/accounts`);
    const list = await listResponse.json();
    assert.equal(list.accounts.length, 1);
    assert.equal(list.accounts[0].keyHint.startsWith("secre"), true);

    const balanceResponse = await fetch(`${app.baseUrl}/api/balances`);
    assert.equal(balanceResponse.status, 200);
    const balances = await balanceResponse.json();
    const result = balances.results[accountId];
    assert.equal(result.ok, true);
    assert.equal(result.plan.name, "国模畅用Lite");
    assert.equal(result.windows.length, 3);
    assert.equal(result.windows[2].limit, 299);
    assert.equal(result.currency, "CNY");

    const updateResponse = await fetch(`${app.baseUrl}/api/accounts/${accountId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新的名称" }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();
    assert.equal(updated.account.name, "新的名称");
    assert.equal(updated.account.hasKey, true);

    const singleResponse = await fetch(`${app.baseUrl}/api/accounts/${accountId}/balance?force=1`);
    const single = await singleResponse.json();
    assert.equal(single.ok, true);
    assert.equal(single.result.accountId, accountId);

    const deleteResponse = await fetch(`${app.baseUrl}/api/accounts/${accountId}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    const after = await fetch(`${app.baseUrl}/api/accounts`);
    assert.equal((await after.json()).accounts.length, 0);
  } finally {
    await app.close();
    await provider.close();
  }
});

test("HTTP 接口：校验错误与静态页面", async () => {
  const app = await buildServer();
  try {
    const invalid = await fetch(`${app.baseUrl}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "newapi", name: "缺少地址" }),
    });
    assert.equal(invalid.status, 400);
    const invalidPayload = await invalid.json();
    assert.match(invalidPayload.error, /服务地址/);

    const html = await fetch(`${app.baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(await html.text(), /AI 账户余额/);

    const missing = await fetch(`${app.baseUrl}/api/unknown`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test("HTTP 接口：失败账户返回错误而不影响其他账户", async () => {
  const provider = await startMockProvider({
    "/good": { body: { balance: 10, currency: "USD" } },
    "/bad": { status: 500, body: { message: "内部错误" } },
  });
  const app = await buildServer();
  try {
    for (const [name, routePath] of [
      ["正常账户", "/good"],
      ["异常账户", "/bad"],
    ]) {
      const response = await fetch(`${app.baseUrl}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "custom",
          name,
          baseUrl: provider.baseUrl,
          options: { path: routePath, authStyle: "none" },
        }),
      });
      assert.equal(response.status, 201, `创建 ${name} 失败`);
    }
    const balances = await (await fetch(`${app.baseUrl}/api/balances`)).json();
    const results = Object.values(balances.results);
    assert.equal(results.length, 2);
    const good = results.find((result) => result.name === "正常账户");
    const bad = results.find((result) => result.name === "异常账户");
    assert.equal(good.ok, true);
    assert.equal(good.balance.remaining, 10);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /500/);
  } finally {
    await app.close();
    await provider.close();
  }
});
