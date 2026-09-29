// Ponto de entrada do Passenger (cPanel → Setup Node.js App).
// Serve a app, regista os aparelhos que a abrem e dá a página /admin (palavra-passe em ADMIN_PASSWORD).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FICHEIRO_DADOS = path.join(DATA_DIR, 'aparelhos.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_APARELHOS = 1000;
const SESSAO_MS = 12 * 3600e3;

const HTML = 'text/html; charset=utf-8';
const PNG = 'image/png';
// Lista fechada: só estes caminhos existem.
const FICHEIROS = {
  '/': ['index.html', HTML],
  '/index.html': ['index.html', HTML],
  '/admin': ['admin.html', HTML],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-180.png': ['icon-180.png', PNG],
  '/icon-192.png': ['icon-192.png', PNG],
  '/icon-512.png': ['icon-512.png', PNG],
};

/* ---------- dados ---------- */
const PESSOAS_BASE = ['Sofia', 'Leonor', 'Francisco'];
let db = { config: { aprovacao: false }, aparelhos: {}, pessoas: PESSOAS_BASE.slice() };
try {
  const j = JSON.parse(fs.readFileSync(FICHEIRO_DADOS, 'utf8'));
  if (j && typeof j === 'object') {
    db = { config: { aprovacao: !!(j.config && j.config.aprovacao) }, aparelhos: j.aparelhos && typeof j.aparelhos === 'object' ? j.aparelhos : {},
      pessoas: Array.isArray(j.pessoas) && j.pessoas.length === 3 ? j.pessoas.map((n, i) => String(n).slice(0, 20) || PESSOAS_BASE[i]) : PESSOAS_BASE.slice() };
  }
} catch (e) { /* primeira execução */ }

function gravar() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FICHEIRO_DADOS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FICHEIRO_DADOS);
}

/* ---------- utilitários ---------- */
const ID_OK = /^[A-Za-z0-9-]{8,64}$/;
const limpa = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function plataformaDe(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone/iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return 'Computador';
  return 'Outro';
}

function ipDe(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}

const limites = new Map();
function excede(chave, max, janelaMs, conta = true) {
  const agora = Date.now();
  let l = limites.get(chave);
  if (!l || l.fim < agora) { l = { n: 0, fim: agora + janelaMs }; limites.set(chave, l); }
  if (conta) l.n++;
  if (limites.size > 5000) for (const [k, v] of limites) if (v.fim < agora) limites.delete(k);
  return l.n > max;
}

function json(res, codigo, corpo, extra = {}) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > 4096) { reject(new Error('grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ---------- sessões de admin ---------- */
const sessoes = new Map();
function cookieDe(req, nome) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(nome + '='));
  return m ? m.slice(nome.length + 1) : '';
}
function adminAutenticado(req) {
  const t = cookieDe(req, 'tp_admin');
  const fim = t && sessoes.get(t);
  if (!fim) return false;
  if (fim < Date.now()) { sessoes.delete(t); return false; }
  return true;
}

/* ---------- API pública: o aparelho apresenta-se ---------- */
async function hello(req, res) {
  if (excede('hello:' + ipDe(req), 120, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  if (typeof b.id !== 'string' || !ID_OK.test(b.id)) return json(res, 400, { erro: 'Identificador inválido.' });
  const pessoa = limpa(b.pessoa, 20);
  const instalada = b.instalada === true;
  const plataforma = plataformaDe(String(req.headers['user-agent'] || ''));
  const agora = Date.now();
  let a = db.aparelhos[b.id];
  if (!a) {
    if (Object.keys(db.aparelhos).length >= MAX_APARELHOS) return json(res, 200, { status: 'ativo' });
    a = db.aparelhos[b.id] = { id: b.id, primeiro: agora, ultimo: agora, visitas: 1, pessoa, plataforma, instalada, etiqueta: '', status: db.config.aprovacao ? 'pendente' : 'ativo' };
    gravar();
  } else {
    const novaVisita = agora - a.ultimo > 30 * 60e3;
    const mudou = a.pessoa !== pessoa || a.instalada !== instalada || a.plataforma !== plataforma;
    if (novaVisita || mudou || agora - a.ultimo > 60e3) {
      if (novaVisita) a.visitas++;
      Object.assign(a, { ultimo: agora, pessoa, instalada, plataforma });
      gravar();
    }
  }
  json(res, 200, { status: a.status, pessoas: db.pessoas });
}

/* ---------- API pública: mudar o nome de uma pessoa (vale para todos) ---------- */
async function mudarPessoa(req, res) {
  if (excede('pessoas:' + ipDe(req), 30, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  const a = typeof b.id === 'string' && db.aparelhos[b.id];
  if (!a || a.status !== 'ativo') return json(res, 403, { erro: 'Aparelho sem acesso.' });
  const nome = limpa(b.nome, 20);
  if (!Number.isInteger(b.i) || b.i < 0 || b.i > 2 || !nome) return json(res, 400, { erro: 'Nome inválido.' });
  db.pessoas[b.i] = nome; gravar();
  json(res, 200, { pessoas: db.pessoas });
}

/* ---------- API de admin ---------- */
async function admin(req, res, rota) {
  if (!ADMIN_PASSWORD) return json(res, 503, { erro: 'Falta definir ADMIN_PASSWORD no servidor.' });
  if (rota === '/api/admin/login' && req.method === 'POST') {
    const ip = ipDe(req);
    if (excede('login:' + ip, 8, 15 * 60e3, false)) return json(res, 429, { erro: 'Demasiadas tentativas. Espera 15 minutos.' });
    let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
    const ok = typeof b.password === 'string' && crypto.timingSafeEqual(sha(b.password), sha(ADMIN_PASSWORD));
    if (!ok) { excede('login:' + ip, 8, 15 * 60e3, true); return json(res, 401, { erro: 'Palavra-passe errada.' }); }
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, Date.now() + SESSAO_MS);
    const seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return json(res, 200, { ok: true }, { 'Set-Cookie': `tp_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}${seguro}` });
  }
  if (!adminAutenticado(req)) return json(res, 401, { erro: 'Sem sessão.' });
  if (req.method === 'POST' && req.headers['x-requested-with'] !== 'fetch') return json(res, 403, { erro: 'Pedido recusado.' });

  if (rota === '/api/admin/logout' && req.method === 'POST') {
    sessoes.delete(cookieDe(req, 'tp_admin'));
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'tp_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (rota === '/api/admin/dados' && req.method === 'GET') {
    return json(res, 200, { agora: Date.now(), config: db.config, aparelhos: Object.values(db.aparelhos).sort((x, y) => y.ultimo - x.ultimo) });
  }
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  if (rota === '/api/admin/config' && req.method === 'POST') {
    db.config.aprovacao = b.aprovacao === true; gravar();
    return json(res, 200, { config: db.config });
  }
  if (rota === '/api/admin/aparelho' && req.method === 'POST') {
    const a = typeof b.id === 'string' && db.aparelhos[b.id];
    if (!a) return json(res, 404, { erro: 'Aparelho não encontrado.' });
    if (b.acao === 'aprovar' || b.acao === 'desbloquear') a.status = 'ativo';
    else if (b.acao === 'bloquear') a.status = 'bloqueado';
    else if (b.acao === 'etiqueta') a.etiqueta = limpa(b.valor, 40);
    else if (b.acao === 'apagar') delete db.aparelhos[b.id];
    else return json(res, 400, { erro: 'Ação desconhecida.' });
    gravar();
    return json(res, 200, { ok: true });
  }
  json(res, 404, { erro: 'Não encontrado.' });
}

/* ---------- servidor ---------- */
const servidor = http.createServer((req, res) => {
  const caminho = req.url.split('?')[0];
  if (caminho === '/api/hello' && req.method === 'POST') return hello(req, res).catch(() => json(res, 500, { erro: 'Erro interno.' }));
  if (caminho === '/api/pessoas' && req.method === 'POST') return mudarPessoa(req, res).catch(() => json(res, 500, { erro: 'Erro interno.' }));
  if (caminho.startsWith('/api/admin/')) return admin(req, res, caminho).catch(() => json(res, 500, { erro: 'Erro interno.' }));
  if (caminho.startsWith('/api/')) return json(res, 404, { erro: 'Não encontrado.' });

  const entrada = FICHEIROS[caminho];
  if (!entrada || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  fs.readFile(path.join(__dirname, entrada[0]), (err, conteudo) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Erro interno');
    }
    res.writeHead(200, {
      'Content-Type': entrada[1],
      'Cache-Control': entrada[1] === PNG ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(caminho === '/admin' ? { 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : conteudo);
  });
});

module.exports = servidor;
// Sob o Passenger, PORT pode ser um socket; em local cai para 3100.
if (!process.env.TESTE) servidor.listen(process.env.PORT || 3100);
