import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { failureResult, getBalance } from "./src/adapters.js";
import {
  NotificationError,
  NotificationStore,
  buildDigestMessage,
  buildDigestSections,
  buildThresholdMessage,
  publicSettings,
  sendWebhook,
  startNotificationScheduler,
} from "./src/notify.js";
import { AccountStore, TYPE_LABELS, ValidationError, toPublicAccount } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const BALANCE_CACHE_TTL_MS = Number(process.env.AIMONITOR_CACHE_MS ?? 10000);
const REQUEST_TIMEOUT_MS = Number(process.env.AIMONITOR_TIMEOUT_MS ?? 15000);
const MAX_BODY_BYTES = 512 * 1024;

/**
 * 默认不带 CORS 头（前端与接口同源即可）。需要跨源调用时用 AIMONITOR_CORS 显式放行，
 * 避免局域网下任意网页都能读取本机余额数据。
 */
function corsHeaders(request) {
  const configured = (process.env.AIMONITOR_CORS ?? "").trim();
  if (configured === "" || !request) return {};
  const origin = request.headers.origin;
  if (configured === "*") return { "Access-Control-Allow-Origin": "*" };
  const allowed = configured.split(",").map((item) => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response, statusCode, message, extraHeaders = {}) {
  sendJson(response, statusCode, { ok: false, error: message }, extraHeaders);
}

function tokenFromRequest(request, url) {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  const headerToken = request.headers["x-access-token"];
  if (typeof headerToken === "string" && headerToken.trim() !== "") return headerToken.trim();
  const queryToken = url?.searchParams.get("token");
  if (queryToken) return queryToken.trim();
  const cookie = request.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "aimonitor_token") return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || provided === "" || expected === "") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function lanIPv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("请求体不是合法 JSON");
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createApp({
  dataDir = process.env.AIMONITOR_DATA || path.join(__dirname, "data"),
  accessToken = process.env.AIMONITOR_TOKEN ?? "",
  secureCookie = /^(1|true|yes)$/i.test(String(process.env.AIMONITOR_SECURE_COOKIE ?? "")),
  startScheduler = false,
  schedulerIntervalMs = Number(process.env.AIMONITOR_NOTIFY_INTERVAL_MS ?? 60000),
  now = () => new Date(),
} = {}) {
  const store = new AccountStore(path.join(dataDir, "accounts.json")).load();
  const notificationStore = new NotificationStore(path.join(dataDir, "notifications.json")).load();
  const cache = new Map();
  const tokenRequired = typeof accessToken === "string" && accessToken.trim() !== "";
  const expectedToken = tokenRequired ? accessToken.trim() : "";

  const getBalances = async (accounts, { force = false } = {}) => {
    const now = Date.now();
    return mapWithConcurrency(accounts, 4, async (account) => {
      const cached = cache.get(account.id);
      if (!force && cached && now - cached.at < BALANCE_CACHE_TTL_MS) return cached.result;
      let result;
      try {
        result = await getBalance(account, { timeoutMs: REQUEST_TIMEOUT_MS });
      } catch (error) {
        result = failureResult(account, error);
      }
      cache.set(account.id, { at: Date.now(), result });
      return result;
    });
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    const cors = corsHeaders(request);
    const providedToken = tokenFromRequest(request, url);
    const authorized = !tokenRequired || tokensMatch(providedToken, expectedToken);

    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...cors,
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Access-Token",
        });
        response.end();
        return;
      }

      if (pathname === "/api/health") {
        sendJson(
          response,
          200,
          { ok: true, authRequired: tokenRequired, ...(authorized ? { accounts: store.list().length } : {}) },
          cors,
        );
        return;
      }

      // 清除 httpOnly 授权 Cookie（仅供本机浏览器主动退出使用）
      if (pathname === "/api/auth/logout" && request.method === "POST") {
        sendJson(response, 200, { ok: true }, {
          ...cors,
          "Set-Cookie": "aimonitor_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        });
        return;
      }

      // 静态页面本身不含密钥，保持公开，便于未授权设备打开页面后输入访问令牌。
      if (pathname.startsWith("/api/") && !authorized) {
        sendError(response, 401, "需要访问令牌", {
          ...cors,
          "WWW-Authenticate": 'Bearer realm="aimonitor"',
        });
        return;
      }

      // 通过 ?token= 首次访问成功后写入 Cookie，方便后续直接打开页面。
      // Ingress 终止 TLS 时上游可能不转发 X-Forwarded-Proto，因此以显式配置为准，同时兼容该头。
      const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
      const secureFlag = secureCookie || forwardedProto === "https" ? "; Secure" : "";
      const setCookie = tokenRequired && url.searchParams.has("token") ? {
        "Set-Cookie": `aimonitor_token=${encodeURIComponent(expectedToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureFlag}`,
      } : {};

      if (pathname === "/api/accounts") {
        if (request.method === "GET") {
          sendJson(response, 200, { ok: true, accounts: store.list().map(toPublicAccount) }, { ...cors, ...setCookie });
          return;
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          const account = store.create(body);
          sendJson(response, 201, { ok: true, account: toPublicAccount(account) }, { ...cors, ...setCookie });
          return;
        }
        sendError(response, 405, "不支持的请求方法", cors);
        return;
      }

      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accountMatch) {
        const id = accountMatch[1];
        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const account = store.update(id, body);
          if (!account) {
            sendError(response, 404, "账户不存在", cors);
            return;
          }
          cache.delete(id);
          sendJson(response, 200, { ok: true, account: toPublicAccount(account) }, { ...cors, ...setCookie });
          return;
        }
        if (request.method === "DELETE") {
          const removed = store.remove(id);
          cache.delete(id);
          if (!removed) {
            sendError(response, 404, "账户不存在", cors);
            return;
          }
          sendJson(response, 200, { ok: true }, { ...cors, ...setCookie });
          return;
        }
        if (request.method === "GET") {
          const account = store.get(id);
          if (!account) {
            sendError(response, 404, "账户不存在", cors);
            return;
          }
          sendJson(response, 200, { ok: true, account: toPublicAccount(account) }, { ...cors, ...setCookie });
          return;
        }
        sendError(response, 405, "不支持的请求方法", cors);
        return;
      }

      const singleBalanceMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/balance$/);
      if (singleBalanceMatch && request.method === "GET") {
        const account = store.get(singleBalanceMatch[1]);
        if (!account) {
          sendError(response, 404, "账户不存在", cors);
          return;
        }
        const [result] = await getBalances([account], { force: url.searchParams.get("force") === "1" });
        sendJson(response, 200, { ok: result.ok, result }, { ...cors, ...setCookie });
        return;
      }

      if (pathname === "/api/balances" && request.method === "GET") {
        const idsParam = url.searchParams.get("ids");
        const ids = idsParam ? idsParam.split(",").map((id) => id.trim()).filter(Boolean) : null;
        const accounts = ids ? store.list().filter((account) => ids.includes(account.id)) : store.list();
        const results = await getBalances(accounts, { force: url.searchParams.get("force") === "1" });
        const byId = {};
        for (const result of results) byId[result.accountId] = result;
        sendJson(
          response,
          200,
          {
            ok: results.every((result) => result.ok),
            fetchedAt: new Date().toISOString(),
            results: byId,
          },
          { ...cors, ...setCookie },
        );
        return;
      }

      if (pathname === "/api/notifications") {
        if (request.method === "GET") {
          sendJson(
            response,
            200,
            {
              ok: true,
              settings: publicSettings(notificationStore.getSettings()),
              state: {
                thresholds: Object.keys(notificationStore.getThresholdState()).length,
                digests: notificationStore.state.digests,
              },
            },
            { ...cors, ...setCookie },
          );
          return;
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const settings = notificationStore.updateSettings(body);
          sendJson(response, 200, { ok: true, settings: publicSettings(settings) }, { ...cors, ...setCookie });
          return;
        }
        sendError(response, 405, "不支持的请求方法", cors);
        return;
      }

      if (pathname === "/api/notifications/test" && request.method === "POST") {
        const body = await readJsonBody(request);
        const settings = notificationStore.getSettings();
        const webhook = settings.webhooks.find((item) => item.id === body.webhookId);
        if (!webhook) {
          sendError(response, 404, "Webhook 不存在", cors);
          return;
        }
        const sections = buildDigestSections(store.list(), Object.fromEntries(
          (await getBalances(store.list())).map((result) => [result.accountId, result]),
        ), { typeLabels: TYPE_LABELS });
        const message = buildDigestMessage(sections, { timezone: settings.digest.timezone });
        message.title = "测试消息 · 全局余量汇总";
        try {
          await sendWebhook(webhook, message);
          sendJson(response, 200, { ok: true }, { ...cors, ...setCookie });
        } catch (error) {
          sendError(response, error instanceof NotificationError ? error.statusCode ?? 502 : 502, error.message, cors);
        }
        return;
      }

      if (pathname === "/api/notifications/preview" && request.method === "GET") {
        const accounts = store.list();
        const results = Object.fromEntries(
          (await getBalances(accounts)).map((result) => [result.accountId, result]),
        );
        const settings = notificationStore.getSettings();
        const kind = url.searchParams.get("kind") === "threshold" ? "threshold" : "digest";
        const message =
          kind === "threshold"
            ? buildThresholdMessage([], { timezone: settings.digest.timezone })
            : buildDigestMessage(buildDigestSections(accounts, results, { typeLabels: TYPE_LABELS }), {
                timezone: settings.digest.timezone,
              });
        sendJson(response, 200, { ok: true, kind, message }, { ...cors, ...setCookie });
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendError(response, 404, "接口不存在", cors);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendError(response, 405, "不支持的请求方法", cors);
        return;
      }

      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.join(PUBLIC_DIR, relative);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        sendError(response, 403, "禁止访问", cors);
        return;
      }
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) {
        sendError(response, 404, "资源不存在", cors);
        return;
      }
      const extension = path.extname(filePath).toLowerCase();
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=60",
          ...setCookie,
        });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, error.statusCode ?? 400, error.message, cors);
        return;
      }
      console.error("[server]", error);
      sendError(response, 500, error.message ?? "服务器内部错误", cors);
    }
  });

  const scheduler = startNotificationScheduler({
    store,
    notificationStore,
    getBalances,
    typeLabels: TYPE_LABELS,
    intervalMs: schedulerIntervalMs,
    now,
  });

  if (!startScheduler) scheduler.stop();

  return {
    server,
    store,
    notificationStore,
    getBalances,
    typeLabels: TYPE_LABELS,
    tokenRequired,
    scheduler,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const host = process.env.AIMONITOR_HOST ?? "127.0.0.1";
  const basePort = Number(process.env.AIMONITOR_PORT ?? process.env.PORT ?? 8787);
  const { server, tokenRequired } = createApp({ startScheduler: true });
  const exposed = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";

  const listen = (port, attempt = 0) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" && attempt < 10 && !process.env.AIMONITOR_PORT && !process.env.PORT) {
        listen(port + 1, attempt + 1);
        return;
      }
      console.error(`[server] 启动失败：${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      const addresses = exposed ? ["127.0.0.1", ...lanIPv4Addresses()] : [host];
      console.log("AI 账户余额面板已启动：");
      for (const address of addresses) console.log(`  http://${address}:${port}`);
      if (exposed && !tokenRequired) {
        console.warn(
          "[安全提示] 当前监听局域网且未设置 AIMONITOR_TOKEN，同网段设备可查看并修改账户配置。\n" +
            "           建议重启时设置访问令牌：AIMONITOR_TOKEN=$(openssl rand -hex 16) npm run start:lan",
        );
      }
      if (exposed && tokenRequired) {
        console.log("  已启用访问令牌，首次打开可用 http://<ip>:<port>/?token=<AIMONITOR_TOKEN> 完成授权");
      }
    });
  };
  listen(basePort);
}
