import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  errorMessage,
  generateApiKey,
  getAuthToken,
  setAuthToken,
  setUnauthorizedHandler,
} from "../api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  setUnauthorizedHandler(null);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth token storage", () => {
  it("keeps the token in memory and mirrors it to sessionStorage", () => {
    setAuthToken("abc123");
    expect(getAuthToken()).toBe("abc123");
    expect(sessionStorage.getItem("unified_token")).toBe("abc123");
  });

  it("clears both memory and sessionStorage on logout", () => {
    setAuthToken("abc123");
    setAuthToken(null);
    expect(getAuthToken()).toBeNull();
    expect(sessionStorage.getItem("unified_token")).toBeNull();
  });
});

describe("api client", () => {
  it("sends bearer auth and parses JSON", async () => {
    setAuthToken("tok");
    fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));
    await expect(api("/api/me")).resolves.toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("sends JSON bodies for writes", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api("/api/login", { method: "POST", body: { username: "a" }, raw: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ username: "a" }));
  });

  it("clears the token and fires the 401 handler", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setAuthToken("stale");
    fetchMock.mockResolvedValue(jsonResponse({ error: "Not authenticated" }, 401));
    await expect(api("/api/overview")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledOnce();
    expect(getAuthToken()).toBeNull();
  });

  it("does not clear a newer session when an older request returns 401", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setAuthToken("old-token");
    const pending = api("/api/overview").catch((error: unknown) => error);
    setAuthToken("new-token");
    resolve(jsonResponse({ error: "Not authenticated" }, 401));
    await pending;
    expect(getAuthToken()).toBe("new-token");
    expect(handler).not.toHaveBeenCalled();
  });

  it("surfaces backend error messages", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Invalid user" }, 400));
    await expect(api("/api/admin/users", { method: "POST", body: {} })).rejects.toThrow("Invalid user");
  });

  it("handles empty 204 responses", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api("/api/connections/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("reports network failures without leaking internals", async () => {
    fetchMock.mockRejectedValue(new TypeError("failed to fetch"));
    const error = await api("/api/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect(errorMessage(error)).toMatch(/Network error/);
  });
});

describe("generateApiKey", () => {
  it("produces a 43-char base64url secret with no padding", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces distinct values", () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
    expect(keys.size).toBe(20);
  });
});