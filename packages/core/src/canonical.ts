const objectProto = Object.prototype;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === objectProto || proto === null;
}

export function canonicalize(value: unknown): string {
  const t = typeof value;
  if (value === null) return "null";
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new TypeError(`cannot canonicalize a value of type ${t}`);
  }
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += canonicalize(value[i]);
    }
    return out + "]";
  }
  if (typeof value !== "object" || !isPlainObject(value)) {
    throw new TypeError("cannot canonicalize a non-plain object");
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (i > 0) out += ",";
    out += JSON.stringify(key) + ":" + canonicalize(obj[key]);
  }
  return out + "}";
}
