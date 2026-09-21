// Visual language is lifted from the 9Router dashboard: warm brand orange
// (#E56A4A), neutral warm surfaces, a fixed left sidebar, card panels, and a
// centered modal with traffic-light close controls. Light and dark palettes
// follow the same token names 9Router uses in src/app/globals.css so the two
// products stay recognisably one family.
export const styles = `
:root{
  --brand:#E56A4A;--brand-hover:#cc5236;--brand-soft:rgba(229,106,74,.12);
  --bg:#FDFAF6;--bg-alt:#F7F3EE;--surface:#fff;--surface-2:#f4f4f5;--sidebar:#F4F1EC;
  /* Three border strengths keep light surfaces distinct without turning the
     dashboard into a heavy grid. Form controls meet the 3:1 UI boundary. */
  --border:#B7BDC6;--border-subtle:#D0D4DA;--border-strong:#8B93A0;
  --text:#0a0a0a;--muted:#6B7280;--subtle:#9CA3AF;
  --danger:#cf222e;--success:#10B981;--warning:#F59E0B;--info:#3B82F6;
  --radius:10px;--radius-lg:14px;
  --shadow-soft:0 1px 2px 0 rgba(0,0,0,.04);
  --shadow-elev:inset 0 1px 0 0 rgba(255,255,255,.8),0 1px 2px rgba(15,23,42,.04),0 12px 36px -8px rgba(15,23,42,.1);
  --shadow-warm:0 2px 12px -2px rgba(229,106,74,.18);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#1a1a1a;--bg-alt:#1F1F1E;--surface:#262626;--surface-2:#303030;--sidebar:#1e1e1e;
    --border:#333;--border-subtle:#2a2a2a;--border-strong:#52525b;
    --text:#ededed;--muted:#9ca3af;--subtle:#6b7280;
    --danger:#ef4444;--success:#22c55e;--warning:#fbbf24;--info:#60a5fa;
    --shadow-elev:inset 0 1px 0 0 rgba(255,255,255,.06),0 1px 2px rgba(0,0,0,.4),0 16px 48px -8px rgba(0,0,0,.55);
  }
}
/* Explicit choice from the theme toggle always wins over the OS preference. */
:root[data-theme="dark"]{
  --bg:#1a1a1a;--bg-alt:#1F1F1E;--surface:#262626;--surface-2:#303030;--sidebar:#1e1e1e;
  --border:#333;--border-subtle:#2a2a2a;--border-strong:#52525b;
  --text:#ededed;--muted:#9ca3af;--subtle:#6b7280;
  --danger:#ef4444;--success:#22c55e;--warning:#fbbf24;--info:#60a5fa;
  --shadow-elev:inset 0 1px 0 0 rgba(255,255,255,.06),0 1px 2px rgba(0,0,0,.4),0 16px 48px -8px rgba(0,0,0,.55);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* ---------------------------------------------------------------- shell */
.sidebar{position:fixed;inset:0 auto 0 0;width:236px;background:var(--sidebar);border-right:1px solid var(--border);padding:22px 14px;display:flex;flex-direction:column}
body.signed-out .sidebar,body.signed-out .topbar #session{display:none}
body.signed-out .workspace{margin-left:0;width:100%}
.brand{display:flex;gap:11px;align-items:center;padding:0 6px 24px}
.brand-mark{width:34px;height:34px;border-radius:var(--radius);background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:800;box-shadow:var(--shadow-warm)}
.brand strong{display:block;font-size:14px}
.brand small{display:block;color:var(--subtle);font-size:10px;letter-spacing:1.2px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;color:var(--muted);text-align:left;padding:10px 12px;border-radius:var(--radius);margin:2px 0;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.nav-item.active{background:var(--surface);color:var(--brand);box-shadow:var(--shadow-soft)}
.nav-item .ico{width:18px;text-align:center}
.sidebar-note{margin-top:auto;display:flex;align-items:center;gap:7px;color:var(--subtle);font-size:11px;padding:8px 6px}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success)}
.workspace{margin-left:236px;width:calc(100% - 236px);min-height:100vh}
.topbar{height:66px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 26px;position:sticky;top:0;z-index:5}
h1{font-size:19px;margin:2px 0 0}
.eyebrow{font-size:10px;letter-spacing:1.4px;color:var(--brand);font-weight:800}
.topbar-actions{display:flex;align-items:center;gap:14px}
#session{display:flex;gap:12px;align-items:center;font-size:12px;color:var(--muted);padding-top:4px}
#session .who{display:flex;flex-direction:column;line-height:1.25;text-align:right;padding:4px 0}
#session .who strong{color:var(--text)}
#session .who span{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--subtle)}
main{max-width:1440px;margin:0 auto;padding:30px 26px 34px}

/* ---------------------------------------------------------------- panels */
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-soft);margin-bottom:18px;overflow:hidden}
.panel.compact{max-width:520px;padding:22px}
.password-shell{display:flex;justify-content:center;padding-top:28px}
.password-panel{width:min(560px,100%);margin:0}
.password-panel .panel-head{margin:-22px -22px 20px;padding:18px 22px}
.password-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px 20px;border-bottom:1px solid var(--border-subtle);flex-wrap:wrap}
.panel-head h2{font-size:15px;margin:0}
.panel-head p{margin:3px 0 0;color:var(--muted);font-size:12px}
.toolbar,.actions{display:flex;gap:7px;flex-wrap:wrap}
.grid-cards{display:grid;grid-template-columns:repeat(2,minmax(280px,1fr));gap:14px;padding:18px}
.provider-card{border:1px solid var(--border);border-radius:var(--radius);padding:16px;background:var(--bg-alt)}
.provider-card-top{display:flex;gap:11px;align-items:center;margin-bottom:14px}
.provider-card h3{margin:0;font-size:14px}.provider-card p{margin:2px 0 0;color:var(--muted);font-size:12px}
.provider-card-meta{display:flex;gap:6px;margin-bottom:14px}.provider-card-meta span{font-size:10px;color:var(--muted);border:1px solid var(--border);background:var(--surface);padding:2px 7px;border-radius:999px}

/* ---------------------------------------------------------------- controls */
button{border:1px solid var(--border);background:var(--surface);color:var(--text);padding:8px 12px;border-radius:var(--radius);cursor:pointer;font-weight:600;font-size:12px;font-family:inherit}
button:hover:not(:disabled){border-color:var(--brand);color:var(--brand)}
button:disabled{opacity:.5;cursor:not-allowed}
.primary{background:var(--brand);color:#fff;border-color:var(--brand)}
.primary:hover:not(:disabled){background:var(--brand-hover);border-color:var(--brand-hover);color:#fff}
.ghost{background:transparent;border-color:transparent;color:var(--muted)}
.danger{color:var(--danger)}
.danger:hover:not(:disabled){border-color:var(--danger);color:var(--danger)}
.wide{width:100%;padding:11px}
label{display:block;color:var(--muted);font-size:12px;margin-bottom:13px;font-weight:600}
input,select,textarea{display:block;width:100%;border:1px solid var(--border-strong);background:var(--surface);padding:10px 11px;border-radius:var(--radius);color:var(--text);margin-top:5px;font:inherit;font-weight:400}
#quota-threshold,#user-quota-threshold{appearance:textfield;-moz-appearance:textfield}
#quota-threshold::-webkit-inner-spin-button,#quota-threshold::-webkit-outer-spin-button,#user-quota-threshold::-webkit-inner-spin-button,#user-quota-threshold::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
textarea{min-height:74px;resize:vertical}
.field-row{display:flex;gap:8px;align-items:flex-start}
.field-row input{margin-top:0}

/* ---------------------------------------------------------------- table */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 16px;color:var(--subtle);font-size:10px;letter-spacing:.7px;text-transform:uppercase;background:var(--bg-alt);font-weight:700}
td{padding:13px 16px;border-top:1px solid var(--border-subtle);vertical-align:middle}
tr:hover td{background:var(--bg-alt)}
.account-name{display:flex;gap:10px;align-items:center}
.account-name strong,.account-name h2{display:block;margin:0}
.account-name small{display:block;color:var(--muted);font-size:11px}
.account-name .quota-policy{color:var(--warning);font-weight:600}
.account-name .sponsor{display:block;color:var(--subtle);font-size:11px;margin-top:1px}
.provider-icon{width:32px;height:32px;border-radius:9px;color:#fff;display:grid;place-items:center;font-weight:800;flex:0 0 auto}
.provider-icon.claude{background:#d97757}
.provider-icon.codex{background:#10a37f}
.badge{display:inline-flex;gap:6px;align-items:center;font-size:11px;padding:3px 9px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-weight:600}
.badge i{width:6px;height:6px;background:currentColor;border-radius:50%}
.badge.active{background:rgba(16,185,129,.12);color:var(--success)}
.badge.pending,.badge.partially_synced{background:rgba(245,158,11,.14);color:var(--warning)}
.badge.failed,.badge.needs_reauth,.badge.disabled,.badge.revoked{background:rgba(207,34,46,.12);color:var(--danger)}
.empty,.quota-placeholder{padding:42px;text-align:center;color:var(--muted)}

/* ---------------------------------------------------------------- notices */
.notice,.readonly{padding:11px 14px;margin-bottom:16px;border-radius:var(--radius);background:var(--brand-soft);color:var(--brand);font-size:13px;font-weight:600}
.notice.error,.notice.bad{background:rgba(207,34,46,.1);color:var(--danger)}
.notice.ok{background:rgba(16,185,129,.12);color:var(--success)}
.readonly{display:flex;align-items:center;gap:9px;background:rgba(59,130,246,.1);color:var(--info)}
.readonly span{background:var(--info);color:#fff;border-radius:5px;padding:2px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.6px}

/* --------------------------------------------------------- connections */
.connection-count{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:4px 10px}
.connections-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:18px;background:var(--bg-alt)}
.connection-card{min-width:0;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);overflow:hidden;box-shadow:var(--shadow-soft)}
.connection-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:15px 16px;border-bottom:1px solid var(--border-subtle)}
.connection-card .account-name{min-width:0;align-items:flex-start}
.connection-card .account-name>div{min-width:0}
.connection-card h3{margin:0;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.connection-card .provider-label{display:block;color:var(--muted);font-size:12px}
.connection-card .account-name small{overflow-wrap:anywhere}
.connection-statuses{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:12px 16px;border-bottom:1px solid var(--border-subtle);background:var(--bg-alt)}
.connection-statuses>div{min-width:0}
.connection-statuses>div>span:first-child{display:block;margin-bottom:5px;color:var(--subtle);font-size:9px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}
.connection-token{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-subtle);font-size:11px}
.connection-token span{color:var(--muted)}
.connection-token strong{text-align:right;font-size:11px;overflow-wrap:anywhere}
.quota-policy-warning{margin:12px 16px 0;padding:8px 10px;border:1px solid rgba(245,158,11,.38);border-radius:var(--radius);background:rgba(245,158,11,.1);color:var(--warning);font-size:11px;font-weight:700}
.connection-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:13px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-alt)}
.connection-actions button{min-width:0;min-height:44px;padding:8px}

/* ---------------------------------------------------------------- quota */
.connection-quotas{display:flex;flex-direction:column;gap:11px;padding:13px 16px 15px}
.quota-section-title{color:var(--subtle);font-size:9px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}
.quota-hint{font-size:12px;color:var(--muted)}
.quota-meter{display:grid;grid-template-columns:1fr auto;column-gap:12px;align-items:center}
.quota-meter-head{display:contents}
.quota-meter-head>span{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700}
.quota-meter-head>span i{width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 7px currentColor}
.quota-meter.medium .quota-meter-head>span i{background:var(--warning)}
.quota-meter.low .quota-meter-head>span i{background:var(--danger)}
.quota-meter-head strong{font-size:11px;text-align:right}
.quota-meter.medium .quota-meter-head strong{color:var(--warning)}
.quota-meter.low .quota-meter-head strong{color:var(--danger)}
.quota-meter .progress{grid-column:1/-1;height:5px;border-radius:6px;background:var(--surface-2);overflow:hidden;margin:6px 0 4px}
.quota-meter .progress span{height:100%;display:block;background:var(--success)}
.quota-meter.medium .progress span{background:var(--warning)}
.quota-meter.low .progress span{background:var(--danger)}
.quota-meter small{grid-column:1/-1;color:var(--muted);font-size:10px;text-align:right}

/* ------------------------------------------------------------- sponsors */
.sponsor-group .panel-head{align-items:center}
.sponsor-count{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:3px 10px}
.sponsor-group table{table-layout:fixed;width:100%}
.sponsor-account-col{width:42%}.sponsor-provider-col{width:20%}.sponsor-state-col{width:14%}.sponsor-router-col{width:12%}

/* ---------------------------------------------------------------- modal */
.modal-overlay{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5);backdrop-filter:blur(2px)}
.modal{position:relative;width:min(560px,100%);max-height:88vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-elev)}
.modal-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border-subtle)}
.traffic{display:flex;gap:7px}
.traffic i{width:12px;height:12px;border-radius:50%;display:block}
.traffic .close{background:#FF5F56;border:0;padding:0;width:12px;height:12px;border-radius:50%;cursor:pointer}
.traffic .min{background:#FFBD2E}
.traffic .max{background:#27C93F}
.modal-title{font-weight:700;font-size:14px}
.modal-body{padding:18px}
.modal-body p{margin:0 0 10px;color:var(--muted);font-size:13px}
.modal-foot{display:flex;gap:9px;padding:0 18px 18px}
.step{border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:14px;background:var(--bg-alt)}
.step-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;margin-bottom:8px}
.step-num{width:20px;height:20px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:800}
.step-hint{color:var(--muted);font-size:12px;margin:0 0 9px}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--brand-soft);border-top-color:var(--brand);animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.waiting-row{display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-alt);font-size:13px;margin-bottom:14px}
.divider{display:flex;align-items:center;gap:10px;margin:14px 0}
.divider i{flex:1;height:1px;background:var(--border);display:block}
.divider span{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--subtle);font-weight:700}
.auth-url{display:flex;gap:8px}
.auth-url input{margin-top:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.secret-out{background:var(--bg-alt);border:1px dashed var(--brand);border-radius:var(--radius);padding:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;margin-bottom:12px}

/* ---------------------------------------------------------------- auth */
.auth-shell{min-height:calc(100vh - 66px);display:grid;place-items:center}
.auth-card{width:min(480px,100%);background:var(--surface);padding:32px;border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-elev)}
.auth-card .brand-mark{margin-bottom:14px}
.auth-card h2{font-size:23px;margin:4px 0}
.auth-card p{color:var(--muted);margin:0 0 22px;font-size:13px}
.login-form{margin-top:16px}
.theme-toggle{display:inline-flex;align-items:center;gap:6px;padding:7px 11px}
.theme-toggle .ico{font-size:13px;line-height:1}
.login-error{margin:0 0 13px}
.login-actions{display:grid;grid-template-columns:2fr 1fr;gap:8px}
.login-actions button{width:100%;padding:11px}
.form-hint{margin:12px 0 0!important;font-size:11px!important;text-align:center}
.row-sub{display:block;color:var(--muted);font-size:10px;margin-top:2px}
.create-user{display:grid;grid-template-columns:1fr 1.4fr 120px auto;gap:10px;padding:16px 20px;align-items:end}
.create-user label{margin-bottom:0}
.settings-form{display:grid;grid-template-columns:minmax(220px,360px) auto;gap:10px;padding:16px 20px;align-items:end}
.settings-form label{margin-bottom:0}
.settings-form button{height:40px}
.quota-settings-form{display:grid;grid-template-columns:minmax(250px,1.4fr) minmax(160px,.6fr) minmax(250px,1.4fr) auto;gap:14px;padding:16px 20px;align-items:end}
.quota-settings-form>label{margin-bottom:0}
.quota-settings-form>button{height:40px}
.check-setting{display:flex;align-items:center;gap:10px;min-height:40px}
.check-setting input{width:18px;height:18px;margin:0;flex:0 0 auto}
.check-setting span,.check-setting b,.check-setting small{display:block}
.check-setting b{color:var(--text);font-size:12px}
.check-setting small{color:var(--muted);font-size:10px;font-weight:400}
.title-with-badge{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.policy-source{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:800}
.policy-source.admin{background:rgba(59,130,246,.12);color:var(--info)}
.policy-source.user{background:var(--brand-soft);color:var(--brand)}
.policy-actions{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}
.policy-actions button{min-height:44px}
.role-select{width:110px;margin:0;padding:8px 10px}
.pagination{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:14px 18px;border-top:1px solid var(--border-subtle);color:var(--muted);font-size:12px}

@media(max-width:860px){
  .sidebar{width:66px;padding:18px 8px}
  .brand>div:last-child,.sidebar-note span:last-child{display:none}
  .brand{padding:0 8px 20px}
  .nav-item{justify-content:center;font-size:0;gap:0}
  .nav-item .ico{font-size:15px}
  .workspace{margin-left:66px;width:calc(100% - 66px)}
  .topbar{padding:0 14px}
  main{padding:14px}
  .create-user{grid-template-columns:1fr}
  .settings-form,.quota-settings-form,.grid-cards{grid-template-columns:1fr}
  .actions{min-width:240px}
}
@media(max-width:1120px){
  .connections-grid{grid-template-columns:1fr}
}
@media(max-width:620px){
  .connection-statuses{grid-template-columns:1fr}
  .connection-token{align-items:flex-start;flex-direction:column;gap:3px}
  .connection-token strong{text-align:left}
  .connection-actions{grid-template-columns:repeat(2,minmax(0,1fr))}
  .policy-actions{display:grid;grid-template-columns:1fr;width:100%}
}
`;
