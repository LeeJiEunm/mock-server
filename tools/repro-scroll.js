const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:18096/';
const OUT_DIR = process.argv[3] || 'docs/repro';
fs.mkdirSync(OUT_DIR, { recursive: true });

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function wsSend(ws, method, params) {
  const id = ++wsSend._id;
  return new Promise((resolve) => {
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { ws.removeEventListener('message', h); resolve(d.result || null); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.removeEventListener('message', h); resolve(null); }, 8000);
  });
}
wsSend._id = 0;

async function main() {
  const port = await getFreePort();
  const proc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=' + port, '--no-first-run', '--disable-gpu',
    '--window-size=1280,800', BASE,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let wsUrl = null;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const page = (await res.json()).find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(200);
  }
  if (!wsUrl) { console.error('Chrome not ready'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(res, 5000); });

  await wsSend(ws, 'Page.enable');
  await wsSend(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // 报告左栏高度/可滚动范围，便于选滚动位置
  const info = await wsSend(ws, 'Runtime.evaluate', {
    expression: `(function(){var b=document.querySelector('#paneLeft .pane__body'); if(!b) return {err:'no pane__body'}; return {scrollH:b.scrollHeight, clientH:b.clientHeight, totalGroupTop: (document.querySelector('.total-group')||{}).getBoundingClientRect ? document.querySelector('.total-group').getBoundingClientRect().top : null};})()`,
    returnByValue: true
  });
  console.log('INFO', JSON.stringify(info));

  const positions = [120, 250, 420];
  for (const pos of positions) {
    await wsSend(ws, 'Runtime.evaluate', {
      expression: `(function(){var b=document.querySelector('#paneLeft .pane__body'); if(b){b.scrollTop=${pos};} return b?b.scrollTop:-1;})()`,
      returnByValue: true
    });
    await sleep(400);
    const r = await wsSend(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r && r.data) {
      const f = path.join(OUT_DIR, 'scroll-' + pos + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('OK', f);
    } else console.log('FAIL', pos);
  }

  ws.close(); proc.kill();
  console.log('Done!');
}
main().catch(e => { console.error(e); process.exit(1); });
