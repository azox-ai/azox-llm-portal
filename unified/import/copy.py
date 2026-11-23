#!/usr/bin/env python3
"""Copy SQLite snapshots into an isolated unified gateway. Never opens a source writable."""
import argparse
import base64
import collections
import hashlib
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

SOURCES = ('portal', '9router', 'omniroute')


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def open_source(path):
    path = os.path.abspath(path)
    # Immutable snapshots must be checkpointed first, so no source journal or shm is created.
    con = sqlite3.connect('file:' + urllib.parse.quote(path) + '?mode=ro&immutable=1', uri=True)
    con.row_factory = sqlite3.Row
    con.text_factory = bytes  # preserve invalid UTF-8 and exact TEXT bytes in archive
    if con.execute('PRAGMA quick_check').fetchone()[0] != b'ok':
        raise ValueError('source snapshot failed quick_check')
    return con


def s(v):
    if isinstance(v, bytes):
        try:
            return v.decode('utf-8')
        except UnicodeDecodeError:
            return None
    return v


def typed(v, typ):
    # SQLite storage class is preserved independently of declared type.
    if typ in ('text', 'blob'):
        return {'type': typ, 'base64': base64.b64encode(v).decode('ascii')}
    if typ == 'real':
        return {'type': typ, 'hex': v.hex()}
    return {'type': typ, 'value': v}


def tables(con):
    # Include virtual and shadow tables where the local SQLite supports them.
    rows = con.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return [(s(r[0]), s(r[1])) for r in rows]


def table_rows(con, table):
    cols = [s(r[1]) for r in con.execute('PRAGMA table_xinfo(' + quote(table) + ')') if r[6] != 1]
    expressions = []
    for col in cols:
        expressions.extend([quote(col), 'typeof(' + quote(col) + ')'])
    for row in con.execute('SELECT ' + ','.join(expressions) + ' FROM ' + quote(table)):
        vals = [row[i * 2] for i in range(len(cols))]
        types = [s(row[i * 2 + 1]) for i in range(len(cols))]
        yield cols, vals, types


def raw_id(cols, vals, types, pkcols):
    # PK values are encoded, not exposed as metadata. If no PK use full-row digest plus occurrence index.
    positions = [cols.index(c) for c in pkcols] if pkcols and all(c in cols for c in pkcols) else list(range(len(cols)))
    key = [[cols[i], typed(vals[i], types[i])] for i in positions]
    return hashlib.sha256(json.dumps(key, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def scan(con):
    stats = {}
    for name, sql in tables(con):
        count = con.execute('SELECT count(*) FROM ' + quote(name)).fetchone()[0]
        stats[name] = count
    return stats


def decrypt_key():
    try:
        key = base64.b64decode(os.environ['UNIFIED_ENCRYPTION_KEY'], validate=True)
    except (KeyError, ValueError):
        raise ValueError('UNIFIED_ENCRYPTION_KEY must be base64 encoding of 32 bytes') from None
    if len(key) != 32:
        raise ValueError('UNIFIED_ENCRYPTION_KEY must decode to 32 bytes')
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise ValueError('cryptography is required for encrypted raw_imports; refusing plaintext fallback') from None
    return AESGCM(key)


def envelope(aes, plaintext):
    nonce = os.urandom(12)
    enc = aes.encrypt(nonce, plaintext, None)
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode('ascii')
    return 'v1.' + b64(nonce) + '.' + b64(enc)


def archive(con, source, dbpath, aes):
    # Never create schema: the gateway must have initialized the destination already.
    if not os.path.isfile(dbpath):
        raise ValueError('destination unified database does not exist; initialize it with the isolated gateway first')
    db = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(dbpath)) + '?mode=rw', uri=True, timeout=30)
    try:
        columns = [r[1] for r in db.execute('PRAGMA table_info(raw_imports)')]
        if columns != ['source', 'table_name', 'source_id', 'row_envelope']:
            raise ValueError('destination is not a unified database with raw_imports')
        db.execute('BEGIN IMMEDIATE')
        total = 0
        for table, sql in tables(con):
            info = con.execute('PRAGMA table_info(' + quote(table) + ')').fetchall()
            pk = [s(r[1]) for r in sorted((r for r in info if r[5]), key=lambda x: x[5])]
            occurrences = collections.Counter()
            for cols, vals, types in table_rows(con, table):
                identity = raw_id(cols, vals, types, pk)
                occurrences[identity] += 1
                sid = identity + ':' + str(occurrences[identity])
                payload = json.dumps({'version': 1, 'columns': [[col, typed(val, typ)] for col, val, typ in zip(cols, vals, types)]}, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
                db.execute('INSERT INTO raw_imports(source,table_name,source_id,row_envelope) VALUES(?,?,?,?) ON CONFLICT(source,table_name,source_id) DO UPDATE SET row_envelope=excluded.row_envelope', (source, table, sid, envelope(aes, payload)))
                total += 1
        db.commit()
        return total
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def rows(con, table):
    names = {name for name, _ in tables(con)}
    if table not in names:
        return []
    return [{s(k): s(row[k]) for k in row.keys()} for row in con.execute('SELECT * FROM ' + quote(table))]


def json_obj(value):
    try:
        v = json.loads(value or '{}')
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        return {}


def valid_url(value):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 0x20 for c in value): return False
    try:
        u = urllib.parse.urlsplit(value)
        return u.scheme in ('http', 'https') and bool(u.hostname) and not (u.username or u.password or u.query or u.fragment)
    except ValueError:
        return False


def plan(con, source):
    actions, skipped = [], collections.Counter()
    if source == 'portal':
        for r in rows(con, 'provider_accounts'):
            if r.get('provider') and r.get('display_name'):
                actions.append(('accounts', {'provider': r['provider'], 'displayName': r['display_name'], 'enabled': bool(r.get('desired_enabled'))}, 'portal:provider_accounts:' + str(r['id'])))
            else: skipped['account_missing_fields'] += 1
        # No safe protocol/provider inference from catalog labels; archive only.
        skipped['catalog_no_protocol'] += len(rows(con, 'model_catalog'))
        skipped['users_password_hash_not_importable'] += len(rows(con, 'users'))
    else:
        ctable = 'providerConnections' if source == '9router' else 'provider_connections'
        for r in rows(con, ctable):
            d = json_obj(r.get('data') if source == '9router' else r.get('provider_specific_data'))
            auth = r.get('authType') if source == '9router' else r.get('auth_type')
            key = d.get('apiKey') if source == '9router' else r.get('api_key')
            if auth not in ('apikey', 'api_key') or not isinstance(key, str) or not key.strip():
                skipped['connection_oauth_or_no_api_key'] += 1; continue
            if key.startswith(('v1.', 'v1:', 'enc:', 'encrypted:', 'aes:')):
                skipped['connection_encrypted_key_not_importable'] += 1; continue
            url = d.get('baseUrl')
            proto = d.get('apiType')
            if proto not in ('chat', 'responses', 'messages') or not valid_url(url):
                skipped['connection_missing_protocol_or_base_url'] += 1; continue
            name = r.get('name') or r.get('display_name') or r.get('provider')
            if not name or not r.get('provider') or len(key.encode()) > 16384:
                skipped['connection_invalid_fields'] += 1; continue
            actions.append(('connections', {'provider': r['provider'], 'name': name, 'protocol': proto, 'baseUrl': url, 'authType': 'api_key', 'credential': key, 'enabled': bool(r.get('isActive') if source == '9router' else r.get('is_active')), 'priority': r.get('priority') or 0}, source + ':' + ctable + ':' + str(r['id'])))
        kt = 'apiKeys' if source == '9router' else 'api_keys'
        for r in rows(con, kt):
            # A key with policies would silently gain privileges in unified. Never import it.
            if source == '9router':
                restricted = bool(r.get('accessRestricted'))
            else:
                restricted = True  # unified cannot preserve OmniRoute's quotas, ACLs, scopes and expiry
            key = r.get('key')
            if restricted:
                skipped['key_policy_not_supported'] += 1; continue
            if not isinstance(key, str) or not 24 <= len(key.encode()) <= 512 or not r.get('name'):
                skipped['key_missing_plaintext_or_invalid'] += 1; continue
            # Client credentials are created disabled: enabling is an explicit operator decision.
            actions.append(('keys', {'name': r['name'], 'key': key, 'enabled': False}, source + ':' + kt + ':' + str(r['id'])))
        for r in rows(con, 'combos'):
            try:
                models = json.loads(r.get('models') or 'null') if source == '9router' else json_obj(r.get('data')).get('models')
            except (ValueError, TypeError): models = None
            # Only direct list of model IDs maps without guessing semantics; complex strategies are archive-only.
            if source != '9router' or r.get('kind') not in (None, '', 'fallback') or not isinstance(models, list) or not 0 < len(models) <= 100 or not all(isinstance(x, str) and x for x in models) or not r.get('name'):
                skipped['combo_semantics_not_supported'] += 1; continue
            actions.append(('combos', {'name': r['name'], 'models': models, 'enabled': False}, source + ':combos:' + str(r['id'])))
    return actions, skipped


class API:
    def __init__(self, url):
        self.url = url.rstrip('/')
        u = urllib.parse.urlsplit(self.url)
        if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1') or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
            raise ValueError('UNIFIED_URL must be a loopback HTTP origin without path')
        self.token = None
    def call(self, method, path, obj=None):
        data = json.dumps(obj).encode() if obj is not None else None
        headers = {'Content-Type': 'application/json'}
        if self.token: headers['Authorization'] = 'Bearer ' + self.token
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            raise ValueError('unified API returned HTTP ' + str(exc.code) + ' for ' + method + ' ' + path) from None
        except urllib.error.URLError:
            raise ValueError('cannot reach unified API') from None
    def login(self):
        name = os.environ.get('UNIFIED_ADMIN_USERNAME', 'admin')
        password = os.environ.get('UNIFIED_ADMIN_PASSWORD', '')
        if not password: raise ValueError('UNIFIED_ADMIN_PASSWORD is required for API login')
        result = self.call('POST', '/api/login', {'username': name, 'password': password})
        if result.get('role') != 'admin': raise ValueError('admin login required')
        self.token = result['token']


def apply_actions(actions, api):
    # Stable, source-scoped marker in display name enables recovery after an interrupted POST.
    existing = {resource: api.call('GET', '/api/' + resource) for resource in ('accounts', 'connections', 'keys', 'models', 'combos')}
    done = collections.Counter()
    for resource, body, identity in actions:
        body = body.copy()
        marker = '[import:' + hashlib.sha256(identity.encode()).hexdigest()[:24] + ']'
        field = {'accounts':'displayName', 'connections':'name', 'keys':'name'}.get(resource)
        if field:
            body[field] = marker + ' ' + body[field]
            matches = [r for r in existing[resource] if str(r.get(field, '')).startswith(marker + ' ')]
        else:
            matches = [r for r in existing[resource] if r.get('name') == body.get('name')]
        if matches:
            done[resource + '_already_present'] += 1; continue
        result = api.call('POST', '/api/' + resource, body)
        existing[resource].append(dict(body, **result))
        done[resource + '_created'] += 1
    return done


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', choices=SOURCES)
    p.add_argument('--snapshot', required=True, help='checkpointed, private snapshot (never the live volume)')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='default; no target writes')
    mode.add_argument('--apply', action='store_true')
    p.add_argument('--unified-db', help='isolated unified SQLite DB, required with --apply')
    p.add_argument('--url', default='http://127.0.0.1:3030')
    args = p.parse_args()
    if os.path.exists(args.snapshot + '-wal') and os.path.getsize(args.snapshot + '-wal'):
        p.error('snapshot has a WAL: checkpoint it on a private copy first')
    if args.apply and not args.unified_db: p.error('--apply requires --unified-db')
    if args.apply and os.path.realpath(args.snapshot) == os.path.realpath(args.unified_db): p.error('source and destination must differ')
    try:
        con = open_source(args.snapshot)
        counts = scan(con)
        actions, skipped = plan(con, args.source)
        print('source:', args.source, 'mode:', 'apply' if args.apply else 'dry-run')
        print('tables and rows:', json.dumps(counts, sort_keys=True))
        print('archive total:', sum(counts.values()))
        print('planned API creates:', json.dumps(dict(collections.Counter(a[0] for a in actions)), sort_keys=True))
        print('archive-only / skipped mapping:', json.dumps(dict(skipped), sort_keys=True))
        if args.apply:
            aes = decrypt_key()
            api = API(args.url)
            api.login()
            archived = archive(con, args.source, args.unified_db, aes)
            print('archived rows:', archived)
            print('API results:', json.dumps(dict(apply_actions(actions, api)), sort_keys=True))
        con.close()
    except (ValueError, sqlite3.Error, OSError) as exc:
        # SQLite and OS errors can contain paths but not row contents. Never print API bodies.
        print('import failed:', str(exc), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
