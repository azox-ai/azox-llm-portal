import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Resources from "../Resources";
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

const account = {
  id: "acc-1",
  ownerId: 1,
  provider: "anthropic",
  displayName: "Anthropic primary",
  enabled: true,
  credentialStatus: "active",
  accessExpiresAt: null,
  tokenVersion: 2,
};

describe("accounts screen", () => {
  it("lets an owner rename their account and only submits backend-updateable fields", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/accounts" && (!init || init.method !== "PUT")) {
        return Promise.resolve(json([account]));
      }
      return Promise.resolve(json({ ok: true }));
    });

    render(<Resources section="accounts" role="user" />);
    expect(await screen.findByText("Anthropic primary")).toBeTruthy();
    // Non-admins cannot create accounts, but may manage accounts they own.
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit account Anthropic primary" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Provider")).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Anthropic prod" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/accounts/acc-1"), expect.anything()));
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
      displayName: "Anthropic prod",
      enabled: true,
    });
  });

  it("hides the create action from non-admins but shows it to admins", async () => {
    fetchMock.mockResolvedValue(json([]));
    render(<Resources section="accounts" role="admin" />);
    expect(await screen.findByRole("button", { name: "Create account" })).toBeTruthy();
  });
});

describe("connections screen", () => {
  const base = {
    ownerId: 1,
    accountId: "acc-1",
    provider: "anthropic",
    protocol: "messages",
    baseUrl: "https://api.anthropic.com",
    authType: "api_key",
    hasCredential: true,
    enabled: true,
    priority: 0,
    expiresAt: null,
    tokenVersion: 0,
    cooldownUntil: 0,
  };

  it("marks portal-synced connections read-only and never renders a stored secret", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/connections") {
        return Promise.resolve(
          json([
            { ...base, id: "manual", name: "Manual", externalId: null },
            { ...base, id: "synced", name: "Synced", externalId: "portal-42" },
          ]),
        );
      }
      return Promise.resolve(json([account]));
    });

    render(<Resources section="connections" role="admin" />);
    expect(await screen.findByText("Manual")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit connection Manual" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit connection Synced" })).toBeNull();
    expect(screen.getAllByText("Credential set").length).toBe(2);
    expect(screen.queryByDisplayValue(/sk-/)).toBeNull();
  });

  it("requires a credential on create and omits it on edit when left blank", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/connections" && (!init || init.method !== "POST")) {
        return Promise.resolve(json([{ ...base, id: "manual", name: "Manual", externalId: null }]));
      }
      if (url === "/api/accounts") return Promise.resolve(json([account]));
      return Promise.resolve(json({ ok: true }));
    });

    render(<Resources section="connections" role="admin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit connection Manual" }));
    const dialog = await screen.findByRole("dialog");
    const credential = within(dialog).getByLabelText("Credential") as HTMLInputElement;
    expect(credential.value).toBe("");
    expect(credential.type).toBe("password");

    fireEvent.change(within(dialog).getByLabelText("Base URL"), {
      target: { value: "https://proxy.internal/v1?x=1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("query string");

    fireEvent.change(within(dialog).getByLabelText("Base URL"), {
      target: { value: "https://proxy.internal/v1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
        name: "Manual",
        baseUrl: "https://proxy.internal/v1",
        protocol: "messages",
        enabled: true,
        priority: 0,
      });
    });
  });
});

describe("models screen", () => {
  it("creates a model and blocks saving to non-admins", async () => {
    const model = {
      id: "claude-sonnet-4",
      upstreamModel: "claude-sonnet-4-20250514",
      provider: "anthropic",
      protocol: "messages",
      enabled: true,
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/models" && init?.method === "POST") return Promise.resolve(json({ id: model.id }, 201));
      return Promise.resolve(json([model]));
    });

    render(<Resources section="models" role="admin" />);
    expect(await screen.findByText("claude-sonnet-4-20250514")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Model ID"), { target: { value: "fast-model" } });
    fireEvent.change(within(dialog).getByLabelText("Provider"), { target: { value: "anthropic" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create model" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        id: "fast-model",
        provider: "anthropic",
        protocol: "chat",
        enabled: true,
      });
    });
  });

  it("is read-only for regular users", async () => {
    fetchMock.mockResolvedValue(json([]));
    render(<Resources section="models" role="user" />);
    expect(await screen.findByText("Read-only: managing models requires the admin role.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create model" })).toBeNull();
  });
});

describe("combos screen", () => {
  it("reorders models and posts the ordered list", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/combos" && init?.method === "POST") return Promise.resolve(json({ name: "fast" }, 201));
      if (url === "/api/combos") return Promise.resolve(json([{ name: "fast", models: ["a", "b"], enabled: true }]));
      return Promise.resolve(json([]));
    });

    render(<Resources section="combos" role="admin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create combo" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Combo name"), { target: { value: "fast" } });
    fireEvent.change(within(dialog).getByLabelText("Add a model ID"), { target: { value: "a" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add model" }));
    fireEvent.change(within(dialog).getByLabelText("Add a model ID"), { target: { value: "b" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add model" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move b up" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create combo" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        name: "fast",
        models: ["b", "a"],
        enabled: true,
      });
    });
  });
});