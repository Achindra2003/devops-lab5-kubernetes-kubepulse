// KubePulse dashboard: every request goes through the Kubernetes Service,
// so the table below shows real load balancing across Pods and live version changes.
const $ = (id) => document.getElementById(id);
let pods = {};
let total = 0;
let failed = 0;
let loadWorkers = 0;
const LOAD_CONCURRENCY = 6;

const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const msg = (t) => { $('msg').textContent = t; };

async function hit(path = '/api/info', opts) {
  total++;
  try {
    const res = await fetch(path, { cache: 'no-store', ...opts });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    failed++;
    return null;
  }
}

function record(d) {
  if (!d) return;
  const p = (pods[d.pod] ||= { node: d.node, version: d.version, count: 0 });
  p.count++;
  p.version = d.version;
  p.node = d.node;
  $('lastPod').textContent = d.pod;
}

function cell(tr, text, cls) {
  const td = tr.insertCell();
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function render() {
  const names = Object.keys(pods).sort();
  const sum = names.reduce((n, k) => n + pods[k].count, 0) || 1;
  const versions = [...new Set(names.map((k) => pods[k].version))];
  $('version').textContent = versions.length > 1 ? `${versions.join(' + ')} (rolling)` : versions[0] || '—';
  $('podCount').textContent = names.length;
  $('total').textContent = total;
  $('failed').textContent = failed;
  $('failed').classList.toggle('bad', failed > 0);

  const tbody = $('pods');
  tbody.replaceChildren();
  for (const name of names) {
    const p = pods[name];
    const tr = tbody.insertRow();
    cell(tr, name, 'pod');
    cell(tr, p.node || 'n/a');
    const v = cell(tr, '');
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = p.version;
    pill.style.background = `hsl(${hue(p.version)} 55% 40%)`;
    v.append(pill);
    cell(tr, p.count);
    const share = cell(tr, '');
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${Math.round((p.count / sum) * 100)}%`;
    share.append(bar);
  }
}

async function poll() {
  record(await hit());
  render();
  setTimeout(poll, 400);
}

async function chaos(action) {
  const d = await hit(`/api/chaos/${action}`, { method: 'POST' });
  msg(d ? `Pod ${d.pod}: ${d.action}` : 'Chaos endpoint unavailable (CHAOS_ENABLED=false or no pod responded).');
}

$('burst').onclick = async () => {
  msg('Sending 100 requests…');
  const results = await Promise.all(Array.from({ length: 100 }, () => hit()));
  results.forEach(record);
  msg(`Done — ${results.filter(Boolean).length}/100 succeeded.`);
};

$('load').onclick = () => {
  const btn = $('load');
  if (loadWorkers) { loadWorkers = 0; btn.classList.remove('on'); btn.textContent = 'Start CPU load (HPA)'; return; }
  loadWorkers = LOAD_CONCURRENCY;
  btn.classList.add('on');
  btn.textContent = 'Stop CPU load';
  msg('Burning CPU through the Service. Watch: kubectl -n kubepulse get hpa -w');
  for (let i = 0; i < LOAD_CONCURRENCY; i++) {
    (async () => { while (loadWorkers) await hit('/api/load?ms=400'); })();
  }
};

$('unready').onclick = () => chaos('unready');
$('crash').onclick = () => chaos('crash');
$('reset').onclick = () => { pods = {}; total = 0; failed = 0; render(); };

poll();
