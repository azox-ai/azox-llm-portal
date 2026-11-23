#!/usr/bin/env python3
"""Verify one snapshot against encrypted raw_imports and check API responses for credentials."""
import argparse
import base64
import collections
import importlib.util
import json
import os
import sqlite3
import sys
import urllib.parse

# Load the sibling script by path so the local name never shadows the stdlib copy module.
_spec = importlib.util.spec_from_file_location('unified_copy', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'copy.py'))
_copy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_copy)
API, decrypt_key, open_source, quote, raw_id, rows, s, tables, table_rows, typed = (
    _copy.API, _copy.decrypt_key, _copy.open_source, _copy.quote, _copy.raw_id,
    _copy.rows, _copy.s, _copy.tables, _copy.table_rows, _copy.typed)


def secret_values(con, source):
    result = set()
    def add(v):
        if isinstance(v, str) and len(v) >= 16:
            result.add(v)
    def walk(v):
        if isinstance(v, dict):
            for k, val in v.items():
                if any(x in k.lower().replace('_', '') for x in ('token', 'apikey', 'credential', 'password', 'secret')):
                    add(val)
                walk(val)
        elif isinstance(v, list):
            for item in v: walk(item)
    if source == 'portal':
        for table in ('provider_accounts', 'users', 'sessions', 'oauth_states'):
            for r in rows(con, table): walk(r)
    else:
        for table in (('providerConnections', 'apiKeys') if source == '9router' else ('provider_connections', 'api_keys')):
            for r in rows(con, table):
                walk(r)
                for field in ('key', 'data', 'provider_specific_data'):
                    v = r.get(field)
                    if field == 'key': add(v)
                    else:
                        try: walk(json.loads(v or '{}'))
                        except (ValueError, TypeError): pass
    return result


def b64(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', choices=('portal', '9router', 'omniroute'))
    p.add_argument('--snapshot', required=True)
    p.add_argument('--unified-db', required=True)
    p.add_argument('--url', default='http://127.0.0.1:3030')
    args = p.parse_args()
    try:
        if os.path.exists(args.snapshot + '-wal') and os.path.getsize(args.snapshot + '-wal'):
            raise ValueError('snapshot has a WAL; checkpoint the private copy first')
        con = open_source(args.snapshot)
        aes = decrypt_key()
        db = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(args.unified_db)) + '?mode=ro', uri=True)
        errors = 0
        for table, _ in tables(con):
            info = con.execute('PRAGMA table_info(' + quote(table) + ')').fetchall()
            pk = [s(r[1]) for r in sorted((r for r in info if r[5]), key=lambda x: x[5])]
            occurrences = collections.Counter()
            count = 0
            for cols, vals, types in table_rows(con, table):
                ident = raw_id(cols, vals, types, pk)
                occurrences[ident] += 1
                sid = ident + ':' + str(occurrences[ident])
                found = db.execute('SELECT row_envelope FROM raw_imports WHERE source=? AND table_name=? AND source_id=?', (args.source, table, sid)).fetchone()
                expected = {'version': 1, 'columns': [[c, typed(v, t)] for c, v, t in zip(cols, vals, types)]}
                try:
                    version, nonce, ciphertext = found[0].split('.') if found else ('', '', '')
                    actual = json.loads(aes.decrypt(b64(nonce), b64(ciphertext), None)) if version == 'v1' else None
                    if actual != expected: errors += 1
                except Exception:
                    errors += 1
                count += 1
            actual_count = db.execute('SELECT count(*) FROM raw_imports WHERE source=? AND table_name=?', (args.source, table)).fetchone()[0]
            if count != actual_count: errors += 1
            print('table', table, 'snapshot', count, 'archive', actual_count)
        api = API(args.url)
        api.login()
        secrets = secret_values(con, args.source)
        leaks = 0
        for endpoint in ('me', 'overview', 'admin/users', 'accounts', 'connections', 'models', 'combos', 'keys', 'usage', 'imports'):
            response = json.dumps(api.call('GET', '/api/' + endpoint), ensure_ascii=False)
            if any(secret in response for secret in secrets):
                print('credential leak detected in GET /api/' + endpoint)
                leaks += 1
        print('archive mismatches:', errors, 'GET endpoints with detected source credential:', leaks)
        print('credential checks cover values identifiable from this snapshot, not arbitrary unknown secrets')
        db.close(); con.close()
        return 1 if errors or leaks else 0
    except (ValueError, OSError, sqlite3.Error) as e:
        print('verification failed:', str(e), file=sys.stderr)
        return 1

if __name__ == '__main__': sys.exit(main())
