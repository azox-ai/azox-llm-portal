import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OtherScreens from "../OtherScreens";
import { setAuthToken } from "../api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken("tok");
  sessionStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("API keys screen", () => {
  it("lists keys and generates a secret once with the shared crypto helper", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/keys" && (!init || init.method !== "POST")) {
        return Promise.resolve(json([{ id: "key-1", ownerId: 1, name: "cli", enabled: true }]));
      }
      if (url === "/api/keys" && init?.method === "POST") {
        return Promise.resolve(json({ id: "key-2" }, 201));
      }
      return Promise.resolve(json([]));
    });

    render(<OtherScreens section="keys" role="admin" />);
    expect(await screen.findByText("cli")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New key name"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate key" }));

    const secret = await screen.findByLabelText("New API key secret");
    const value = (secret as HTMLInputElement).value;
    expect(value).toHaveLength(43);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(post).toBeTruthy();
    const init = post?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ name: "laptop", key: value });

    fireEvent.click(screen.getByRole("button", { name: "I have stored it — hide key" }));
    await waitFor(() => expect(screen.queryByLabelText("New API key secret")).toBeNull());
  });
});

describe("usage screen", () => {
  it("pages client-side at 500 rows and filters by result", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      ownerId: 1,
      keyId: `k-${i}`,
      model: i % 2 === 0 ? "gpt-a" : "gpt-b",
      connectionId: null,
      status: i % 3 === 0 ? 500 : 200,
      createdAt: "2026-11-23 10:00:00",
    }));
    fetchMock.mockResolvedValue(json(rows));

    render(<OtherScreens section="usage" role="user" />);
    expect(await screen.findByText("Page 1 of 3")).toBeTruthy();
    expect(screen.getByText("Showing 1–50 of 120")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3")).toBeTruthy();
    expect(screen.getByText("Showing 51–100 of 120")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "error" } });
    expect(await screen.findByText("Page 1 of 1")).toBeTruthy();
    expect(screen.getByText("Showing 1–40 of 40")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "100" } });
    expect(await screen.findByText("Showing 1–40 of 40")).toBeTruthy();

    // Owners are admin-only; a regular user must not see that column.
    expect(screen.queryByRole("columnheader", { name: "Owner" })).toBeNull();
  });
});

describe("admin-only screens", () => {
  it("blocks imports and users for non-admins without calling the API", () => {
    render(<OtherScreens section="imports" role="user" />);
    expect(screen.getByText("Administrator access required")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads imports for admins and filters locally", async () => {
    fetchMock.mockResolvedValue(
      json([
        { source: "router", table: "accounts", sourceId: "a1" },
        { source: "router", table: "connections", sourceId: "c1" },
      ]),
    );
    render(<OtherScreens section="raw-imports" role="admin" />);
    expect(await screen.findByText("accounts")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "conn" } });
    await waitFor(() => expect(screen.queryByText("accounts")).toBeNull());
    expect(screen.getByText("connections")).toBeTruthy();
  });

  it("creates users through the JSON api helper and validates locally", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/admin/users" && init?.method === "POST") {
        return Promise.resolve(json({ id: 2, username: "alice", role: "user" }, 201));
      }
      return Promise.resolve(json([{ id: 1, username: "admin", role: "admin", disabled: false }]));
    });

    render(<OtherScreens section="users" role="admin" />);
    expect(await screen.findByText("admin")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Initial password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("12 and 256");

    fireEvent.change(screen.getByLabelText("Initial password"), { target: { value: "alice-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText('Created user "alice".')).toBeTruthy();

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      username: "alice",
      password: "alice-password-123",
      role: "user",
    });
  });
});

describe("routing", () => {
  it("falls back to a clear message for unknown sections", () => {
    render(<OtherScreens section="nope" role="admin" />);
    expect(screen.getByRole("heading", { name: "Unknown screen" })).toBeTruthy();
    expect(screen.getByText(/No screen is registered for "nope"/)).toBeTruthy();
  });
});