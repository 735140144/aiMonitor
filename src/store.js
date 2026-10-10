import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { maskSecret, normalizeBaseUrl } from "./util.js";

export const ACCOUNT_TYPES = ["newapi", "sub2api", "opencode", "custom"];

export const TYPE_LABELS = {
  newapi: "New API",
  sub2api: "Sub2API",
  opencode: "OpenCode Go",
  custom: "自定义",
};

export const DEFAULT_BASE_URLS = {
  opencode: "https://opencode.ai",
};

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function sanitizeOptions(type, input) {
  const options = cleanObject(input);
  if (type === "newapi") {
    return {
      quotaPerUnit: options.quotaPerUnit ?? "",
      currency: cleanString(options.currency),
    };
  }
  if (type === "sub2api") {
    return {
      // apikey: Sub2API 网关密钥 → GET /v1/usage（推荐）
      // token / password: 面板登录态 → GET /api/v1/*
      authMode: ["apikey", "token", "password"].includes(options.authMode) ? options.authMode : "apikey",
      email: cleanString(options.email),
    };
  }
  if (type === "custom") {
    return {
      method: options.method === "POST" ? "POST" : "GET",
      path: cleanString(options.path),
      authStyle: ["bearer", "x-api-key", "query", "none"].includes(options.authStyle)
        ? options.authStyle
        : "bearer",
      headers: cleanString(options.headers),
      body: cleanString(options.body),
      mapping: cleanString(options.mapping),
    };
  }
  return {};
}

export function validateAccountInput(input, { partial = false, existing = null } = {}) {
  const source = cleanObject(input);
  const account = existing ? { ...existing } : {};

  if (source.type !== undefined || !existing) {
    const type = cleanString(source.type);
    if (!ACCOUNT_TYPES.includes(type)) {
      throw new ValidationError(`账户类型必须是 ${ACCOUNT_TYPES.join(" / ")} 之一`);
    }
    account.type = type;
  }

  if (source.name !== undefined || !existing) {
    const name = cleanString(source.name) || TYPE_LABELS[account.type];
    account.name = name.slice(0, 60);
  }

  if (source.baseUrl !== undefined || !existing) {
    const baseUrl = normalizeBaseUrl(source.baseUrl) || DEFAULT_BASE_URLS[account.type] || "";
    if (account.type !== "opencode" && baseUrl === "") {
      throw new ValidationError("请填写服务地址");
    }
    if (baseUrl !== "" && !/^https?:\/\//i.test(baseUrl)) {
      throw new ValidationError("服务地址需要以 http:// 或 https:// 开头");
    }
    account.baseUrl = baseUrl;
  }

  if (source.key !== undefined) {
    const key = cleanString(source.key);
    if (key !== "") account.key = key;
    else if (!existing) account.key = "";
  } else if (!existing) {
    account.key = "";
  }

  if (source.options !== undefined || !existing) {
    account.options = sanitizeOptions(account.type, source.options ?? existing?.options ?? {});
  }

  if (source.group !== undefined || !existing) {
    account.group = cleanString(source.group).slice(0, 40);
  }

  if (source.thresholds !== undefined) {
    const input = cleanObject(source.thresholds);
    const thresholds = {};
    const windowPercent = Number(input.windowPercent);
    const balanceAmount = Number(input.balanceAmount);
    if (input.windowPercent !== undefined && input.windowPercent !== "" && Number.isFinite(windowPercent)) {
      thresholds.windowPercent = Math.min(100, Math.max(0, windowPercent));
    }
    if (input.balanceAmount !== undefined && input.balanceAmount !== "" && Number.isFinite(balanceAmount)) {
      thresholds.balanceAmount = Math.max(0, balanceAmount);
    }
    account.thresholds = thresholds;
  } else if (!existing) {
    account.thresholds = {};
  }

  if (!partial) {
    const needsKey = account.type !== "custom" || (account.options?.authStyle ?? "bearer") !== "none";
    if (needsKey && !account.key) {
      throw new ValidationError(account.type === "sub2api" && account.options?.authMode === "password"
        ? "请填写登录密码"
        : "请填写密钥");
    }
    if (account.type === "sub2api" && account.options?.authMode === "password" && !account.options.email) {
      throw new ValidationError("请填写登录邮箱");
    }
    if (account.type === "custom" && !account.baseUrl) {
      throw new ValidationError("请填写自定义接口地址");
    }
  }

  return account;
}

export function toPublicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    baseUrl: account.baseUrl,
    options: account.options ?? {},
    group: account.group ?? "",
    thresholds: account.thresholds ?? {},
    hasKey: Boolean(account.key),
    keyHint: account.key ? maskSecret(account.key) : "",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export class AccountStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.accounts = [];
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.accounts;
      this.accounts = (Array.isArray(list) ? list : []).filter(
        (item) => item && typeof item.id === "string" && ACCOUNT_TYPES.includes(item.type),
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] 无法读取 ${this.filePath}: ${error.message}`);
      }
      this.accounts = [];
    }
    return this;
  }

  persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: 1, accounts: this.accounts }, null, 2);
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  list() {
    return this.accounts;
  }

  get(id) {
    return this.accounts.find((account) => account.id === id) ?? null;
  }

  create(input) {
    const account = validateAccountInput(input);
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      ...account,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.push(record);
    this.persist();
    return record;
  }

  update(id, input) {
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) return null;
    const updated = validateAccountInput(input, { partial: true, existing: this.accounts[index] });
    const record = { ...updated, id, updatedAt: new Date().toISOString() };
    this.accounts[index] = record;
    this.persist();
    return record;
  }

  remove(id) {
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    this.persist();
    return true;
  }
}
