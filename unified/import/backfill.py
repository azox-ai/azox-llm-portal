#!/usr/bin/env python3
"""Phase-2 backfill for the isolated unified gateway.

Copies, from private read-only snapshots:
  1. models (portal catalog rows plus models observed in router usage),
  2. portal-managed OAuth connections (access token only, through the internal
     sync API so the gateway encrypts it),
  3. usage history (direct SQLite insert into the isolated unified database).

Dry-run is the default and writes nothing. --apply refuses unless the target
database is the one named by the isolated gateway env file, the database
directory is 0700, and UNIFIED_ALLOW_UPSTREAM is not true. Secret values are
never printed. See import/README.md.
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SOURCES = ('portal', '9router', 'omniroute')
RFC3339 = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$')


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def open_source(path):
    path = os.path.abspath(path)
    # Immutable snapshots are checkpointed already, so no journal or shm is written.
    con = sqlite3.connect('file:' + urllib.parse.quote(path) + '?mode=ro&immutable=1', uri=True)
    con.row_factory = sqlite3.Row
    if con.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise ValueError('source snapshot failed quick_check')
    return con


def rows(con, table):
    try:
        cur = con.execute('SELECT * FROM ' + quote(table))
    except sqlite3.Error:
        return []
    return [dict(r) for r in cur]


def text(v):
    if isinstance(v, bytes):
        try:
            return v.decode('utf-8')
        except UnicodeDecodeError:
            return None
    return v if isinstance(v, str) else None


def json_obj(value):
    try:
        v = json.loads(value or '{}')
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        return {}


def nonempty(v):
    t = text(v)
    return t if t is not None and t.strip() != '' else None


def rfc3339(v):
    t = nonempty(v)
    if t is None or RFC3339.match(t) is None:
        return None
    try:
        dt = datetime.fromisoformat(t.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def positive_int(v):
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        return None
    return v


def load_env(path):
    values = {}
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key, value = key.strip(), value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                values[key] = value
    except OSError:
        raise ValueError('cannot read gateway env file') from None
    return values


def env_or(values, key):
    return os.environ.get(key) or values.get(key) or ''


# ---------------------------------------------------------------- planning ---

def portal_model_plan(con):
    plan, skipped = [], collections.Counter()
    for row in rows(con, 'model_catalog'):
        model = nonempty(row.get('model'))
        if model is None or '/' not in model:
            skipped['catalog_no_provider_prefix'] += 1
            continue
        prefix, upstream = model.split('/', 1)
        if not prefix or not upstream:
            skipped['catalog_no_provider_prefix'] += 1
            continue
        provider = {'anthropic': 'claude', 'openai': 'codex'}.get(prefix, prefix)
        plan.append({
            'id': model,
            'upstreamModel': upstream,
            'provider': provider,
            'protocol': 'messages' if provider == 'claude' else 'chat',
            'enabled': text(row.get('status')) == 'active',
            'source': 'catalog',
        })
    return plan, skipped


def derived_model_plan(con9, conomni):
    seen = {}
    for source, con, table in (('9router', con9, 'usageHistory'), ('omniroute', conomni, 'call_logs')):
        for row in rows(con, table):
            provider = text(row.get('provider'))
            model = nonempty(row.get('model')) or nonempty(row.get('requested_model'))
            if provider not in ('claude', 'codex') or model is None:
                continue
            key = (provider, model)
            if key not in seen:
                seen[key] = {
                    'id': model,
                    'upstreamModel': model,
                    'provider': provider,
                    'protocol': 'messages' if provider == 'claude' else 'responses',
                    'enabled': True,
                    'source': 'usage:' + source,
                }
    return list(seen.values())


def connection_plan(con):
    plan, skipped = [], collections.Counter()
    imported_ext = set()
    for row in rows(con, 'providerConnections'):
        if text(row.get('authType')) != 'oauth':
            skipped['not_oauth'] += 1
            continue
        provider = text(row.get('provider'))
        if provider not in ('claude', 'codex'):
            skipped['provider_not_portal'] += 1
            continue
        data = json_obj(text(row.get('data')))
        # Only allow-listed fields are read. refreshToken/idToken are never used.
        access = nonempty(data.get('accessToken'))
        if access is None:
            skipped['no_access_token'] += 1
            continue
        psd = data.get('providerSpecificData')
        if not isinstance(psd, dict):
            skipped['no_provider_specific_data'] += 1
            continue
        external_id = nonempty(psd.get('portalExternalId'))
        if external_id is None or len(external_id.encode()) > 128:
            skipped['no_portal_external_id'] += 1
            continue
        version = positive_int(psd.get('portalTokenVersion'))
        if version is None:
            skipped['bad_token_version'] += 1
            continue
        expires_raw = nonempty(data.get('expiresAt'))
        expires = rfc3339(expires_raw)
        if expires is None:
            skipped['bad_expires_at'] += 1
            continue
        if len(access.encode()) > 16384:
            skipped['access_token_too_long'] += 1
            continue
        if external_id in imported_ext:
            skipped['duplicate_external_id'] += 1
            continue
        imported_ext.add(external_id)
        extra = {}
        for field in ('chatgptAccountId', 'workspaceId', 'accountId'):
            value = nonempty(psd.get(field))
            if value is not None:
                extra[field] = value
                break
        body = {
            'provider': provider,
            'accessToken': access,
            'expiresAt': expires_raw,
            'tokenVersion': version,
        }
        if extra:
            body['providerSpecificData'] = extra
        display = nonempty(data.get('displayName')) or nonempty(row.get('name'))
        if display is not None:
            body['displayName'] = display
        body['enabled'] = row.get('isActive') != 0
        plan.append({'external_id': external_id, 'body': body, 'expires': expires})
    return plan, skipped


def source_external_ids(con, table, field):
    mapping = {}
    for row in rows(con, table):
        data = json_obj(text(row.get(field)))
        psd = data.get('providerSpecificData') if field == 'data' else data
        if not isinstance(psd, dict):
            continue
        external_id = nonempty(psd.get('portalExternalId'))
        if external_id is not None:
            mapping[text(row.get('id'))] = external_id
    return mapping


def key_id_map(db):
    return {row[0]: row[1] for row in db.execute('SELECT key_hash,id FROM api_keys')}


def usage_rows(con9, conomni, keys):
    out, skipped = [], collections.Counter()
    nine_ext = source_external_ids(con9, 'providerConnections', 'data')
    omni_ext = source_external_ids(conomni, 'provider_connections', 'provider_specific_data')
    for row in rows(con9, 'usageHistory'):
        model = nonempty(row.get('model'))
        if model is None:
            skipped['9router_empty_model'] += 1
            continue
        created = nonempty(row.get('timestamp'))
        if created is None:
            skipped['9router_missing_timestamp'] += 1
            continue
        status = 200 if (text(row.get('status')) or '').strip().lower() in ('ok', 'success') else 502
        external_id = nine_ext.get(text(row.get('connectionId')))
        key = nonempty(row.get('apiKey'))
        key_id = keys.get(hashlib.sha256(key.encode()).hexdigest()) if key else None
        out.append({'source': '9router', 'model': model, 'created_at': created,
                    'status': status, 'external_id': external_id, 'key_id': key_id})
    for row in rows(conomni, 'call_logs'):
        model = nonempty(row.get('model')) or nonempty(row.get('requested_model'))
        if model is None:
            skipped['omniroute_empty_model'] += 1
            continue
        created = nonempty(row.get('timestamp'))
        if created is None:
            skipped['omniroute_missing_timestamp'] += 1
            continue
        raw = row.get('status')
        if isinstance(raw, bool):
            status = int(raw)
        elif isinstance(raw, int):
            status = raw
        else:
            try:
                status = int(str(raw).strip())
            except (TypeError, ValueError):
                skipped['omniroute_bad_status'] += 1
                continue
        out.append({'source': 'omniroute', 'model': model, 'created_at': created,
                    'status': status, 'external_id': omni_ext.get(text(row.get('connection_id'))),
                    'key_id': None})
    return out, skipped


# --------------------------------------------------------------------- API ---

class API:
    def __init__(self, url):
        self.url = url.rstrip('/')
        parts = urllib.parse.urlsplit(self.url)
        if (parts.scheme != 'http' or parts.hostname not in ('127.0.0.1', 'localhost', '::1')
                or parts.username or parts.password or parts.path not in ('', '/')
                or parts.query or parts.fragment):
            raise ValueError('UNIFIED_URL must be a loopback HTTP origin without path')
        self.admin_token = None

    def request(self, method, path, obj=None, token=None):
        data = json.dumps(obj).encode() if obj is not None else None
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        except urllib.error.URLError:
            raise ValueError('cannot reach unified API') from None
        body = None
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
        return status, body

    def login(self, username, password):
        if not password:
            raise ValueError('UNIFIED_ADMIN_PASSWORD is required for API login')
        status, body = self.request('POST', '/api/login', {'username': username, 'password': password})
        if status != 200 or not isinstance(body, dict) or body.get('role') != 'admin':
            raise ValueError('admin login failed')
        self.admin_token = body['token']


def apply_models(api, plan):
    status, body = api.request('GET', '/api/models', token=api.admin_token)
    if status != 200 or not isinstance(body, list):
        raise ValueError('cannot list existing models (HTTP %d)' % status)
    existing = {r.get('id') for r in body if isinstance(r, dict)}
    counts = collections.Counter()
    for model in plan:
        tag = model['source']
        if model['id'] in existing:
            counts[tag + '_present'] += 1
            continue
        payload = {k: model[k] for k in ('id', 'upstreamModel', 'provider', 'protocol', 'enabled')}
        status, _ = api.request('POST', '/api/models', payload, token=api.admin_token)
        if status == 201:
            counts[tag + '_created'] += 1
            existing.add(model['id'])
        elif status == 409:
            counts[tag + '_present'] += 1
            existing.add(model['id'])
        else:
            raise ValueError('model create rejected (HTTP %d)' % status)
    return counts


def apply_connections(api, plan, token):
    if plan and not token:
        raise ValueError('PORTAL_SYNC_TOKEN is required for connection import')
    counts = collections.Counter()
    for item in plan:
        path = '/api/internal/portal/connections/' + urllib.parse.quote(item['external_id'], safe='')
        status, _ = api.request('PUT', path, item['body'], token=token)
        if status == 200:
            counts['imported'] += 1
        elif status == 409:
            counts['stale'] += 1
        elif status == 400:
            counts['rejected'] += 1
        elif status == 401:
            raise ValueError('portal sync token was rejected')
        else:
            raise ValueError('connection sync failed (HTTP %d)' % status)
    return counts


def insert_usage(db_path, usage):
    db = sqlite3.connect('file:' + urllib.parse.quote(os.path.realpath(db_path)) + '?mode=rw', uri=True, timeout=30)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=30000')
        owner = db.execute("SELECT id FROM users WHERE id=1 AND role='admin' AND disabled=0").fetchone()
        if owner is None:
            raise ValueError('unified user 1 is not an enabled admin')
        cmap = {row[1]: row[0] for row in db.execute('SELECT id,external_id FROM connections WHERE external_id IS NOT NULL')}
        existing = {(o, m, c or '', st, ca) for o, m, c, st, ca in
                    db.execute("SELECT owner_id,model,COALESCE(connection_id,''),status,created_at FROM usage")}
        inserted = collections.Counter()
        deduped = collections.Counter()
        mapping = collections.Counter()
        try:
            db.execute('BEGIN IMMEDIATE')
            for row in usage:
                cid = cmap.get(row['external_id']) if row['external_id'] else None
                if row['external_id']:
                    mapping['resolved' if cid else 'unresolved'] += 1
                else:
                    mapping['no_source_connection'] += 1
                key = (1, row['model'], cid or '', row['status'], row['created_at'])
                if key in existing:
                    deduped[row['source']] += 1
                    continue
                db.execute(
                    'INSERT INTO usage(owner_id,key_id,model,connection_id,status,created_at) VALUES(?,?,?,?,?,?)',
                    (1, row['key_id'], row['model'], cid, row['status'], row['created_at']))
                existing.add(key)
                inserted[row['source']] += 1
            db.commit()
        except Exception:
            db.rollback()
            raise
        return inserted, deduped, mapping
    finally:
        db.close()


def plan_mapping_summary(usage, cmap, planned_external):
    counts = collections.Counter()
    for row in usage:
        ext = row['external_id']
        if not ext:
            counts['no_source_connection'] += 1
        elif ext in cmap or ext in planned_external:
            counts['resolvable_after_connections'] += 1
        else:
            counts['unresolvable'] += 1
    return counts


# ------------------------------------------------------------------- guards ---

def check_apply(args, values, db_path):
    env_db = values.get('UNIFIED_DATABASE_PATH')
    if not env_db:
        raise ValueError('gateway env file must define UNIFIED_DATABASE_PATH')
    if os.path.realpath(db_path) != os.path.realpath(env_db):
        raise ValueError('target database does not match the running isolated gateway')
    parent = os.path.dirname(os.path.realpath(db_path))
    if not os.path.isdir(parent):
        raise ValueError('target database directory does not exist')
    if stat.S_IMODE(os.stat(parent).st_mode) != 0o700:
        raise ValueError('target database directory must be 0700')
    if (values.get('UNIFIED_ALLOW_UPSTREAM') or '').strip().lower() == 'true':
        raise ValueError('refusing to import while UNIFIED_ALLOW_UPSTREAM=true')
    listen = (values.get('UNIFIED_LISTEN') or '').strip()
    parts = urllib.parse.urlsplit(args.url.rstrip('/'))
    if listen and parts.netloc != listen:
        raise ValueError('API URL does not match UNIFIED_LISTEN of the isolated gateway')
    if not os.path.isfile(db_path):
        raise ValueError('target unified database does not exist')
    con = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(db_path)) + '?mode=ro', uri=True)
    try:
        found = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {'users', 'connections', 'models', 'api_keys', 'usage'}
        if not required.issubset(found):
            raise ValueError('target is not a unified database')
    finally:
        con.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='default; no target writes')
    mode.add_argument('--apply', action='store_true')
    p.add_argument('--snapshot-root', default='/data/unified-gateway/snapshots',
                   help='directory containing {portal,9router,omniroute}/db.snapshot')
    p.add_argument('--unified-db', help='isolated unified SQLite DB (default: env file value)')
    p.add_argument('--url', default='http://127.0.0.1:18080')
    p.add_argument('--env-file', default='/data/unified-gateway/unified.env')
    args = p.parse_args()

    values = {}
    if os.path.isfile(args.env_file):
        values = load_env(args.env_file)
    db_path = args.unified_db or values.get('UNIFIED_DATABASE_PATH')
    if not db_path:
        p.error('--unified-db is required when the env file does not define UNIFIED_DATABASE_PATH')
    snapshots = {s: os.path.join(args.snapshot_root, s, 'db.snapshot') for s in SOURCES}
    for path in snapshots.values():
        if not os.path.isfile(path):
            p.error('missing snapshot: ' + path)
        if os.path.exists(path + '-wal') and os.path.getsize(path + '-wal'):
            p.error('snapshot has a WAL: checkpoint it on a private copy first')
        if os.path.realpath(path) == os.path.realpath(db_path):
            p.error('source and destination must differ')

    try:
        check_apply_guard = args.apply
        if check_apply_guard:
            check_apply(args, values, db_path)
        cons = {s: open_source(path) for s, path in snapshots.items()}
        try:
            catalog, catalog_skipped = portal_model_plan(cons['portal'])
            derived = derived_model_plan(cons['9router'], cons['omniroute'])
            models = catalog + derived
            connections, connection_skipped = connection_plan(cons['9router'])
            planned_ext = {c['external_id'] for c in connections}

            db = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(db_path)) + '?mode=ro', uri=True, timeout=30)
            try:
                keys = key_id_map(db)
                cmap = {row[1]: row[0] for row in db.execute('SELECT id,external_id FROM connections WHERE external_id IS NOT NULL')}
            finally:
                db.close()
            usage, usage_skipped = usage_rows(cons['9router'], cons['omniroute'], keys)
            mapping = plan_mapping_summary(usage, cmap, planned_ext)
        finally:
            for con in cons.values():
                con.close()

        now = datetime.now(timezone.utc)
        expired = sum(1 for c in connections if c['expires'] <= now)
        soon = sum(1 for c in connections if now < c['expires'] <= now + timedelta(hours=24))
        later = len(connections) - expired - soon
        earliest = min((c['expires'] for c in connections), default=None)
        print('mode:', 'apply' if args.apply else 'dry-run')
        print('models: catalog=%d derived=%d total=%d' % (len(catalog), len(derived), len(models)))
        print('models skipped:', json.dumps(dict(catalog_skipped), sort_keys=True))
        print('connections: planned=%d expired=%d expiring_within_24h=%d valid_beyond_24h=%d' % (
            len(connections), expired, soon, later))
        if earliest is not None:
            print('connection earliest expiresAt:', earliest.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        print('connections skipped:', json.dumps(dict(connection_skipped), sort_keys=True))
        print('usage rows: 9router=%d omniroute=%d total=%d' % (
            sum(1 for r in usage if r['source'] == '9router'),
            sum(1 for r in usage if r['source'] == 'omniroute'), len(usage)))
        print('usage skipped:', json.dumps(dict(usage_skipped), sort_keys=True))
        print('usage connection mapping:', json.dumps(dict(mapping), sort_keys=True))

        if not args.apply:
            print('no target writes (dry-run)')
            return 0

        api = API(args.url)
        username = env_or(values, 'UNIFIED_ADMIN_USERNAME') or 'admin'
        api.login(username, env_or(values, 'UNIFIED_ADMIN_PASSWORD'))
        print('model results:', json.dumps(dict(apply_models(api, models)), sort_keys=True))
        print('connection results:', json.dumps(dict(apply_connections(api, connections, env_or(values, 'PORTAL_SYNC_TOKEN'))), sort_keys=True))
        inserted, deduped, applied_mapping = insert_usage(db_path, usage)
        print('usage inserted:', json.dumps(dict(inserted), sort_keys=True), 'total', sum(inserted.values()))
        print('usage deduped:', json.dumps(dict(deduped), sort_keys=True), 'total', sum(deduped.values()))
        print('usage applied mapping:', json.dumps(dict(applied_mapping), sort_keys=True))
    except (ValueError, sqlite3.Error, OSError) as exc:
        # Never include row contents or secrets in error output.
        print('backfill failed:', str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())