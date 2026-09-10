export function renderApp() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AZOX LLM Portal</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="signed-out">
<aside class="sidebar">
  <div class="brand"><div class="brand-mark">9</div><div><strong>LLM Portal</strong><small>Account gateway</small></div></div>
  <nav id="nav"></nav>
</aside>
<div class="workspace">
  <header class="topbar"><div><span class="eyebrow">LLM GATEWAY</span><h1 id="page-title">Providers</h1></div><div id="session"></div></header>
  <main id="main"></main>
</div>
<div id="modal-root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}
