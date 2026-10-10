import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server.js";

async function buildServer(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimonitor-auth-"));
  const app = createApp({ dataDir, ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    tokenRequired: app.tokenRequired,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

test("访问令牌：secureCookie 开启时 Cookie 带 Secure（不依赖代理头）", async () => {
  const app = await buildServer({ accessToken: "secure-token", secureCookie: true });
  try {
    const response = await fetch(`${app.baseUrl}/api/accounts?token=secure-token`);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  } finally {
    await app.close();
  }
});

test("访问令牌：未配置时接口保持开放", async () => {
  const app = await buildServer();
  try {
    const health = await (await fetch(`${app.baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.authRequired, false);
    assert.equal(app.tokenRequired, false);
    const accounts = await fetch(`${app.baseUrl}/api/accounts`);
    assert.equal(accounts.status, 200);
  } finally {
    await app.close();
  }
});

test("访问令牌：未授权请求返回 401，静态页面仍可访问", async () => {
  const app = await buildServer({ accessToken: "lan-secret-token" });
  try {
    const accounts = await fetch(`${app.baseUrl}/api/accounts`);
    assert.equal(accounts.status, 401);
    assert.match(accounts.headers.get("www-authenticate") ?? "", /Bearer/);
    const error = await accounts.json();
    assert.match(error.error, /访问令牌/);

    const balances = await fetch(`${app.baseUrl}/api/balances`);
    assert.equal(balances.status, 401);
    await balances.text();

    const health = await (await fetch(`${app.baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.authRequired, true);
    assert.equal(health.accounts, undefined);

    const page = await fetch(`${app.baseUrl}/`);
    assert.equal(page.status, 200);
  } finally {
    await app.close();
  }
});

test("访问令牌：支持 Authorization、X-Access-Token 与 ?token= 三种方式", async () => {
  const app = await buildServer({ accessToken: "lan-secret-token" });
  try {
    const bearer = await fetch(`${app.baseUrl}/api/accounts`, {
      headers: { Authorization: "Bearer lan-secret-token" },
    });
    assert.equal(bearer.status, 200);

    const header = await fetch(`${app.baseUrl}/api/accounts`, {
      headers: { "X-Access-Token": "lan-secret-token" },
    });
    assert.equal(header.status, 200);

    const query = await fetch(`${app.baseUrl}/api/accounts?token=lan-secret-token`);
    assert.equal(query.status, 200);
    assert.match(query.headers.get("set-cookie") ?? "", /aimonitor_token=/);

    const cookie = query.headers.get("set-cookie").split(";")[0];
    const withCookie = await fetch(`${app.baseUrl}/api/accounts`, { headers: { Cookie: cookie } });
    assert.equal(withCookie.status, 200);

    // 明文 HTTP 不设置 Secure，避免本地开发时 Cookie 被浏览器丢弃
    assert.doesNotMatch(query.headers.get("set-cookie"), /Secure/);

    // 经过 Ingress（X-Forwarded-Proto: https）时必须带 Secure
    const forwarded = await fetch(`${app.baseUrl}/api/accounts?token=lan-secret-token`, {
      headers: { "X-Forwarded-Proto": "https" },
    });
    assert.equal(forwarded.status, 200);
    assert.match(forwarded.headers.get("set-cookie"), /HttpOnly/);
    assert.match(forwarded.headers.get("set-cookie"), /Secure/);

    const wrong = await fetch(`${app.baseUrl}/api/accounts`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);
    await wrong.text();
  } finally {
    await app.close();
  }
});

test("访问令牌：写操作同样受保护", async () => {
  const app = await buildServer({ accessToken: "write-secret" });
  try {
    const payload = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "opencode", name: "测试", key: "sk-x", options: {} }),
    };
    const denied = await fetch(`${app.baseUrl}/api/accounts`, payload);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${app.baseUrl}/api/accounts`, {
      ...payload,
      headers: { ...payload.headers, Authorization: "Bearer write-secret" },
    });
    assert.equal(allowed.status, 201);
  } finally {
    await app.close();
  }
});

test("CORS：默认不下发跨源头，AIMONITOR_CORS 可显式放行", async () => {
  const app = await buildServer();
  try {
    const response = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: "https://other.example" } });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally {
    await app.close();
  }

  process.env.AIMONITOR_CORS = "https://other.example";
  const scoped = await buildServer();
  try {
    const allowed = await fetch(`${scoped.baseUrl}/api/health`, { headers: { Origin: "https://other.example" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://other.example");
    const blocked = await fetch(`${scoped.baseUrl}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  } finally {
    delete process.env.AIMONITOR_CORS;
    await scoped.close();
  }
});
