import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from './api';
import './resources.css';

/**
 * Resource management screens for the unified gateway: accounts, connections,
 * models and combos.
 *
 * Contract (unified/src/lib.rs):
 *   GET    /api/:resource        -> array of rows
 *   POST   /api/:resource        -> create
 *   PUT    /api/:resource/:id    -> partial update
 *   DELETE /api/:resource/:id    -> delete
 *
 * Permission rules enforced by the server and mirrored here:
 *   - Every resource except keys is admin-only for create/update/delete.
 *     Accounts are the exception for updates/deletes: an owner may change
 *     their own account (the list is already scoped to the owner for
 *     non-admins).
 *   - Connection credentials are write-only. The API only exposes
 *     `hasCredential`; existing secrets are never loaded into the form.
 *   - Connections with a non-null `externalId` are imported by the portal
 *     sync and cannot be edited or deleted from the UI.
 *   - Updates only submit fields the backend actually accepts.
 */

const PROTOCOLS = ['chat', 'responses', 'messages'] as const;
const AUTH_TYPES = ['api_key', 'bearer'] as const;

type StatusFilter = 'all' | 'enabled' | 'disabled';
type Protocol = (typeof PROTOCOLS)[number];
type AuthType = (typeof AUTH_TYPES)[number];

interface AccountRow {
  id: string;
  ownerId: number;
  provider: string;
  displayName: string;
  enabled: boolean;
  credentialStatus: string;
  accessExpiresAt: string | null;
  tokenVersion: number;
}

interface ConnectionRow {
  id: string;
  ownerId: number;
  accountId: string | null;
  provider: string;
  name: string;
  protocol: Protocol | string;
  baseUrl: string;
  authType: AuthType | string;
  hasCredential: boolean;
  enabled: boolean;
  priority: number;
  expiresAt: string | null;
  tokenVersion: number;
  externalId: string | null;
  cooldownUntil: number;
}

interface ModelRow {
  id: string;
  upstreamModel: string;
  provider: string;
  protocol: Protocol | string;
  enabled: boolean;
}

interface ComboRow {
  name: string;
  models: string[];
  enabled: boolean;
}

type AnyRow = AccountRow | ConnectionRow | ModelRow | ComboRow;

export default function Resources({ section, role }: { section: string; role: string }) {
  const normalized = normalizeSection(section);
  const isAdmin = normalizeRole(role) === 'admin';

  switch (normalized) {
    case 'accounts':
      return <AccountsScreen isAdmin={isAdmin} />;
    case 'connections':
      return <ConnectionsScreen isAdmin={isAdmin} />;
    case 'models':
      return <ModelsScreen isAdmin={isAdmin} />;
    case 'combos':
      return <CombosScreen isAdmin={isAdmin} />;
    default:
      return <UnknownSection section={section} />;
  }
}

function normalizeSection(section: string): string {
  const compact = section.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    account: 'accounts',
    accounts: 'accounts',
    connection: 'connections',
    connections: 'connections',
    model: 'models',
    models: 'models',
    combo: 'combos',
    combos: 'combos',
  };
  return aliases[compact] ?? compact;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Shared data loading
// ---------------------------------------------------------------------------

interface Collection<T> {
  rows: T[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useCollection<T>(path: string): Collection<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T[]>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setRows(Array.isArray(result) ? result : []);
      })
      .catch((caught) => {
        if (controller.signal.aborted || (caught as Error).name === 'AbortError') return;
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { rows, loading, error, reload };
}

function useFilteredRows<T extends AnyRow>(
  rows: T[],
  search: string,
  status: StatusFilter,
  haystack: (row: T) => string,
): T[] {
  const query = search.trim().toLowerCase();
  return useMemo(
    () =>
      rows.filter((row) => {
        if (status === 'enabled' && !row.enabled) return false;
        if (status === 'disabled' && row.enabled) return false;
        if (!query) return true;
        return haystack(row).toLowerCase().includes(query);
      }),
    [rows, query, status, haystack],
  );
}

function rowId(row: AnyRow): string {
  return 'id' in row ? row.id : row.name;
}

function rowLabel(row: AnyRow): string {
  if ('displayName' in row) return row.displayName;
  if ('name' in row) return row.name;
  if ('id' in row) return row.id;
  return 'resource';
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function isPast(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < Date.now();
}

function cooldownLabel(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  const until = seconds * 1000;
  if (until <= Date.now()) return null;
  return `Cooling down until ${new Date(until).toLocaleString()}`;
}

function validateBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Base URL is required.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Base URL must be an absolute http(s) URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL must use http or https.';
  }
  if (!url.hostname) return 'Base URL must include a host.';
  if (url.username || url.password) return 'Base URL must not embed credentials.';
  if (url.search) return 'Base URL must not include a query string.';
  if (url.hash) return 'Base URL must not include a fragment.';
  return null;
}

function badgeForCredentialStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active' || normalized === 'ok') return 'badge success';
  if (normalized === 'expired' || normalized === 'error' || normalized === 'invalid') {
    return 'badge danger';
  }
  return 'badge warning';
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountsScreen({ isAdmin }: { isAdmin: boolean }) {
  const { rows, loading, error, reload } = useCollection<AccountRow>('/api/accounts');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);

  const filtered = useFilteredRows(rows, search, status, (row) =>
    [row.id, row.provider, row.displayName, row.credentialStatus, `owner ${row.ownerId}`].join(' '),
  );

  const closeForm = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);

  return (
    <section className="page res-page">
      <header className="page-header">
        <div>
          <h2>Accounts</h2>
          <p className="muted">
            Provider identities that connections can be attached to. Account tokens are managed by
            the portal; only the display name and enabled state can be changed here.
          </p>
        </div>
      </header>

      <p className="res-note" role="note">
        {isAdmin
          ? 'You can manage every account. Access tokens and token versions are read-only.'
          : 'You can rename or remove the accounts you own. Creating accounts requires an admin.'}
      </p>

      {error && (
        <div className="banner error" role="alert">
          {error}{' '}
          <button type="button" className="button small secondary" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      <ListToolbar
        noun="accounts"
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        loading={loading}
        onRefresh={reload}
        createLabel="Create account"
        onCreate={isAdmin ? () => setCreating(true) : undefined}
      />

      <div className="table-wrap res-table-wrap">
        <table className="res-table" aria-label="Accounts">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Display name</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Credential</th>
              <th scope="col">Access expires</th>
              <th scope="col" className="res-actions-col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty" role="status">
                  Loading accounts...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {rows.length === 0 ? 'No accounts yet.' : 'No accounts match your filters.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.id}>
                <td>
                  <span className="res-primary">{row.provider}</span>
                  <span className="res-sub mono">{row.id}</span>
                </td>
                <td>{row.displayName}</td>
                <td className="mono">
                  {isAdmin ? `#${row.ownerId}` : 'you'}
                </td>
                <td>{enabledBadge(row.enabled)}</td>
                <td>
                  <span className={badgeForCredentialStatus(row.credentialStatus)}>
                    {row.credentialStatus}
                  </span>
                </td>
                <td>
                  <span className={isPast(row.accessExpiresAt) ? 'res-expired' : undefined}>
                    {formatDateTime(row.accessExpiresAt)}
                  </span>
                </td>
                <td className="res-actions-col">
                  <div className="actions">
                    <button
                      type="button"
                      className="button small secondary"
                      aria-label={`Edit account ${row.displayName}`}
                      onClick={() => setEditing(row)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button small danger"
                      aria-label={`Delete account ${row.displayName}`}
                      onClick={() => setDeleting(row)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="res-count" aria-live="polite">
        Showing {filtered.length} of {rows.length} account{rows.length === 1 ? '' : 's'}.
      </p>

      {creating && (
        <AccountForm onClose={closeForm} onSaved={() => {
          closeForm();
          reload();
        }} />
      )}
      {editing && (
        <AccountForm
          row={editing}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete account?"
          confirmLabel="Delete account"
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            api(`/api/accounts/${encodeId(deleting.id)}`, { method: 'DELETE' })
          }
          onDone={() => {
            setDeleting(null);
            reload();
          }}
        >
          <p>
            Delete <strong>{deleting.displayName}</strong> ({deleting.provider})? Connections that
            reference this account stay in place but lose the account link. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function AccountForm({
  row,
  onClose,
  onSaved,
}: {
  row?: AccountRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(row?.provider ?? '');
  const [displayName, setDisplayName] = useState(row?.displayName ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedProvider = provider.trim();
    const trimmedName = displayName.trim();
    if (!row && !trimmedProvider) return setError('Provider is required.');
    if (!trimmedName) return setError('Display name is required.');
    setError(null);
    setBusy(true);
    try {
      if (row) {
        // Provider, credential status and expiry are managed by the portal.
        await api(`/api/accounts/${encodeId(row.id)}`, {
          method: 'PUT',
          body: { displayName: trimmedName, enabled },
        });
      } else {
        await api('/api/accounts', {
          method: 'POST',
          body: { provider: trimmedProvider, displayName: trimmedName, enabled },
        });
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? 'Edit account' : 'Create account'} onClose={onClose}>
      <form className="res-form" onSubmit={submit} noValidate>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          {row ? (
            <label className="field">
              <span>Provider</span>
              <input value={row.provider} disabled />
            </label>
          ) : (
            <label className="field">
              <span>Provider</span>
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="e.g. anthropic"
                autoComplete="off"
                autoFocus
              />
            </label>
          )}
          <label className="field">
            <span>Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Anthropic primary"
              autoComplete="off"
              autoFocus={Boolean(row)}
            />
          </label>
          {row && (
            <label className="field">
              <span>Account ID</span>
              <input value={row.id} className="mono" disabled />
            </label>
          )}
        </div>
        <label className="res-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <div className="actions res-form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving...' : row ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function ConnectionsScreen({ isAdmin }: { isAdmin: boolean }) {
  const { rows, loading, error, reload } = useCollection<ConnectionRow>('/api/connections');
  const accounts = useCollection<AccountRow>('/api/accounts');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<ConnectionRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ConnectionRow | null>(null);

  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts.rows) map.set(account.id, account.displayName);
    return map;
  }, [accounts.rows]);

  const filtered = useFilteredRows(rows, search, status, (row) =>
    [row.name, row.provider, row.baseUrl, row.protocol, row.authType, row.id, row.accountId ?? ''].join(
      ' ',
    ),
  );

  const closeForm = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);

  return (
    <section className="page res-page">
      <header className="page-header">
        <div>
          <h2>Connections</h2>
          <p className="muted">
            Upstream endpoints used to serve gateway traffic. Lower priority numbers are preferred.
            Credentials are encrypted at rest and never returned by the API.
          </p>
        </div>
      </header>

      <p className="res-note" role="note">
        {isAdmin
          ? 'Credentials are write-only: set a new one when creating a connection or leave the field blank to keep the stored secret. Portal-synced connections are read-only and OAuth execution is not supported.'
          : 'Read-only: creating or changing connections requires the admin role.'}
      </p>

      {error && (
        <div className="banner error" role="alert">
          {error}{' '}
          <button type="button" className="button small secondary" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {accounts.error && <div className="banner error" role="alert">Accounts could not be loaded: {accounts.error} <button type="button" className="button small secondary" onClick={accounts.reload}>Retry accounts</button></div>}

      <ListToolbar
        noun="connections"
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        loading={loading}
        onRefresh={reload}
        createLabel="Create connection"
        onCreate={isAdmin ? () => setCreating(true) : undefined}
      />

      <div className="table-wrap res-table-wrap">
        <table className="res-table res-table-wide" aria-label="Connections">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Provider</th>
              <th scope="col">Protocol</th>
              <th scope="col">Base URL</th>
              <th scope="col">Account</th>
              <th scope="col">Auth</th>
              <th scope="col">Priority</th>
              <th scope="col">Status</th>
              <th scope="col" className="res-actions-col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="empty" role="status">
                  Loading connections...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  {rows.length === 0 ? 'No connections yet.' : 'No connections match your filters.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const synced = Boolean(row.externalId);
              const cooldown = cooldownLabel(row.cooldownUntil);
              const canEdit = isAdmin && !synced;
              return (
                <tr key={row.id}>
                  <td>
                    <span className="res-primary">{row.name}</span>
                    <span className="res-sub mono">{row.id}</span>
                    {synced && (
                      <span className="badge neutral res-inline-badge" title="Imported by portal sync; read-only here.">
                        Portal sync
                      </span>
                    )}
                  </td>
                  <td>{row.provider}</td>
                  <td>
                    <span className="badge neutral">{row.protocol}</span>
                  </td>
                  <td className="mono res-url">{row.baseUrl}</td>
                  <td>
                    {row.accountId ? (
                      <span title={row.accountId}>{accountNames.get(row.accountId) ?? row.accountId}</span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td>
                    <span>{row.authType}</span>
                    <span className={`badge ${row.hasCredential ? 'success' : 'warning'} res-inline-badge`}>
                      {row.hasCredential ? 'Credential set' : 'No credential'}
                    </span>
                  </td>
                  <td className="mono">{row.priority}</td>
                  <td>
                    <div className="res-status-stack">
                      {enabledBadge(row.enabled)}
                      {row.expiresAt && isPast(row.expiresAt) && (
                        <span className="badge danger">Credential expired</span>
                      )}
                      {cooldown && <span className="badge warning">{cooldown}</span>}
                    </div>
                  </td>
                  <td className="res-actions-col">
                    <div className="actions">
                      {canEdit ? (
                        <>
                          <button
                            type="button"
                            className="button small secondary"
                            aria-label={`Edit connection ${row.name}`}
                            onClick={() => setEditing(row)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button small danger"
                            aria-label={`Delete connection ${row.name}`}
                            onClick={() => setDeleting(row)}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <span className="res-readonly" title={synced ? 'Portal-synced connections are read-only.' : undefined}>
                          {synced ? 'Synced' : 'Read-only'}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="res-count" aria-live="polite">
        Showing {filtered.length} of {rows.length} connection{rows.length === 1 ? '' : 's'}.
      </p>

      {creating && (
        <ConnectionForm
          isAdmin={isAdmin}
          accounts={accounts.rows}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {editing && (
        <ConnectionForm
          isAdmin={isAdmin}
          row={editing}
          accounts={accounts.rows}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete connection?"
          confirmLabel="Delete connection"
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            api(`/api/connections/${encodeId(deleting.id)}`, { method: 'DELETE' })
          }
          onDone={() => {
            setDeleting(null);
            reload();
          }}
        >
          <p>
            Delete <strong>{deleting.name}</strong> ({deleting.provider})? Traffic will stop routing
            to this endpoint immediately. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function ConnectionForm({
  row,
  isAdmin,
  accounts,
  onClose,
  onSaved,
}: {
  row?: ConnectionRow;
  isAdmin: boolean;
  accounts: AccountRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(row?.provider ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [accountId, setAccountId] = useState(row?.accountId ?? '');
  const [protocol, setProtocol] = useState<string>(row?.protocol ?? 'chat');
  const [baseUrl, setBaseUrl] = useState(row?.baseUrl ?? '');
  const [authType, setAuthType] = useState<string>(row?.authType ?? 'api_key');
  const [credential, setCredential] = useState('');
  const [priority, setPriority] = useState(String(row?.priority ?? 0));
  const [expiresAt, setExpiresAt] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedProvider = provider.trim();
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();
    if (!trimmedProvider) return setError('Provider is required.');
    if (!trimmedName) return setError('Name is required.');
    if (!PROTOCOLS.includes(protocol as Protocol)) return setError('Choose a valid protocol.');
    if (!AUTH_TYPES.includes(authType as AuthType)) return setError('Choose a valid auth type.');
    const urlProblem = validateBaseUrl(trimmedUrl);
    if (urlProblem) return setError(urlProblem);
    const parsedPriority = Number.parseInt(priority, 10);
    if (!Number.isInteger(parsedPriority) || String(parsedPriority) !== priority.trim()) {
      return setError('Priority must be a whole number.');
    }
    if (!row && !credential) return setError('Credential is required.');
    if (credential.length > 16384) return setError('Credential is too long (max 16384 characters).');
    if (!row && expiresAt && (Number.isNaN(Date.parse(expiresAt)) || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(expiresAt))) return setError('Expiry must be an RFC 3339 timestamp with a timezone, e.g. 2027-01-01T00:00:00Z.');
    if (!row && ownerId && (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId)))) return setError('Owner ID must be a positive whole number.');
    setError(null);
    setBusy(true);
    try {
      if (row) {
        // Only fields accepted by the update endpoint are submitted. Provider,
        // account link, auth type and expiry are immutable once created.
        const body: Record<string, unknown> = {
          name: trimmedName,
          baseUrl: trimmedUrl,
          protocol,
          enabled,
          priority: parsedPriority,
        };
        if (credential) body.credential = credential;
        await api(`/api/connections/${encodeId(row.id)}`, { method: 'PUT', body });
      } else {
        const body: Record<string, unknown> = {
          provider: trimmedProvider,
          name: trimmedName,
          protocol,
          baseUrl: trimmedUrl,
          authType,
          credential,
          enabled,
          priority: parsedPriority,
        };
        if (accountId) body.accountId = accountId;
        if (ownerId) body.ownerId = Number(ownerId);
        if (expiresAt) body.expiresAt = expiresAt;
        await api('/api/connections', { method: 'POST', body });
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? 'Edit connection' : 'Create connection'} onClose={onClose}>
      <form className="res-form" onSubmit={submit} noValidate>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          {row ? (
            <label className="field">
              <span>Provider</span>
              <input value={row.provider} disabled />
            </label>
          ) : (
            <label className="field">
              <span>Provider</span>
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="e.g. anthropic"
                autoComplete="off"
                autoFocus
              />
            </label>
          )}
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Anthropic production"
              autoComplete="off"
              autoFocus={Boolean(row)}
            />
          </label>
          <label className="field">
            <span>Account</span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={Boolean(row)}
            >
              <option value="">No account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} ({account.provider})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Protocol</span>
            <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
              {PROTOCOLS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              inputMode="url"
              autoComplete="off"
              className="mono"
            />
          </label>
          <label className="field">
            <span>Auth type</span>
            <select
              value={authType}
              onChange={(event) => setAuthType(event.target.value)}
              disabled={Boolean(row)}
            >
              {AUTH_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Credential</span>
            <input
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              placeholder={
                row
                  ? row.hasCredential
                    ? 'Leave blank to keep the stored credential'
                    : 'No credential stored - enter one'
                  : 'Required'
              }
              autoComplete="new-password"
              spellCheck={false}
              maxLength={16384}
            />
          </label>
          <label className="field">
            <span>Priority</span>
            <input
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Expires at {row ? '(read-only)' : '(optional)'}</span>
            {row ? <input value={formatDateTime(row.expiresAt)} disabled /> : <input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} placeholder="2027-01-01T00:00:00Z" autoComplete="off" />}
          </label>
          {!row && isAdmin && <label className="field">
            <span>Owner ID (optional)</span>
            <input value={ownerId} onChange={(event) => setOwnerId(event.target.value)} inputMode="numeric" placeholder="Defaults to your user ID" autoComplete="off" />
          </label>}
        </div>
        <p className="muted small-text res-credential-hint">
          Base URL should include the upstream API prefix (usually /v1). Credentials are encrypted before storage and are never displayed again. The API only reports whether a credential is configured.
        </p>
        <label className="res-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <div className="actions res-form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving...' : row ? 'Save changes' : 'Create connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function ModelsScreen({ isAdmin }: { isAdmin: boolean }) {
  const { rows, loading, error, reload } = useCollection<ModelRow>('/api/models');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<ModelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ModelRow | null>(null);

  const filtered = useFilteredRows(rows, search, status, (row) =>
    [row.id, row.upstreamModel, row.provider, row.protocol].join(' '),
  );

  const closeForm = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);

  return (
    <section className="page res-page">
      <header className="page-header">
        <div>
          <h2>Models</h2>
          <p className="muted">
            Public model identifiers exposed by the gateway and the upstream name each one maps to.
            Disabled models are hidden from <span className="mono">/v1/models</span>.
          </p>
        </div>
      </header>

      <p className="res-note" role="note">
        {isAdmin
          ? 'Model IDs are permanent once created; upstream name, provider, protocol and state can be changed.'
          : 'Read-only: managing models requires the admin role.'}
      </p>

      {error && (
        <div className="banner error" role="alert">
          {error}{' '}
          <button type="button" className="button small secondary" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      <ListToolbar
        noun="models"
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        loading={loading}
        onRefresh={reload}
        createLabel="Create model"
        onCreate={isAdmin ? () => setCreating(true) : undefined}
      />

      <div className="table-wrap res-table-wrap">
        <table className="res-table" aria-label="Models">
          <thead>
            <tr>
              <th scope="col">Model ID</th>
              <th scope="col">Upstream model</th>
              <th scope="col">Provider</th>
              <th scope="col">Protocol</th>
              <th scope="col">Status</th>
              <th scope="col" className="res-actions-col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty" role="status">
                  Loading models...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {rows.length === 0 ? 'No models yet.' : 'No models match your filters.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="mono res-primary">{row.id}</td>
                <td className="mono">{row.upstreamModel}</td>
                <td>{row.provider}</td>
                <td>
                  <span className="badge neutral">{row.protocol}</span>
                </td>
                <td>{enabledBadge(row.enabled)}</td>
                <td className="res-actions-col">
                  <div className="actions">
                    {isAdmin ? (
                      <>
                        <button
                          type="button"
                          className="button small secondary"
                          aria-label={`Edit model ${row.id}`}
                          onClick={() => setEditing(row)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button small danger"
                          aria-label={`Delete model ${row.id}`}
                          onClick={() => setDeleting(row)}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <span className="res-readonly">Read-only</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="res-count" aria-live="polite">
        Showing {filtered.length} of {rows.length} model{rows.length === 1 ? '' : 's'}.
      </p>

      {creating && (
        <ModelForm
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {editing && (
        <ModelForm
          row={editing}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete model?"
          confirmLabel="Delete model"
          onCancel={() => setDeleting(null)}
          onConfirm={() => api(`/api/models/${encodeId(deleting.id)}`, { method: 'DELETE' })}
          onDone={() => {
            setDeleting(null);
            reload();
          }}
        >
          <p>
            Delete <strong>{deleting.id}</strong>? Requests for this model will fail and any combo
            that references it will retain the ID but skip it during routing.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function ModelForm({
  row,
  onClose,
  onSaved,
}: {
  row?: ModelRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(row?.id ?? '');
  const [upstreamModel, setUpstreamModel] = useState(row?.upstreamModel ?? '');
  const [provider, setProvider] = useState(row?.provider ?? '');
  const [protocol, setProtocol] = useState<string>(row?.protocol ?? 'chat');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedId = id.trim();
    const trimmedUpstream = upstreamModel.trim();
    const trimmedProvider = provider.trim();
    if (!trimmedId) return setError('Model ID is required.');
    if (!trimmedProvider) return setError('Provider is required.');
    if (!PROTOCOLS.includes(protocol as Protocol)) return setError('Choose a valid protocol.');
    setError(null);
    setBusy(true);
    try {
      if (row) {
        // The model id is the primary key and cannot be changed.
        const body: Record<string, unknown> = { provider: trimmedProvider, protocol, enabled };
        if (trimmedUpstream) body.upstreamModel = trimmedUpstream;
        await api(`/api/models/${encodeId(row.id)}`, { method: 'PUT', body });
      } else {
        const body: Record<string, unknown> = {
          id: trimmedId,
          provider: trimmedProvider,
          protocol,
          enabled,
        };
        if (trimmedUpstream) body.upstreamModel = trimmedUpstream;
        await api('/api/models', { method: 'POST', body });
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? 'Edit model' : 'Create model'} onClose={onClose}>
      <form className="res-form" onSubmit={submit} noValidate>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Model ID</span>
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="e.g. claude-sonnet-4"
              autoComplete="off"
              autoFocus={!row}
              disabled={Boolean(row)}
              className="mono"
            />
          </label>
          <label className="field">
            <span>Upstream model</span>
            <input
              value={upstreamModel}
              onChange={(event) => setUpstreamModel(event.target.value)}
              placeholder={row ? 'Leave blank to keep current' : 'Defaults to the model ID'}
              autoComplete="off"
              className="mono"
            />
          </label>
          <label className="field">
            <span>Provider</span>
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="e.g. anthropic"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Protocol</span>
            <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
              {PROTOCOLS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="res-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <div className="actions res-form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving...' : row ? 'Save changes' : 'Create model'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

function CombosScreen({ isAdmin }: { isAdmin: boolean }) {
  const { rows, loading, error, reload } = useCollection<ComboRow>('/api/combos');
  const models = useCollection<ModelRow>('/api/models');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<ComboRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ComboRow | null>(null);

  const filtered = useFilteredRows(rows, search, status, (row) =>
    [row.name, ...row.models].join(' '),
  );

  const closeForm = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);

  const catalog = useMemo(() => models.rows.map((model) => model.id), [models.rows]);

  return (
    <section className="page res-page">
      <header className="page-header">
        <div>
          <h2>Combos</h2>
          <p className="muted">
            Ordered fallback groups served under a single model name. Requests walk the list from
            first to last until a model succeeds.
          </p>
        </div>
      </header>

      <p className="res-note" role="note">
        {isAdmin
          ? 'Combo names are permanent once created; reorder, add or remove member models at any time.'
          : 'Read-only: managing combos requires the admin role.'}
      </p>

      {error && (
        <div className="banner error" role="alert">
          {error}{' '}
          <button type="button" className="button small secondary" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {models.error && <div className="banner error" role="alert">Model suggestions could not be loaded: {models.error} <button type="button" className="button small secondary" onClick={models.reload}>Retry models</button></div>}

      <ListToolbar
        noun="combos"
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        loading={loading}
        onRefresh={reload}
        createLabel="Create combo"
        onCreate={isAdmin ? () => setCreating(true) : undefined}
      />

      <div className="table-wrap res-table-wrap">
        <table className="res-table" aria-label="Combos">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Models (in fallback order)</th>
              <th scope="col">Status</th>
              <th scope="col" className="res-actions-col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty" role="status">
                  Loading combos...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  {rows.length === 0 ? 'No combos yet.' : 'No combos match your filters.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.name}>
                <td className="mono res-primary">{row.name}</td>
                <td>
                  {row.models.length === 0 ? (
                    <span className="muted">No models</span>
                  ) : (
                    <ol className="res-chip-list">
                      {row.models.map((model, index) => (
                        <li key={`${model}-${index}`}>
                          <span className="badge neutral mono">{model}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </td>
                <td>{enabledBadge(row.enabled)}</td>
                <td className="res-actions-col">
                  <div className="actions">
                    {isAdmin ? (
                      <>
                        <button
                          type="button"
                          className="button small secondary"
                          aria-label={`Edit combo ${row.name}`}
                          onClick={() => setEditing(row)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button small danger"
                          aria-label={`Delete combo ${row.name}`}
                          onClick={() => setDeleting(row)}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <span className="res-readonly">Read-only</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="res-count" aria-live="polite">
        Showing {filtered.length} of {rows.length} combo{rows.length === 1 ? '' : 's'}.
      </p>

      {creating && (
        <ComboForm
          catalog={catalog}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {editing && (
        <ComboForm
          row={editing}
          catalog={catalog}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete combo?"
          confirmLabel="Delete combo"
          onCancel={() => setDeleting(null)}
          onConfirm={() => api(`/api/combos/${encodeId(deleting.name)}`, { method: 'DELETE' })}
          onDone={() => {
            setDeleting(null);
            reload();
          }}
        >
          <p>
            Delete <strong>{deleting.name}</strong>? Requests using this combo name will fail. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function ComboForm({
  row,
  catalog,
  onClose,
  onSaved,
}: {
  row?: ComboRow;
  catalog: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row?.name ?? '');
  const [models, setModels] = useState<string[]>(row?.models ?? []);
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedName = name.trim();
    const cleaned = models.map((model) => model.trim());
    if (!trimmedName) return setError('Combo name is required.');
    if (cleaned.length === 0) return setError('Add at least one model.');
    if (cleaned.some((model) => !model)) return setError('Model names cannot be empty.');
    if (cleaned.length > 100) return setError('A combo can contain at most 100 models.');
    if (new Set(cleaned).size !== cleaned.length) return setError('Remove duplicate models.');
    setError(null);
    setBusy(true);
    try {
      if (row) {
        await api(`/api/combos/${encodeId(row.name)}`, {
          method: 'PUT',
          body: { models: cleaned, enabled },
        });
      } else {
        await api('/api/combos', {
          method: 'POST',
          body: { name: trimmedName, models: cleaned, enabled },
        });
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={row ? 'Edit combo' : 'Create combo'} onClose={onClose}>
      <form className="res-form" onSubmit={submit} noValidate>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Combo name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. fast"
              autoComplete="off"
              autoFocus={!row}
              disabled={Boolean(row)}
              className="mono"
            />
          </label>
        </div>
        <div className="field">
          <span>Models</span>
          <ModelListEditor value={models} onChange={setModels} catalog={catalog} />
        </div>
        <label className="res-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <div className="actions res-form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Saving...' : row ? 'Save changes' : 'Create combo'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ModelListEditor({
  value,
  onChange,
  catalog,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  catalog: string[];
}) {
  const [draft, setDraft] = useState('');
  const datalistId = useId();

  const suggestions = useMemo(
    () => catalog.filter((model) => !value.includes(model)).sort((a, b) => a.localeCompare(b)),
    [catalog, value],
  );

  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) {
      setDraft('');
      return;
    }
    if (value.length >= 100) return;
    onChange([...value, trimmed]);
    setDraft('');
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, current) => current !== index));
  };

  return (
    <div className="res-model-editor">
      {value.length === 0 ? (
        <p className="muted small-text">No models added yet.</p>
      ) : (
        <ol className="res-model-list">
          {value.map((model, index) => (
            <li key={`${model}-${index}`}>
              <span className="mono res-model-name">{model}</span>
              <div className="actions">
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${model} up`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() => move(index, 1)}
                  disabled={index === value.length - 1}
                  aria-label={`Move ${model} down`}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="button small danger"
                  onClick={() => remove(index)}
                  aria-label={`Remove ${model}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="res-add-row">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(draft);
            }
          }}
          list={datalistId}
          placeholder="Add a model ID"
          aria-label="Add a model ID"
          autoComplete="off"
          className="mono"
          disabled={value.length >= 100}
        />
        <datalist id={datalistId}>
          {suggestions.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <button
          type="button"
          className="button secondary"
          onClick={() => add(draft)}
          disabled={!draft.trim() || value.length >= 100}
        >
          Add model
        </button>
      </div>
      <p className="muted small-text">
        Order matters: traffic tries the first model, then falls back down the list.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------

function ListToolbar({
  noun,
  search,
  onSearch,
  status,
  onStatus,
  loading,
  onRefresh,
  createLabel,
  onCreate,
}: {
  noun: string;
  search: string;
  onSearch: (value: string) => void;
  status: StatusFilter;
  onStatus: (value: StatusFilter) => void;
  loading: boolean;
  onRefresh: () => void;
  createLabel: string;
  onCreate?: () => void;
}) {
  return (
    <div className="res-toolbar">
      <div className="res-filters">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={`Search ${noun}...`}
          aria-label={`Search ${noun}`}
          autoComplete="off"
        />
        <select
          value={status}
          onChange={(event) => onStatus(event.target.value as StatusFilter)}
          aria-label={`Filter ${noun} by status`}
        >
          <option value="all">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>
      <div className="actions">
        <button type="button" className="button secondary" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
        {onCreate && (
          <button type="button" className="button primary" onClick={onCreate}>
            {createLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function enabledBadge(enabled: boolean) {
  return <span className={`badge ${enabled ? 'success' : 'neutral'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>;
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div ref={dialogRef} tabIndex={-1} className="modal res-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="res-modal-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="button small secondary"
            onClick={() => closeRef.current()}
            aria-label="Close dialog"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ConfirmDialog({
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  onDone,
  children,
}: {
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<unknown>;
  onDone: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={busy ? () => undefined : onCancel}>
      <div className="res-form">
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {children}
        <div className="actions res-form-actions">
          <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Deleting...' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UnknownSection({ section }: { section: string }) {
  return (
    <section className="page res-page">
      <div className="banner warning" role="alert">
        Unknown resource section <strong>{section}</strong>. Choose Accounts, Connections, Models or
        Combos.
      </div>
    </section>
  );
}