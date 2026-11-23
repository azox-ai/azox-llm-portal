import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { AuthProvider } from "../auth";
import { setAuthToken } from "../api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  sessionStorage.clear();
  window.location.hash = "";
});

afterEach(() => vi.unstubAllGlobals());

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("application smoke", () => {
  it("renders login and surfaces invalid credentials", async () => {
    fetchMock.mockResolvedValue(response({ error: "Not authenticated" }, 401));
    render(
      <AuthProvider>
        <App />
      </AuthProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Unified Gateway" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fetchMock.mockResolvedValue(response({ error: "Invalid username or password" }, 401));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password");
  });

  it("renders overview after login", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/me") return Promise.resolve(response({ error: "Not authenticated" }, 401));
      if (url === "/api/login")
        return Promise.resolve(response({ id: 1, username: "admin", role: "admin", token: "secret", expiresIn: 86400 }));
      if (url === "/api/overview")
        return Promise.resolve(response({ accounts: 2, connections: 3, keys: 4, usage: 5, upstreamEnabled: false, refreshEnabled: false }));
      return Promise.resolve(response([]));
    });
    render(
      <AuthProvider>
        <App />
      </AuthProvider>,
    );
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Gateway overview" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Disabled (parallel-copy)")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
  });
});