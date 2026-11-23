// Same-origin API paths work both with Vite's development proxy and static hosting.
// VITE_API_BASE configures the development proxy target, not a browser origin.
export const API_BASE = "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Token lives only in memory; optionally mirrored into sessionStorage. */
export function setAuthToken(token: string | null, persist = true) {
  authToken = token;
  if (!persist) return;
  try {
    if (token) sessionStorage.setItem("unified_token", token);
    else sessionStorage.removeItem("unified_token");
  } catch {
    /* storage unavailable - memory only */
  }
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  try {
    authToken = sessionStorage.getItem("unified_token");
  } catch {
    authToken = null;
  }
  return authToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** internal: suppress the global 401 handler */
  raw?: boolean;
};

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers,
      body,
      signal: options.signal,
      credentials: "omit",
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "Network error - is the gateway reachable?");
  }
  if (response.status === 401 && !options.raw) {
    // An old in-flight response must not invalidate a newer login.
    if (token && token === getAuthToken()) {
      setAuthToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(401, "Session expired - please sign in again.");
  }
  if (response.status === 204) return undefined as T;
  const textBody = await response.text();
  let parsed: unknown = null;
  if (textBody) {
    try {
      parsed = JSON.parse(textBody);
    } catch {
      parsed = textBody;
    }
  }
  if (!response.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : null) || `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return parsed as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/** Cryptographically strong API key: 32 random bytes, base64url (43 chars). */
export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}