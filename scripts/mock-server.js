const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const IMAGES_DIR = path.join(__dirname, '..', 'docs', 'images');

const mockFiles = fs.readdirSync(IMAGES_DIR)
  .filter(f => f.startsWith('mock-') && f.endsWith('.jpg'))
  .sort();

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shelly UI Redesign — Mock Preview</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e5e7eb; font-family: monospace; }
  h1 { text-align: center; padding: 24px; color: #00D4AA;
       text-shadow: 0 0 8px rgba(0,212,170,0.5); font-size: 18px; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; justify-content: center; }
  .card { background: #111; border: 1px solid #1a1a1a; border-radius: 8px;
          overflow: hidden; max-width: 420px; }
  .card img { width: 100%; display: block; cursor: pointer; }
  .card .label { padding: 8px 12px; font-size: 12px; color: #6b7280; }
  .fullscreen { display: none; position: fixed; top: 0; left: 0; width: 100vw;
                height: 100vh; background: rgba(0,0,0,0.95); z-index: 100;
                justify-content: center; align-items: center; cursor: pointer; }
  .fullscreen.active { display: flex; }
  .fullscreen img { max-width: 95vw; max-height: 95vh; object-fit: contain; }
</style>
</head>
<body>
<h1>SHELLY UI REDESIGN — MOCK PREVIEW</h1>
<div class="grid">
${mockFiles.map(f => `  <div class="card">
    <img src="/images/${f}" alt="${f}" onclick="showFull('/images/${f}')" />
    <div class="label">${f}</div>
  </div>`).join('\n')}
</div>
<div class="fullscreen" id="fs" onclick="this.classList.remove('active')">
  <img id="fsImg" />
</div>
<script>
function showFull(src) {
  document.getElementById('fsImg').src = src;
  document.getElementById('fs').classList.add('active');
}
</script>
</body>
</html>`;

// Single-pane view: one image at a time with prev/next navigation
const singleHtml = '<!DOCTYPE html>\n' +
'<html lang="ja"><head><meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>Shelly Mock — Single Pane</title>\n' +
'<style>\n' +
'* { margin:0; padding:0; box-sizing:border-box; }\n' +
'body { background:#0a0a0a; color:#e5e7eb; font-family:monospace; height:100vh; display:flex; flex-direction:column; }\n' +
'nav { display:flex; align-items:center; justify-content:center; gap:12px; padding:12px; background:#111; border-bottom:1px solid #1a1a1a; }\n' +
'nav button { background:#1a1a1a; color:#00D4AA; border:1px solid #333; border-radius:4px; padding:6px 16px; font-family:monospace; font-size:14px; cursor:pointer; }\n' +
'nav button:hover { background:#222; }\n' +
'nav .label { color:#6b7280; font-size:13px; min-width:180px; text-align:center; }\n' +
'nav .counter { color:#00D4AA; font-size:14px; font-weight:bold; text-shadow:0 0 6px rgba(0,212,170,0.5); }\n' +
'.viewer { flex:1; display:flex; align-items:center; justify-content:center; padding:8px; overflow:hidden; }\n' +
'.viewer img { max-width:100%; max-height:100%; object-fit:contain; }\n' +
'</style></head><body>\n' +
'<nav>\n' +
'  <button onclick="go(-1)">&larr; PREV</button>\n' +
'  <span class="counter" id="counter"></span>\n' +
'  <span class="label" id="name"></span>\n' +
'  <button onclick="go(1)">NEXT &rarr;</button>\n' +
'</nav>\n' +
'<div class="viewer"><img id="img" /></div>\n' +
'<script>\n' +
'var files = ' + JSON.stringify(mockFiles) + ';\n' +
'var idx = 0;\n' +
'function show() {\n' +
'  document.getElementById("img").src = "/images/" + files[idx];\n' +
'  document.getElementById("name").textContent = files[idx];\n' +
'  document.getElementById("counter").textContent = (idx+1) + " / " + files.length;\n' +
'}\n' +
'function go(d) { idx = (idx + d + files.length) % files.length; show(); }\n' +
'document.addEventListener("keydown", function(e) {\n' +
'  if (e.key === "ArrowLeft") go(-1);\n' +
'  if (e.key === "ArrowRight") go(1);\n' +
'});\n' +
'show();\n' +
'</script></body></html>';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/ui-redesign-preview') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.url === '/single' || req.url === '/ui-redesign-preview/single') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(singleHtml);
    return;
  }
  if (req.url.startsWith('/images/')) {
    const filePath = path.join(IMAGES_DIR, path.basename(req.url));
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Mock preview server running at http://localhost:' + PORT + '/ui-redesign-preview');
});
