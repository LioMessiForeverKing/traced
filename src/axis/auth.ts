import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_TTL_MS = 15 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function credentialsMatch(
  user: string,
  key: string,
  expectedUser: string,
  expectedKey: string,
): boolean {
  const userOk = timingSafeEqual(digest(user), digest(expectedUser));
  const keyOk = timingSafeEqual(digest(key), digest(expectedKey));
  return userOk && keyOk;
}

export function mintToken(secret: string, now: number): string {
  const expires = String(now + TOKEN_TTL_MS);
  return `${expires}.${sign(expires, secret)}`;
}

export function verifyToken(token: string | undefined, secret: string, now: number): boolean {
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  if (Number(expires) <= now) return false;
  const expected = sign(expires, secret);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
