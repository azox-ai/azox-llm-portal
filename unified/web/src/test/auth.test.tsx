import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../auth";
import { getAuthToken, setAuthToken } from "../api";

const fetchMock = vi.fn();
let latest: ReturnType<typeof useAuth> | null = null;

function Probe() {
  const auth = useAuth();
  latest = auth;
  return (
    <div>
      <span data-testid="ready">{String(auth.ready)}</span>
      <span data-testid="user">{auth.user ? `${auth.user.username}:${auth.user.role}` : "none"}</span>
      <span data-testid="expired">{String(auth.expired)}</span>
    </div>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  sessionStorage.clear();
  latest = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth store", () => {
  it("validates a stored token against /api/me", async () => {
    setAuthToken("tok");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 1, username: "admin", role: "admin" }), { status: 200 }),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    expect(screen.getByTestId("user").textContent).toBe("admin:admin");
    latest = null;
  });

  it("clears a rejected token", async () => {
    setAuthToken("stale");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 }));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(getAuthToken()).toBeNull();
  });

  it("login stores the token, exposes the user and logout clears it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 }));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    expect(latest).not.toBeNull();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 2, username: "ops", role: "user", token: "fresh-token", expiresIn: 86400 }), {
        status: 200,
      }),
    );
    await act(async () => {
      await latest?.login("ops", "password123456");
    });
    expect(screen.getByTestId("user").textContent).toBe("ops:user");
    expect(getAuthToken()).toBe("fresh-token");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await act(async () => {
      await latest?.logout();
    });
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(getAuthToken()).toBeNull();
  });
});