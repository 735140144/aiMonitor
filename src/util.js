export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 支持 a.b[0].c 形式的路径读取
export function dotGet(object, path) {
  if (object == null || typeof path !== "string" || path === "") return undefined;
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  let cursor = object;
  for (const token of tokens) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[token];
  }
  return cursor;
}

// 映射路径优先按所选根节点解析，失败后回退到完整响应
export function pathGet(root, full, path) {
  if (!path) return undefined;
  const local = dotGet(root, path);
  if (local !== undefined) return local;
  return dotGet(full, path);
}

export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9eE+.-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function firstNumber(...values) {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0") return false;
  }
  return null;
}

export function asDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const normalized = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function maskSecret(secret) {
  if (typeof secret !== "string" || secret === "") return "";
  const visible = secret.length <= 10 ? secret.slice(0, 2) : secret.slice(0, 5);
  return `${visible}${"*".repeat(Math.max(4, Math.min(12, secret.length - visible.length)))}`;
}

export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  return raw.trim().replace(/\/+$/, "");
}

export function percentOf(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return (used / limit) * 100;
}
