import { z } from "zod";

/** Error thrown by api(). `status` is the HTTP status code, or undefined for
 * network-level failures (DNS, refused connection, timeout) - callers use it
 * to tell "service unreachable" (no status / 5xx) apart from request errors
 * (4xx). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code = "api_error",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const DEFAULT_API_BASE = "https://api.ragionex.com";

// Plain HTTP would carry the key in cleartext, so it is accepted only for this machine.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("RAGIONEX_API_BASE must be an HTTP or HTTPS URL.", 400, "invalid_api_base");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new ApiError(
      "RAGIONEX_API_BASE must use HTTP or HTTPS without credentials, a query, or a fragment.",
      400,
      "invalid_api_base",
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new ApiError(
      "RAGIONEX_API_BASE must use HTTPS; plain HTTP is accepted only for localhost, 127.0.0.1, and [::1].",
      400,
      "invalid_api_base",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

const accountId = z.string().regex(/^[0-9a-f]{32}$/);
export const vaultId = z.string().regex(/^[0-9a-f]{32}$/);
const keyId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const identitySchema = z.object({
  success: z.literal(true),
  account_id: accountId,
  key: z.object({
    key_id: keyId,
    label: z.string().nullable(),
    // Tolerant reader: a permission name added by the service must not break the connector.
    permissions: z.array(z.string()),
  }).strip(),
  vaults: z.array(z.object({
    vault_id: vaultId,
    vault_name: z.string(),
    access: z.enum(["owner", "shared"]),
    permissions: z.array(z.string()),
    is_default: z.boolean(),
  }).strip()),
}).strip();

export type VaultIdentity = z.infer<typeof identitySchema>;

export const recordId = z.string().min(1).max(14).regex(/^[A-Za-z0-9_]{1,14}$/);

export const writeFields = {
  content: z.string().min(1).describe(
    "English content for one durable topic, written so a reader in a fresh session understands it. Keep related details together; split facts that can change independently into separate saves, one call each.",
  ),
};

export const writePayloadSchema = z.object(writeFields).strict();
export type WritePayload = z.infer<typeof writePayloadSchema>;

// Keep the displayed record shape stable when the service adds fields.
export const recordAckSchema = z.object({
  id: recordId,
  vault_id: vaultId,
  created_at: z.string(),
  updated_at: z.string(),
  // Tolerant reader: an unknown status must not turn an accepted save into a queued one.
  status: z.string(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  created_by: accountId,
  updated_by: accountId,
}).strip();

export const savedRecordSchema = recordAckSchema.extend({
  content: z.string(),
}).strip();

export const trashRecordSchema = savedRecordSchema.extend({
  status: z.literal("trashed"),
  deleted_at: z.string(),
  expires_at: z.string(),
}).strip();

export const versionRecordSchema = savedRecordSchema.extend({
  operation: z.enum(["create", "update", "delete", "restore"]),
  restored_from_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  expires_at: z.string().nullable(),
  is_current: z.boolean(),
}).strip();
