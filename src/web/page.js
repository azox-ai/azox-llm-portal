import { assets } from './assets.js';

export function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AZOX LLM Portal</title>
<link rel="icon" type="image/svg+xml" href="${assets.favicon.path}">
<link rel="stylesheet" href="${assets.styles.path}">
<script>
  // Apply the saved theme before first paint so the shell never flashes.
  (function () {
    try {
      var saved = localStorage.getItem('portal-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    } catch (error) { /* storage disabled: fall back to the OS preference */ }
  })();
</script>
</head>
<body class="signed-out">
<aside class="sidebar">
  <div class="brand"><div class="brand-mark">9</div><div><strong>LLM Portal</strong><small>Account gateway</small></div></div>
  <nav id="nav"></nav>
</aside>
<div class="workspace">
  <header class="topbar"><div><span class="eyebrow">LLM PORTAL</span><h1 id="page-title">Providers</h1></div><div class="topbar-actions"><div id="theme-slot"></div><div id="session"></div></div></header>
  <main id="main"></main>
</div>
<div id="modal-root"></div>
<script type="module" src="${assets.script.path}"></script>
</body>
</html>`;
}
