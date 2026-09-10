export const styles = `
:root { --bg:#0f1216; --panel:#171b21; --line:#262d36; --fg:#e6eaef; --dim:#8b95a3;
  --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#3b82f6; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); }
header { display:flex; justify-content:space-between; align-items:center; padding:14px 24px;
  border-bottom:1px solid var(--line); background:var(--panel); }
h1 { font-size:16px; margin:0; letter-spacing:.3px; }
main { max-width:1000px; margin:0 auto; padding:24px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:20px; margin-bottom:16px; }
.card h2 { font-size:14px; margin:0 0 14px; text-transform:uppercase; letter-spacing:.6px; color:var(--dim); }
label { display:block; margin-bottom:10px; }
label span { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; }
input, select { width:100%; padding:8px 10px; background:#0d1117; color:var(--fg);
  border:1px solid var(--line); border-radius:6px; font-size:14px; }
button { padding:8px 14px; border-radius:6px; border:1px solid var(--line); background:#21262d;
  color:var(--fg); cursor:pointer; font-size:13px; }
button:hover:not(:disabled) { border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--bad); }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px;
  color:var(--dim); padding:8px 10px; border-bottom:1px solid var(--line); }
td { padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; }
tr:last-child td { border-bottom:none; }
.badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px;
  border:1px solid var(--line); background:#0d1117; }
.badge.active { color:var(--ok); border-color:var(--ok); }
.badge.disabled { color:var(--dim); }
.badge.failed, .badge.needs_reauth { color:var(--bad); border-color:var(--bad); }
.badge.partially_synced, .badge.pending { color:var(--warn); border-color:var(--warn); }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.msg { padding:10px 12px; border-radius:6px; margin-bottom:14px; font-size:13px; }
.msg.error { background:rgba(248,81,73,.12); border:1px solid var(--bad); color:var(--bad); }
.msg.ok { background:rgba(63,185,80,.12); border:1px solid var(--ok); color:var(--ok); }
.dim { color:var(--dim); font-size:12px; }
code { background:#0d1117; padding:2px 6px; border-radius:4px; font-size:12px; }
.tabs { display:flex; gap:6px; margin-bottom:16px; }
`;
