// Samaro reverse proxy (Node, no dependencies).
// Forwards every request to the bot dashboard and adds the shared secret.
const http = require('node:http');
const https = require('node:https');

const BOT_API_URL  = (process.env.BOT_API_URL || '').replace(/\/+$/, '');
const SECRET       = process.env.PROXY_SECRET || '';
const PUBLIC_HOST  = process.env.PUBLIC_HOST || '';   // the public domain of THIS proxy
const PORT         = Number(process.env.PORT || 3000);

if (!/^https?:\/\/[^/]+$/i.test(BOT_API_URL) || SECRET.length < 40 || !PUBLIC_HOST) {
  console.error('Set BOT_API_URL (e.g. http://5.39.63.207:6346), PROXY_SECRET (40+ chars) and PUBLIC_HOST.');
  process.exit(1);
}
const target = new URL(BOT_API_URL);
const client = target.protocol === 'https:' ? https : http;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function callBot(path, withSecret) {
  return new Promise(resolve => {
    const req = client.request({ hostname: target.hostname, port: target.port, path, method: 'GET', timeout: 10000,
      headers: withSecret ? { 'X-Samaro-Proxy-Secret': SECRET } : {} }, res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ error: e.code || e.message }));
    req.end();
  });
}

http.createServer(async (req, res) => {
  // Built-in checks (never forwarded to the bot)
  if (req.url === '/_proxy-health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('proxy ok'); }
  if (req.url === '/_proxy-test') {
    const a = await callBot('/health', false), b = await callBot('/health', true);
    const out = {
      reach_bot: a.error ? `FAILED (${a.error})` : `ok (HTTP ${a.status} without secret, 403 is expected)`,
      secret: b.error ? `FAILED (${b.error})` : b.status === 200 ? 'accepted (HTTP 200)' : `REJECTED (HTTP ${b.status}) - PROXY_SECRET differs from DASHBOARD_PROXY_SECRET in the bot .env, or the bot was not restarted`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out, null, 2));
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'host' && k !== 'x-samaro-proxy-secret') headers[k] = v;
  headers['host'] = PUBLIC_HOST;
  headers['x-samaro-proxy-secret'] = SECRET;
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = 'https';

  const up = client.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers, timeout: 90000 }, r => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;   // set-cookie stays an array
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', e => {
    console.error('[proxy]', e.code || e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Bot connection failed', code: e.code || e.message }));
  });
  req.pipe(up);
}).listen(PORT, () => console.log(`Samaro proxy on :${PORT} -> ${BOT_API_URL}`));
