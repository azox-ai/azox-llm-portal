import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { useAuth } from "./auth";
import Resources from "./Resources";
import OtherScreens from "./OtherScreens";
import "./styles.css";

type Screen = {
  id: string;
  label: string;
  group: "Gateway" | "Access" | "Admin";
  adminOnly?: boolean;
};

const SCREENS: Screen[] = [
  { id: "overview", label: "Overview", group: "Gateway" },
  { id: "accounts", label: "Accounts", group: "Gateway" },
  { id: "connections", label: "Connections", group: "Gateway" },
  { id: "models", label: "Models", group: "Gateway" },
  { id: "combos", label: "Combos", group: "Gateway" },
  { id: "keys", label: "API Keys", group: "Access" },
  { id: "usage", label: "Usage", group: "Access" },
  { id: "imports", label: "Imports", group: "Access", adminOnly: true },
  { id: "users", label: "Users", group: "Admin", adminOnly: true },
];

function currentScreen(): string {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return raw || "overview";
}

function navigate(id: string) {
  if (window.location.hash === `#/${id}`) return;
  window.location.hash = `#/${id}`;
}

export default function App() {
  const { user, ready, logout, expired, clearExpired } = useAuth();
  const [screen, setScreen] = useState(currentScreen);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setScreen(currentScreen());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id: string) => {
    navigate(id);
    setNavOpen(false);
  }, []);

  useEffect(() => {
    document.title = user ? `Unified Gateway - ${SCREENS.find((s) => s.id === screen)?.label ?? "Overview"}` : "Unified Gateway";
  }, [screen, user]);

  if (!ready) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> Loading session...
      </div>
    );
  }

  if (!user) {
    return <Login expired={expired} onDismissExpired={clearExpired} />;
  }

  const visible = SCREENS.filter((s) => !s.adminOnly || user.role === "admin");
  const active = visible.find((s) => s.id === screen) ?? visible[0];
  const groups: Array<Screen["group"]> = ["Gateway", "Access", "Admin"];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>
        Skip to content
      </a>
      <aside id="primary-nav" className={`sidebar${navOpen ? " open" : ""}`} aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            UG
          </span>
          <div>
            <strong>Unified Gateway</strong>
            <span className="brand-sub">Control plane</span>
          </div>
        </div>
        <nav>
          {groups.map((group) => {
            const items = visible.filter((s) => s.group === group);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={group}>
                <span className="nav-group-label">{group}</span>
                {items.map((item) => (
                  <a
                    key={item.id}
                    href={`#/${item.id}`}
                    className={`nav-link${active.id === item.id ? " active" : ""}`}
                    aria-current={active.id === item.id ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      go(item.id);
                    }}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          <button
            type="button"
            className="button ghost menu-toggle"
            aria-expanded={navOpen}
            aria-controls="primary-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            Menu
          </button>
          <h1 className="page-title">{active.label}</h1>
          <div className="account-chip">
            <span className={`badge role-${user.role}`}>{user.role}</span>
            <span className="account-name">{user.username}</span>
            <button type="button" className="button secondary small" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main-content" className="main" tabIndex={-1}>
          {active.id === "overview" && <Overview onNavigate={go} role={user.role} />}
          {["accounts", "connections", "models", "combos"].includes(active.id) && (
            <Resources key={active.id} section={active.id} role={user.role} />
          )}
          {["keys", "usage", "imports", "users"].includes(active.id) && (
            <OtherScreens key={active.id} section={active.id} role={user.role} />
          )}
        </main>
      </div>
    </div>
  );
}

function Login({ expired, onDismissExpired }: { expired: boolean; onDismissExpired: () => void }) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <main className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            UG
          </span>
          <div>
            <h1>Unified Gateway</h1>
            <p className="muted">Sign in to manage routing, models and keys.</p>
          </div>
        </div>
        {expired && (
          <div className="banner warning" role="status">
            Your session expired. Please sign in again.
          </div>
        )}
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span>Username</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              required
              maxLength={64}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                onDismissExpired();
              }}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="button primary block" disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p className="muted small-text">
          Your session is stored in this browser tab and cleared when you sign out.
        </p>
      </main>
    </div>
  );
}

type OverviewData = {
  accounts: number;
  connections: number;
  keys: number;
  usage: number;
  upstreamEnabled: boolean;
  refreshEnabled: boolean;
};

const CARDS: Array<{ key: keyof OverviewData; label: string; screen: string; hint: string }> = [
  { key: "accounts", label: "Accounts", screen: "accounts", hint: "Provider identities" },
  { key: "connections", label: "Connections", screen: "connections", hint: "Upstream endpoints" },
  { key: "keys", label: "API keys", screen: "keys", hint: "Gateway credentials" },
  { key: "usage", label: "Usage events", screen: "usage", hint: "Recorded requests" },
];

function Overview({ onNavigate, role }: { onNavigate: (id: string) => void; role: string }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<OverviewData>("/api/overview", { signal }));
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h2>Gateway overview</h2>
          <p className="muted">
            {role === "admin"
              ? "You have admin visibility across every owner's resources."
              : "Counts reflect the resources you own."}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {!error && !data && loading && <SkeletonCards />}
      {data && (
        <>
          <div className="stat-grid">
            {CARDS.map((card) => (
              <button type="button" key={card.key} className="stat" onClick={() => onNavigate(card.screen)}>
                <span className="stat-label">{card.label}</span>
                <span className="stat-value">{data[card.key]}</span>
                <span className="stat-hint">{card.hint}</span>
              </button>
            ))}
          </div>
          <div className="card">
            <h3>Runtime mode</h3>
            <dl className="mode-list">
              <div>
                <dt>Upstream execution</dt>
                <dd>
                  <span className={`badge ${data.upstreamEnabled ? "good" : "neutral"}`}>
                    {data.upstreamEnabled ? "Enabled" : "Disabled (parallel-copy)"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Background refresh</dt>
                <dd>
                  <span className="badge neutral">{data.refreshEnabled ? "Enabled" : "Not configured"}</span>
                </dd>
              </div>
            </dl>
          </div>
        </>
      )}
      {!data && !loading && !error && <div className="empty">No overview data available.</div>}
    </section>
  );
}

function SkeletonCards() {
  return (
    <div className="stat-grid" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div className="stat skeleton" key={i}>
          <span className="stat-label">&nbsp;</span>
          <span className="stat-value">&nbsp;</span>
        </div>
      ))}
    </div>
  );
}