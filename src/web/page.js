export function renderApp() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AZOX LLM Portal</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<aside>
  <div class="brand"><div class="brand-mark">A</div><div><strong>LLM Portal</strong><small>AZOX AI</small></div></div>
  <nav id="nav"></nav>
  <div class="aside-foot">Portal owns canonical credentials</div>
</aside>
<div class="workspace">
<header><div><span class="eyebrow">LLM GATEWAY</span><h1>Account Operations</h1></div><div id="session"></div></header>
<main id="main"></main>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}
