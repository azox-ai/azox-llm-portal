export function renderApp() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AZOX Sponsor Portal</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header>
  <h1>Sponsor Portal</h1>
  <div id="session"></div>
</header>
<main id="main"></main>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}
