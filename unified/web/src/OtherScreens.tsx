import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, generateApiKey } from './api';
import './other.css';

/**
 * Secondary screens for the unified portal: API keys, usage, raw imports and
 * admin user management.
 *
 * The component is intentionally self-contained. It only depends on the shared
 * `api(path, options?)` helper, which parses JSON and throws an Error for
 * non-2xx responses. The server (unified/src/lib.rs) never returns an API key
 * secret, so the client generates one with `generateApiKey()` (32 random bytes
 * from the Web Crypto CSPRNG, base64url), submits it once, and keeps it in
 * component state only long enough for the operator to copy it.
 */

const MAX_USAGE_ROWS = 500;
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 250] as const;

interface ApiKeyRow {
  id: string;
  ownerId: number;
  name: string;
  enabled: boolean;
}

interface UsageRow {
  id: number;
  ownerId: number;
  keyId: string | null;
  model: string;
  connectionId: string | null;
  status: number;
  createdAt: string;
}

interface ImportRow {
  source: string;
  table: string;
  sourceId: string;
}

interface AdminUserRow {
  id: number;
  username: string;
  role: string;
  disabled: boolean;
}

type StatusFilter = 'all' | 'success' | 'error';

export default function OtherScreens({
  section,
  role,
}: {
  section: string;
  role: string;
}) {
  const normalized = normalizeSection(section);
  const isAdmin = normalizeRole(role) === 'admin';

  switch (normalized) {
    case 'keys':
      return <ApiKeysScreen isAdmin={isAdmin} />;
    case 'usage':
      return <UsageScreen isAdmin={isAdmin} />;
    case 'imports':
      return <ImportsScreen isAdmin={isAdmin} />;
    case 'users':
      return <UsersScreen isAdmin={isAdmin} />;
    default:
      return <UnknownSection section={section} />;
  }
}

function normalizeSection(section: string): string {
  const compact = section.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    key: 'keys',
    keys: 'keys',
    apikey: 'keys',
    apikeys: 'keys',
    usage: 'usage',
    usages: 'usage',
    import: 'imports',
    imports: 'imports',
    rawimports: 'imports',
    user: 'users',
    users: 'users',
    adminuser: 'users',
    adminusers: 'users',
  };
  return aliases[compact] ?? compact;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// API key generation
// ---------------------------------------------------------------------------

async function copyText(value: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the synchronous selection-based copy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      document.body.removeChild(area);
    }
    return copied;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers and primitives
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return 'Request failed. Please try again.';
}

function normalizeList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['items', 'data', 'rows']) {
      if (Array.isArray(record[key])) {
        return record[key] as T[];
      }
    }
  }
  return [];
}

function useResource<T>(path: string, enabled: boolean) {
  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!enabled) {
      setItems(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = await api(path);
      if (mounted.current) {
        setItems(normalizeList<T>(payload));
      }
    } catch (caught) {
      if (mounted.current) {
        setError(errorMessage(caught));
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    items: items ?? [],
    loaded: items !== null,
    loading,
    error,
    reload,
    setItems,
  };
}

function shortId(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return value.length > 14
    ? `${value.slice(0, 8)}…${value.slice(-4)}`
    : value;
}

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(sqliteTimestamp);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isSuccessStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 200 && status < 300;
}

function ScreenHeading({
  id,
  title,
  description,
  actions,
}: {
  id: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="os-head">
      <div className="os-head-copy">
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="os-head-actions">{actions}</div> : null}
    </header>
  );
}

function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      className={`os-alert os-alert--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="os-loading" role="status" aria-live="polite">
      <span className="os-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="os-empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'ok' | 'error';
}) {
  return (
    <div className={`os-stat os-stat--${tone}`}>
      <span className="os-stat-label">{label}</span>
      <span className="os-stat-value">{value}</span>
    </div>
  );
}

function Badge({
  tone,
  children,
  title,
}: {
  tone: 'ok' | 'error' | 'neutral' | 'warn';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`os-badge os-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

function AdminOnly({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <section className="other-screens" aria-labelledby={id}>
      <ScreenHeading id={id} title={title} description={description} />
      <div className="os-card os-gate" role="note">
        <h3>Administrator access required</h3>
        <p>
          This screen is only available to administrators. Ask a workspace
          administrator if you need access.
        </p>
      </div>
    </section>
  );
}

function UnknownSection({ section }: { section: string }) {
  return (
    <section className="other-screens" aria-labelledby="os-unknown-title">
      <ScreenHeading
        id="os-unknown-title"
        title="Unknown screen"
        description="The requested section is not part of this portal."
      />
      <EmptyState title="Nothing to show">
        {`No screen is registered for "${section}".`}
      </EmptyState>
    </section>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysScreen({ isAdmin }: { isAdmin: boolean }) {
  const {
    items: keys,
    loading,
    error,
    reload,
    setItems,
  } = useResource<ApiKeyRow>('/api/keys', true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(
    null,
  );
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const secretRef = useRef<HTMLInputElement | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Give the key a name so you can identify it later.');
      return;
    }
    if (trimmed.length > 64) {
      setFormError('Key names must be 64 characters or fewer.');
      return;
    }
    if (revealed) {
      setFormError('Store and hide the current secret before generating another key.');
      return;
    }

    let secret: string;
    try {
      secret = generateApiKey();
    } catch (caught) {
      setFormError(errorMessage(caught));
      return;
    }
    if (secret.length < 24 || secret.length > 512) {
      setFormError('Generated key length is outside the supported range.');
      return;
    }

    setCreating(true);
    setFormError(null);
    setActionError(null);
    setCopyState('idle');
    try {
      await api('/api/keys', {
        method: 'POST',
        body: { name: trimmed, key: secret },
      });
      setRevealed({ name: trimmed, secret });
      setName('');
      await reload();
    } catch (caught) {
      // A network error can be ambiguous: the server may have stored the hash.
      // Do not reveal a key unless the create response was successful.
      setFormError(`${errorMessage(caught)} If the response was lost, check the key list and delete any unusable key before retrying.`);
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!revealed) {
      return;
    }
    const ok = await copyText(revealed.secret);
    setCopyState(ok ? 'ok' : 'fail');
    if (ok && secretRef.current) {
      secretRef.current.focus();
      secretRef.current.select();
    }
  }

  function hideSecret() {
    setRevealed(null);
    setCopyState('idle');
  }

  async function renameKey(key: ApiKeyRow) {
    const trimmed = editName.trim();
    if (!trimmed) {
      setActionError('Key name cannot be empty.');
      return;
    }
    setBusyId(key.id);
    setActionError(null);
    try {
      await api(`/api/keys/${encodeURIComponent(key.id)}`, {
        method: 'PUT',
        body: { name: trimmed },
      });
      setItems((current) =>
        (current ?? []).map((row) =>
          row.id === key.id ? { ...row, name: trimmed } : row,
        ),
      );
      setEditingId(null);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleKey(key: ApiKeyRow) {
    setBusyId(key.id);
    setActionError(null);
    try {
      await api(`/api/keys/${encodeURIComponent(key.id)}`, {
        method: 'PUT',
        body: { enabled: !key.enabled },
      });
      setItems((current) =>
        (current ?? []).map((row) =>
          row.id === key.id ? { ...row, enabled: !key.enabled } : row,
        ),
      );
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteKey(key: ApiKeyRow) {
    setBusyId(key.id);
    setActionError(null);
    try {
      await api(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      setItems((current) => (current ?? []).filter((row) => row.id !== key.id));
      setConfirmDelete(null);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="other-screens" aria-labelledby="os-keys-title">
      <ScreenHeading
        id="os-keys-title"
        title="API keys"
        description="Keys authenticate the /v1 gateway endpoints. Secrets are generated in this browser with a cryptographically secure random generator and are only shown once."
        actions={
          <button
            type="button"
            className="os-btn os-btn--ghost"
            onClick={() => void reload()}
            disabled={loading}
          >
            Refresh
          </button>
        }
      />

      {revealed ? (
        <div className="os-reveal" role="region" aria-label="New API key">
          <div className="os-reveal-head">
            <h3>Copy this key now</h3>
            <Badge tone="warn">Shown once</Badge>
          </div>
          <p>
            The secret for <strong>{revealed.name}</strong> cannot be retrieved
            again. Store it in a password manager or secret store before hiding
            it.
          </p>
          <div className="os-secret-row">
            <input
              ref={secretRef}
              className="os-input os-secret-input"
              value={revealed.secret}
              readOnly
              spellCheck={false}
              autoComplete="off"
              aria-label="New API key secret"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="os-btn os-btn--primary"
              onClick={() => void handleCopy()}
            >
              {copyState === 'ok' ? 'Copied' : 'Copy key'}
            </button>
          </div>
          {copyState === 'fail' ? (
            <p className="os-inline-error" role="alert">
              Could not copy automatically. Select the value above and copy it
              manually.
            </p>
          ) : null}
          <div className="os-reveal-actions">
            <button
              type="button"
              className="os-btn os-btn--ghost"
              onClick={hideSecret}
            >
              I have stored it — hide key
            </button>
          </div>
        </div>
      ) : null}

      <form className="os-card os-form" onSubmit={handleCreate} noValidate>
        <div className="os-field">
          <label htmlFor="os-key-name">New key name</label>
          <input
            id="os-key-name"
            className="os-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. laptop-cli"
            maxLength={64}
            autoComplete="off"
            disabled={creating}
          />
        </div>
        <button
          type="submit"
          className="os-btn os-btn--primary"
          disabled={creating || revealed !== null}
        >
          {creating ? 'Creating…' : 'Generate key'}
        </button>
      </form>

      {revealed ? (
        <p className="os-footnote">Store and hide the current secret before generating another key.</p>
      ) : null}
      {formError ? <Alert>{formError}</Alert> : null}
      {actionError ? <Alert>{actionError}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      <div className="os-card">
        <div className="os-card-head">
          <h3>Keys</h3>
          <span className="os-count">{keys.length}</span>
        </div>

        {loading && keys.length === 0 ? (
          <Loading label="Loading API keys…" />
        ) : keys.length === 0 ? (
          <EmptyState title="No API keys yet">
            Generate a key above, then send it as a Bearer token to the gateway.
          </EmptyState>
        ) : (
          <div className="os-table-wrap">
            <table className="os-table">
              <caption className="os-sr-only">API keys</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key ID</th>
                  {isAdmin ? <th scope="col">Owner</th> : null}
                  <th scope="col">Status</th>
                  <th scope="col" className="os-col-actions">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const busy = busyId === key.id;
                  return (
                    <tr key={key.id}>
                      <td className="os-strong">
                        {editingId === key.id ? (
                          <input
                            className="os-input"
                            aria-label={`Name for ${key.name}`}
                            value={editName}
                            maxLength={64}
                            onChange={(event) => setEditName(event.target.value)}
                            disabled={busy}
                          />
                        ) : key.name}
                      </td>
                      <td className="os-mono" title={key.id}>
                        {shortId(key.id)}
                      </td>
                      {isAdmin ? (
                        <td className="os-mono">{key.ownerId}</td>
                      ) : null}
                      <td>
                        <Badge tone={key.enabled ? 'ok' : 'neutral'}>
                          {key.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </td>
                      <td>
                        <div className="os-row-actions">
                          {editingId === key.id ? (
                            <>
                              <button
                                type="button"
                                className="os-btn os-btn--sm os-btn--ghost"
                                onClick={() => void renameKey(key)}
                                disabled={busy}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="os-btn os-btn--sm os-btn--ghost"
                                onClick={() => setEditingId(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="os-btn os-btn--sm os-btn--ghost"
                              onClick={() => { setEditingId(key.id); setEditName(key.name); }}
                              disabled={busy}
                            >
                              Rename
                            </button>
                          )}
                          <button
                            type="button"
                            className="os-btn os-btn--sm os-btn--ghost"
                            onClick={() => void toggleKey(key)}
                            disabled={busy}
                          >
                            {busy ? 'Working…' : key.enabled ? 'Disable' : 'Enable'}
                          </button>
                          {confirmDelete === key.id ? (
                            <span className="os-confirm">
                              <span>Delete?</span>
                              <button
                                type="button"
                                className="os-btn os-btn--sm os-btn--danger"
                                onClick={() => void deleteKey(key)}
                                disabled={busy}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                className="os-btn os-btn--sm os-btn--ghost"
                                onClick={() => setConfirmDelete(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="os-btn os-btn--sm os-btn--ghost os-btn--danger-text"
                              onClick={() => setConfirmDelete(key.id)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function UsageScreen({ isAdmin }: { isAdmin: boolean }) {
  const { items, loading, error, reload } = useResource<UsageRow>(
    '/api/usage',
    true,
  );
  const [model, setModel] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);

  // The server returns at most 500 rows; keep pagination entirely client-side.
  const capped = useMemo(() => items.slice(0, MAX_USAGE_ROWS), [items]);

  const models = useMemo(
    () => Array.from(new Set(capped.map((row) => row.model))).sort(),
    [capped],
  );

  const filtered = useMemo(
    () =>
      capped.filter((row) => {
        if (model !== 'all' && row.model !== model) {
          return false;
        }
        if (status === 'all') {
          return true;
        }
        return status === 'success'
          ? isSuccessStatus(row.status)
          : !isSuccessStatus(row.status);
      }),
    [capped, model, status],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const rows = filtered.slice(start, start + pageSize);

  const successCount = capped.filter((row) => isSuccessStatus(row.status)).length;
  const errorCount = capped.length - successCount;

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage);
    }
  }, [page, currentPage]);

  useEffect(() => {
    setPage(0);
  }, [model, status, pageSize]);

  const rangeStart = filtered.length === 0 ? 0 : start + 1;
  const rangeEnd = Math.min(start + pageSize, filtered.length);

  return (
    <section className="other-screens" aria-labelledby="os-usage-title">
      <ScreenHeading
        id="os-usage-title"
        title="Usage"
        description="Request history for the gateway. The API returns the 500 most recent records; filtering and paging happen in this browser."
        actions={
          <button
            type="button"
            className="os-btn os-btn--ghost"
            onClick={() => void reload()}
            disabled={loading}
          >
            Refresh
          </button>
        }
      />

      <div className="os-stats">
        <StatTile label="Loaded rows" value={capped.length} />
        <StatTile label="Successful" value={successCount} tone="ok" />
        <StatTile label="Failed" value={errorCount} tone="error" />
        <StatTile label="Models" value={models.length} />
      </div>

      <div className="os-card os-toolbar">
        <div className="os-field">
          <label htmlFor="os-usage-model">Model</label>
          <select
            id="os-usage-model"
            className="os-input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="all">All models</option>
            {models.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="os-field">
          <label htmlFor="os-usage-status">Result</label>
          <select
            id="os-usage-status"
            className="os-input"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            <option value="all">All results</option>
            <option value="success">Successful (2xx)</option>
            <option value="error">Failed</option>
          </select>
        </div>
        <div className="os-field os-field--narrow">
          <label htmlFor="os-usage-page-size">Rows per page</label>
          <select
            id="os-usage-page-size"
            className="os-input"
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <div className="os-card">
        <div className="os-card-head">
          <h3>Requests</h3>
          <span className="os-count">{filtered.length}</span>
        </div>

        {loading && capped.length === 0 ? (
          <Loading label="Loading usage…" />
        ) : filtered.length === 0 ? (
          <EmptyState title="No usage records">
            {capped.length === 0
              ? 'Gateway requests will appear here once traffic is recorded.'
              : 'No records match the current filters.'}
          </EmptyState>
        ) : (
          <>
            <div className="os-table-wrap">
              <table className="os-table">
                <caption className="os-sr-only">Gateway usage records</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Model</th>
                    <th scope="col">Status</th>
                    <th scope="col">Key ID</th>
                    <th scope="col">Connection</th>
                    {isAdmin ? <th scope="col">Owner</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const success = isSuccessStatus(row.status);
                    return (
                      <tr key={row.id}>
                        <td className="os-nowrap">{formatTime(row.createdAt)}</td>
                        <td className="os-strong">{row.model}</td>
                        <td>
                          <Badge
                            tone={success ? 'ok' : 'error'}
                            title={`HTTP status ${row.status}`}
                          >
                            {Number.isFinite(row.status) ? row.status : '—'}
                          </Badge>
                        </td>
                        <td className="os-mono" title={row.keyId ?? undefined}>
                          {shortId(row.keyId)}
                        </td>
                        <td
                          className="os-mono"
                          title={row.connectionId ?? undefined}
                        >
                          {shortId(row.connectionId)}
                        </td>
                        {isAdmin ? (
                          <td className="os-mono">{row.ownerId}</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="os-pagination">
              <span className="os-pagination-info">
                Showing {rangeStart}–{rangeEnd} of {filtered.length}
              </span>
              <span className="os-pagination-controls">
                <button
                  type="button"
                  className="os-btn os-btn--sm os-btn--ghost"
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  disabled={currentPage === 0}
                >
                  Previous
                </button>
                <span className="os-pagination-page">
                  Page {currentPage + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  className="os-btn os-btn--sm os-btn--ghost"
                  onClick={() =>
                    setPage((value) => Math.min(pageCount - 1, value + 1))
                  }
                  disabled={currentPage >= pageCount - 1}
                >
                  Next
                </button>
              </span>
            </div>
          </>
        )}
      </div>

      <p className="os-footnote">
        Showing at most {MAX_USAGE_ROWS} of the most recent records. Older usage
        stays in the server database but is not loaded by this screen.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Raw imports (admin only)
// ---------------------------------------------------------------------------

function ImportsScreen({ isAdmin }: { isAdmin: boolean }) {
  const { items, loading, error, reload } = useResource<ImportRow>(
    '/api/imports',
    isAdmin,
  );
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((row) =>
      [row.source, row.table, row.sourceId].some((value) =>
        String(value ?? '').toLowerCase().includes(needle),
      ),
    );
  }, [items, query]);

  const sources = useMemo(
    () => new Set(rows.map((row) => row.source)).size,
    [rows],
  );
  const tables = useMemo(
    () => new Set(rows.map((row) => `${row.source}\u0000${row.table}`)).size,
    [rows],
  );

  if (!isAdmin) {
    return (
      <AdminOnly
        id="os-imports-title"
        title="Imports"
        description="Read-only view of raw rows imported from upstream routers."
      />
    );
  }

  return (
    <section className="other-screens" aria-labelledby="os-imports-title">
      <ScreenHeading
        id="os-imports-title"
        title="Imports"
        description="Read-only inventory of raw source rows. The API does not expose import-run history or row contents. This screen is restricted to administrators."
        actions={
          <button
            type="button"
            className="os-btn os-btn--ghost"
            onClick={() => void reload()}
            disabled={loading}
          >
            Refresh
          </button>
        }
      />

      <div className="os-stats">
        <StatTile label="Rows" value={rows.length} />
        <StatTile label="Sources" value={sources} />
        <StatTile label="Tables" value={tables} />
      </div>

      <div className="os-card os-toolbar">
        <div className="os-field">
          <label htmlFor="os-imports-search">Filter</label>
          <input
            id="os-imports-search"
            className="os-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by source, table or source ID"
            autoComplete="off"
          />
        </div>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <div className="os-card">
        <div className="os-card-head">
          <h3>Imported rows</h3>
          <span className="os-count">{rows.length}</span>
        </div>

        {loading && items.length === 0 ? (
          <Loading label="Loading imports…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No imported rows">
            {items.length === 0
              ? 'Raw imports will appear after a router sync writes them.'
              : 'No rows match the current filter.'}
          </EmptyState>
        ) : (
          <div className="os-table-wrap">
            <table className="os-table">
              <caption className="os-sr-only">Raw imported rows</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Table</th>
                  <th scope="col">Source ID</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.source}\u0000${row.table}\u0000${row.sourceId}`}
                  >
                    <td className="os-strong">{row.source}</td>
                    <td className="os-mono">{row.table}</td>
                    <td className="os-mono" title={row.sourceId}>
                      {row.sourceId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="os-footnote">
        The server returns at most {MAX_USAGE_ROWS} imported rows.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------

function UsersScreen({ isAdmin }: { isAdmin: boolean }) {
  const { items: users, loading, error, reload } = useResource<AdminUserRow>(
    '/api/admin/users',
    isAdmin,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const admins = users.filter((row) => row.role === 'admin').length;
  const disabled = users.filter((row) => row.disabled).length;

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = username.trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(trimmed)) {
      setFormError(
        'Usernames must be 3–64 characters using letters, digits, dot, underscore or hyphen.',
      );
      return;
    }
    if (password.length < 12 || password.length > 256) {
      setFormError('Passwords must be between 12 and 256 characters.');
      return;
    }

    setCreating(true);
    setFormError(null);
    setNotice(null);
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: { username: trimmed, password, role: newRole },
      });
      setNotice(`Created ${newRole} "${trimmed}".`);
      setUsername('');
      setPassword('');
      await reload();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  if (!isAdmin) {
    return (
      <AdminOnly
        id="os-users-title"
        title="Users"
        description="Manage portal accounts."
      />
    );
  }

  return (
    <section className="other-screens" aria-labelledby="os-users-title">
      <ScreenHeading
        id="os-users-title"
        title="Users"
        description="Create portal accounts and review existing roles. Only administrators can manage users."
        actions={
          <button
            type="button"
            className="os-btn os-btn--ghost"
            onClick={() => void reload()}
            disabled={loading}
          >
            Refresh
          </button>
        }
      />

      <div className="os-stats">
        <StatTile label="Users" value={users.length} />
        <StatTile label="Admins" value={admins} />
        <StatTile label="Disabled" value={disabled} />
      </div>

      <form className="os-card os-form" onSubmit={handleCreate} noValidate>
        <div className="os-field">
          <label htmlFor="os-user-name">Username</label>
          <input
            id="os-user-name"
            className="os-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. alice"
            maxLength={64}
            autoComplete="off"
            disabled={creating}
          />
        </div>
        <div className="os-field">
          <label htmlFor="os-user-password">Initial password</label>
          <input
            id="os-user-password"
            className="os-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="12–256 characters"
            maxLength={256}
            autoComplete="new-password"
            disabled={creating}
          />
        </div>
        <div className="os-field os-field--narrow">
          <label htmlFor="os-user-role">Role</label>
          <select
            id="os-user-role"
            className="os-input"
            value={newRole}
            onChange={(event) =>
              setNewRole(event.target.value === 'admin' ? 'admin' : 'user')
            }
            disabled={creating}
          >
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </div>
        <button
          type="submit"
          className="os-btn os-btn--primary"
          disabled={creating}
        >
          {creating ? 'Creating…' : 'Create user'}
        </button>
      </form>

      {formError ? <Alert>{formError}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      <div className="os-card">
        <div className="os-card-head">
          <h3>Accounts</h3>
          <span className="os-count">{users.length}</span>
        </div>

        {loading && users.length === 0 ? (
          <Loading label="Loading users…" />
        ) : users.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <div className="os-table-wrap">
            <table className="os-table">
              <caption className="os-sr-only">Portal users</caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Username</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="os-mono">{user.id}</td>
                    <td className="os-strong">{user.username}</td>
                    <td>
                      <Badge tone={user.role === 'admin' ? 'warn' : 'neutral'}>
                        {user.role === 'admin' ? 'Administrator' : 'User'}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={user.disabled ? 'error' : 'ok'}>
                        {user.disabled ? 'Disabled' : 'Active'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="os-footnote">
        Passwords are hashed by the server and are never returned or displayed
        here.
      </p>
    </section>
  );
}