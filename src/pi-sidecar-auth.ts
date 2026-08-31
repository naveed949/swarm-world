import { timingSafeEqual } from "node:crypto";

export function requireSidecarToken(token: string | undefined): string {
  if (!token || token.length < 32)
    throw new Error("Pi sidecar bearer token is missing or too short");
  return token;
}

export function sidecarAuthorization(token: string): string {
  return `Bearer ${requireSidecarToken(token)}`;
}

export function isAuthorizedSidecarRequest(
  authorization: string | undefined,
  token: string,
): boolean {
  if (!authorization) return false;
  const expected = Buffer.from(sidecarAuthorization(token));
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
