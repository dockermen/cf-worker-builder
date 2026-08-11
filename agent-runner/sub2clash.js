/**
 * 订阅转 Clash YAML（mihomo 可用）
 *
 * 支持输入：
 *   1. 标准 Clash YAML（含 proxies 节点）→ 原样通过（仅补 mixed-port）
 *   2. base64 编码的多协议节点列表（vless:// vmess:// hysteria2:// ss:// trojan:// socks:// 等，每行一个）
 *
 * 用法：node sub2clash.js <订阅文件> > clash-config.yaml
 * stderr 输出统计与警告（不输出敏感字段）。
 */

import { readFileSync } from 'node:fs';

const inputFile = process.argv[2];
let raw = readFileSync(inputFile, 'utf-8');

// ---------- 1. 尝试 base64 解码（宽容：去掉非 base64 字符） ----------
function tryBase64Decode(text) {
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!cleaned || cleaned.length < 40) return null;
  try {
    const pad = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
    const decoded = Buffer.from(pad, 'base64').toString('utf-8');
    // 解码结果应可读（含 URI 协议前缀）
    if (/^(vless|vmess|hysteria2|ss|trojan|socks|ssr):\/\//m.test(decoded)) return decoded;
  } catch { /* ignore */ }
  return null;
}

let content = raw;
if (/^proxies:/m.test(raw) || /^mixed-port:/m.test(raw) || /^port:/m.test(raw)) {
  // 已经是 clash yaml：补 mixed-port 后原样输出
  if (!/^mixed-port:/m.test(content)) content = 'mixed-port: 7890\n' + content;
  process.stderr.write(`[sub2clash] 已识别为标准 Clash YAML（原样使用）\n`);
  process.stdout.write(content);
  process.exit(0);
}
const decoded = tryBase64Decode(raw);
if (decoded) {
  content = decoded;
  process.stderr.write(`[sub2clash] 订阅为 base64 编码，已解码\n`);
}

// ---------- 2. 解析各协议 URI ----------
const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
const proxies = [];
const nameSeen = new Set();
let idx = 0;

function uniqName(name) {
  let n = String(name || '').trim() || `Node${proxies.length + 1}`;
  n = decodeURIComponentSafe(n).replace(/[\u0000-\u001f]/g, '').slice(0, 40);
  if (nameSeen.has(n)) n = `${n}-${++idx}`;
  nameSeen.add(n);
  return n;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseVless(line) {
  // vless://uuid@host:port?params#name
  const m = line.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.+))?$/i);
  if (!m) return null;
  const [, uuid, server, port, q, name] = m;
  const p = new URLSearchParams(q || '');
  const security = p.get('security') || 'none';
  const network = p.get('type') || 'tcp';
  const node = {
    name: uniqName(name),
    type: 'vless',
    server,
    port: Number(port),
    uuid,
    udp: true,
    network,
  };
  if (security === 'tls' || security === 'reality') {
    node.tls = true;
    if (p.get('sni')) node.servername = p.get('sni');
    if (p.get('fp')) node['client-fingerprint'] = p.get('fp');
    if (p.get('flow')) node.flow = p.get('flow');
  }
  if (security === 'reality') {
    node['reality-opts'] = {};
    if (p.get('pbk')) node['reality-opts']['public-key'] = p.get('pbk');
    if (p.get('sid')) node['reality-opts']['short-id'] = p.get('sid');
    if (p.get('spx')) node['reality-opts']['spider-x'] = p.get('spx');
  }
  if (network === 'ws' && p.get('path')) {
    node['ws-opts'] = { path: p.get('path') };
    if (p.get('host')) node['ws-opts'].headers = { Host: p.get('host') };
  }
  if (network === 'grpc' && p.get('serviceName')) {
    node['grpc-opts'] = { 'grpc-service-name': p.get('serviceName') };
  }
  if (network === 'http') {
    node['http-opts'] = {};
    if (p.get('path')) node['http-opts'].path = [p.get('path')];
    if (p.get('host')) node['http-opts'].headers = { Host: p.get('host') };
  }
  return node;
}

function parseVmess(line) {
  // vmess://base64(json)
  const b64 = line.slice('vmess://'.length).split('#')[0];
  let obj;
  try {
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    obj = JSON.parse(Buffer.from(pad, 'base64').toString('utf-8'));
  } catch { return null; }
  const network = obj.net || 'tcp';
  const node = {
    name: uniqName(obj.ps),
    type: 'vmess',
    server: obj.add,
    port: Number(obj.port),
    uuid: obj.id,
    alterId: Number(obj.aid || 0),
    cipher: obj.scy || 'auto',
    udp: true,
    network,
  };
  if (obj.tls === 'tls' || obj.tls === true) {
    node.tls = true;
    if (obj.sni) node.servername = obj.sni;
  }
  if (network === 'ws' && obj.path) {
    node['ws-opts'] = { path: obj.path };
    if (obj.host) node['ws-opts'].headers = { Host: obj.host };
  }
  if (network === 'grpc' && obj.path) {
    node['grpc-opts'] = { 'grpc-service-name': obj.path.replace(/^\//, '') };
  }
  return node;
}

function parseHysteria2(line) {
  // hysteria2://auth@host:port?params#name
  const m = line.match(/^hysteria2:\/\/([^@]*)@(\[[^\]]+\]|[^:/?#]+):(\d+)(\?[^#]*)?(?:#(.+))?$/i);
  if (!m) return null;
  const [, auth, server, port, q, name] = m;
  const p = new URLSearchParams(q || '');
  return {
    name: uniqName(name),
    type: 'hysteria2',
    server,
    port: Number(port),
    password: auth ? decodeURIComponentSafe(auth) : '',
    sni: p.get('sni') || '',
    'skip-cert-verify': p.get('insecure') === '1' || p.get('insecure') === 'true',
  };
}

function parseSs(line) {
  // ss://base64(method:pass)@host:port#name 或 ss://method:pass@host:port#name
  const m = line.match(/^ss:\/\/([^@]+)@([^:/?#]+):(\d+)(?:#(.+))?$/i);
  if (!m) return null;
  let [method, pass] = ['', ''];
  const cred = m[1];
  try {
    const pad = cred + '='.repeat((4 - (cred.length % 4)) % 4);
    const dec = Buffer.from(pad, 'base64').toString('utf-8');
    if (dec.includes(':')) [method, pass] = dec.split(':', 2);
  } catch { /* ignore */ }
  if (!method) {
    const colon = cred.indexOf(':');
    if (colon > 0) { method = cred.slice(0, colon); pass = cred.slice(colon + 1); }
  }
  return {
    name: uniqName(m[4]),
    type: 'ss',
    server: m[2],
    port: Number(m[3]),
    cipher: method,
    password: pass,
    udp: true,
  };
}

function parseTrojan(line) {
  const m = line.match(/^trojan:\/\/([^@]+)@([^:/?#]+):(\d+)(\?[^#]*)?(?:#(.+))?$/i);
  if (!m) return null;
  const p = new URLSearchParams(m[4] || '');
  const node = {
    name: uniqName(m[5]),
    type: 'trojan',
    server: m[2],
    port: Number(m[3]),
    password: decodeURIComponentSafe(m[1]),
    udp: true,
  };
  if (p.get('sni')) { node.tls = true; node.servername = p.get('sni'); }
  else if (p.get('security') === 'tls') node.tls = true;
  return node;
}

function parseSocks(line) {
  const m = line.match(/^socks5?:\/\/([^@]*)@([^:/?#]+):(\d+)(?:#(.+))?$/i) || line.match(/^socks5?:\/\/([^:/?#]+):(\d+)(?:#(.+))?$/i);
  if (!m) return null;
  const userinfo = m[1] || '';
  const sep = userinfo.indexOf(':');
  return {
    name: uniqName(m[3] || m[2] || 'socks'),
    type: 'socks5',
    server: m[2] || m[1],
    port: Number(m[3] || m[2]),
    username: sep > 0 ? decodeURIComponentSafe(userinfo.slice(0, sep)) : undefined,
    password: sep > 0 ? decodeURIComponentSafe(userinfo.slice(sep + 1)) : undefined,
    udp: true,
  };
}

for (const line of lines) {
  let node = null;
  if (line.startsWith('vless://')) node = parseVless(line);
  else if (line.startsWith('vmess://')) node = parseVmess(line);
  else if (line.startsWith('hysteria2://')) node = parseHysteria2(line);
  else if (line.startsWith('ss://')) node = parseSs(line);
  else if (line.startsWith('trojan://')) node = parseTrojan(line);
  else if (/^socks5?:\/\//i.test(line)) node = parseSocks(line);
  if (node) proxies.push(node);
  else if (line) process.stderr.write(`[sub2clash] 跳过无法识别的行: ${line.slice(0, 60)}...\n`);
}

if (!proxies.length) {
  process.stderr.write('[sub2clash] ❌ 未解析到任何可用节点\n');
  process.exit(2);
}

// ---------- 3. 生成 Clash YAML ----------
const names = proxies.map((n) => n.name);
const linesOut = [];
linesOut.push('mixed-port: 7890');
linesOut.push('allow-lan: false');
linesOut.push('mode: rule');
linesOut.push('log-level: warning');
linesOut.push('proxies:');
for (const n of proxies) {
  linesOut.push(`  - name: "${n.name}"`);
  linesOut.push(`    type: ${n.type}`);
  // IPv6 地址必须加引号（含冒号，否则 YAML 解析报错）
  let serverVal = n.server;
  if (serverVal.includes(':')) {
    serverVal = serverVal.startsWith('[') ? `"${serverVal}"` : `"[${serverVal}]"`;
  }
  linesOut.push(`    server: ${serverVal}`);
  linesOut.push(`    port: ${n.port}`);
  for (const [k, v] of Object.entries(n)) {
    if (['name', 'type', 'server', 'port'].includes(k)) continue;
    if (v === undefined) continue;
    if (typeof v === 'boolean') linesOut.push(`    ${k}: ${v}`);
    else if (typeof v === 'object') linesOut.push(`    ${k}: ${JSON.stringify(v)}`);
    else linesOut.push(`    ${k}: "${String(v).replace(/"/g, '\\"')}"`);
  }
}
linesOut.push('proxy-groups:');
linesOut.push(`  - name: "PROXY"`);
linesOut.push(`    type: url-test`);
linesOut.push('    url: http://www.gstatic.com/generate_204');
linesOut.push('    interval: 60');
linesOut.push('    tolerance: 50');
linesOut.push('    proxies:');
for (const nm of names) linesOut.push(`      - "${nm}"`);
linesOut.push('rules:');
linesOut.push('  - MATCH,PROXY');
process.stdout.write(linesOut.join('\n') + '\n');
process.stderr.write(`[sub2clash] ✅ 生成 ${proxies.length} 个节点\n`);
