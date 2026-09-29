// Ponto de entrada do Passenger (cPanel → Setup Node.js App).
// Serve a app, regista os aparelhos que a abrem e dá a página /admin (palavra-passe em ADMIN_PASSWORD).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FICHEIRO_DADOS = path.join(DATA_DIR, 'aparelhos.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const MAX_APARELHOS = 1000;
const MAX_HISTORICO = 200;
const SESSAO_MS = 12 * 3600e3;

const HTML = 'text/html; charset=utf-8';
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
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
let db = { config: { aprovacao: false }, aparelhos: {}, pessoas: PESSOAS_BASE.slice(), estado: null, versao: 0, historico: [] };
let estadoCru = null;
try {
  const j = JSON.parse(fs.readFileSync(FICHEIRO_DADOS, 'utf8'));
  if (j && typeof j === 'object') {
    db = { config: { aprovacao: !!(j.config && j.config.aprovacao) }, aparelhos: j.aparelhos && typeof j.aparelhos === 'object' ? j.aparelhos : {},
      pessoas: Array.isArray(j.pessoas) && j.pessoas.length === 3 ? j.pessoas.map((n, i) => String(n).slice(0, 20) || PESSOAS_BASE[i]) : PESSOAS_BASE.slice(), estado: null, versao: Number.isInteger(j.versao) ? j.versao : 0,
      historico: Array.isArray(j.historico) ? j.historico.filter((h) => h && typeof h.t === 'number' && typeof h.texto === 'string').slice(0, MAX_HISTORICO) : [] };
    estadoCru = j.estado;
  }
} catch (e) { /* primeira execução */ }

function gravar() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FICHEIRO_DADOS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FICHEIRO_DADOS);
  copiaDiaria();
}

// Tudo vive neste ficheiro: guarda uma cópia por dia (a última do dia) e mantém as 14 mais recentes.
function copiaDiaria() {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.copyFileSync(FICHEIRO_DADOS, path.join(BACKUPS_DIR, `aparelhos-${new Date().toISOString().slice(0, 10)}.json`));
    const todas = fs.readdirSync(BACKUPS_DIR).filter((f) => /^aparelhos-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of todas.slice(0, Math.max(0, todas.length - 14))) fs.unlinkSync(path.join(BACKUPS_DIR, f));
  } catch (e) { /* a cópia nunca pode impedir a gravação */ }
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

function registar(aparelho, texto) {
  const quem = (aparelho && (aparelho.etiqueta || aparelho.pessoa)) || 'Alguém';
  db.historico.unshift({ t: Date.now(), quem, texto: limpa(texto, 160) });
  if (db.historico.length > MAX_HISTORICO) db.historico.length = MAX_HISTORICO;
}

function lerCorpo(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > max) { reject(new Error('grande')); req.destroy(); } else partes.push(c); });
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
  registar(a, `mudou o nome da pessoa ${b.i + 1} para «${nome}»`);
  db.pessoas[b.i] = nome; db.versao++; gravar();
  json(res, 200, { pessoas: db.pessoas, versao: db.versao });
}

/* ---------- API pública: estado partilhado (tarefas, marcações, trocas, definições) ---------- */
const REPETICOES = ['daily', 'w2', 'w1', 'need', 'wday', 'once'];
const QUEM = ['rota', 'quartos', 'todos', 'rodar', 0, 1, 2];
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MES_ISO = /^\d{4}-\d{2}$/;

function tarefaLimpa(t) {
  if (!t || typeof t !== 'object') return null;
  const id = typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(t.id) ? t.id : null;
  const title = limpa(t.title, 120), room = limpa(t.room, 40);
  if (!id || !title || !room || !REPETICOES.includes(t.repeat) || !QUEM.includes(t.who)) return null;
  return {
    id, title, room, repeat: t.repeat, who: t.who, note: limpa(t.note, 200), active: t.active !== false,
    date: DATA_ISO.test(t.date || '') ? t.date : '', weekday: Number.isInteger(t.weekday) && t.weekday >= 0 && t.weekday <= 6 ? t.weekday : 0,
  };
}

function estadoLimpo(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.tasks) || e.tasks.length > 200) return null;
  const tasks = e.tasks.map(tarefaLimpa);
  if (tasks.some((t) => !t) || !DATA_ISO.test(e.anchor || '') || !MES_ISO.test(e.roomsBase || '')) return null;
  const done = {}; let n = 0;
  for (const k of Object.keys(e.done && typeof e.done === 'object' ? e.done : {})) {
    if (k.length > 200) continue;
    if (++n > 20000) return null;
    done[k] = 1;
  }
  const ov = {};
  for (const [k, v] of Object.entries(e.ov && typeof e.ov === 'object' ? e.ov : {})) if (k.length <= 100 && Number.isInteger(v) && v >= 0 && v <= 2) ov[k] = v;
  return { tasks, done, ov, anchor: e.anchor, roomsBase: e.roomsBase, trashOn: e.trashOn !== false };
}

// As marcações levam a data (ou a segunda-feira da semana) no 2.º segmento; as com mais de 150 dias saem.
function podarMarcacoes() {
  const limite = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(db.estado.done)) { const d = k.split('|')[1]; if (DATA_ISO.test(d || '') && d < limite) delete db.estado.done[k]; }
}

async function estadoApi(req, res) {
  if (excede('estado:' + ipDe(req), 300, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
  let b;
  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    b = { id: q.get('id'), v: Number(q.get('v')) };
  } else {
    try { b = await lerCorpo(req, 262144); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  }
  const a = typeof b.id === 'string' && db.aparelhos[b.id];
  if (!a || a.status !== 'ativo') return json(res, 403, { erro: 'Aparelho sem acesso.' });
  const base = { versao: db.versao, pessoas: db.pessoas };
  if (req.method === 'GET') {
    if (!db.estado) return json(res, 200, { ...base, estado: null });
    return json(res, 200, b.v === db.versao ? { ...base, igual: true } : { ...base, estado: db.estado });
  }
  const titulo = (e, id) => (id === 'lixo' ? 'Levar o lixo' : ((e && e.tasks.find((t) => t.id === id)) || {}).title || 'tarefa');
  if (b.op === 'iniciar' || b.op === 'substituir') {
    if (b.op === 'iniciar' && db.estado) return json(res, 409, { ...base, erro: 'Já existe estado.' });
    const novo = estadoLimpo(b.estado);
    if (!novo) return json(res, 400, { erro: 'Estado inválido.' });
    db.estado = novo;
    registar(a, b.op === 'iniciar' ? 'lançou os dados iniciais' : 'substituiu todos os dados');
  } else {
    const e = db.estado;
    if (!e) return json(res, 409, { ...base, erro: 'Sem estado.' });
    if (b.op === 'marcar' && typeof b.chave === 'string' && b.chave && b.chave.length <= 200 && typeof b.valor === 'boolean') {
      if (b.valor) e.done[b.chave] = 1; else delete e.done[b.chave];
      podarMarcacoes();
      registar(a, `${b.valor ? 'marcou' : 'desmarcou'} «${titulo(e, b.chave.split('|')[0])}»`);
    } else if (b.op === 'limpar') { e.done = {}; registar(a, 'limpou todas as marcações'); }
    else if (b.op === 'troca' && typeof b.chave === 'string' && b.chave && b.chave.length <= 100 && (b.valor === null || (Number.isInteger(b.valor) && b.valor >= 0 && b.valor <= 2))) {
      if (b.valor === null) delete e.ov[b.chave]; else e.ov[b.chave] = b.valor;
      const alvo = b.chave.startsWith('lixo|') ? 'o lixo de ' + b.chave.slice(5) : b.chave.split('|')[1];
      registar(a, b.valor === null ? `repôs o responsável de ${alvo}` : `passou ${alvo} para ${db.pessoas[b.valor]}`);
    } else if (b.op === 'tarefa') {
      const t = tarefaLimpa(b.tarefa);
      if (!t) return json(res, 400, { erro: 'Tarefa inválida.' });
      const i = e.tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) e.tasks[i] = t; else if (e.tasks.length >= 200) return json(res, 400, { erro: 'Demasiadas tarefas.' }); else e.tasks.push(t);
      registar(a, `${i >= 0 ? 'editou' : 'criou'} a tarefa «${t.title}»`);
    } else if (b.op === 'tarefa-apagar' && typeof b.tid === 'string') {
      registar(a, `apagou a tarefa «${titulo(e, b.tid)}»`);
      e.tasks = e.tasks.filter((x) => x.id !== b.tid);
    } else if (b.op === 'cfg' && ((b.campo === 'anchor' && DATA_ISO.test(b.valor || '')) || (b.campo === 'roomsBase' && MES_ISO.test(b.valor || '')) || (b.campo === 'trashOn' && typeof b.valor === 'boolean'))) {
      e[b.campo] = b.valor;
      registar(a, { anchor: `mudou a Semana 1 para ${b.valor}`, roomsBase: `mudou o mês de partida dos quartos para ${b.valor}`, trashOn: b.valor ? 'ligou o lixo' : 'desligou o lixo' }[b.campo]);
    } else return json(res, 400, { erro: 'Operação inválida.' });
  }
  db.versao++; gravar();
  json(res, 200, { versao: db.versao });
}
// O estado só se pode validar depois de as funções acima existirem.
db.estado = estadoCru ? estadoLimpo(estadoCru) : null;

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
    return json(res, 200, { agora: Date.now(), config: db.config, pessoas: db.pessoas, aparelhos: Object.values(db.aparelhos).sort((x, y) => y.ultimo - x.ultimo) });
  }
  if (rota === '/api/admin/atividade' && req.method === 'GET') return json(res, 200, { itens: db.historico });
  if (rota === '/api/admin/backup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="tarefas-porto-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db, null, 1));
  }
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  if (rota === '/api/admin/pessoas' && req.method === 'POST') {
    const nomes = Array.isArray(b.pessoas) ? b.pessoas.map((n) => limpa(n, 20)) : [];
    if (nomes.length !== 3 || nomes.some((n) => !n)) return json(res, 400, { erro: 'Indica os 3 nomes.' });
    db.pessoas = nomes; db.versao++; registar({ etiqueta: 'Admin' }, 'mudou os nomes das pessoas'); gravar();
    return json(res, 200, { pessoas: db.pessoas });
  }
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
  if (caminho === '/api/saude' && req.method === 'GET') return json(res, 200, { ok: true, versao: db.versao, aparelhos: Object.keys(db.aparelhos).length });
  if (caminho === '/api/atividade' && req.method === 'GET') {
    if (excede('atividade:' + ipDe(req), 120, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
    const a = db.aparelhos[new URL(req.url, 'http://x').searchParams.get('id')];
    if (!a || a.status !== 'ativo') return json(res, 403, { erro: 'Aparelho sem acesso.' });
    return json(res, 200, { itens: db.historico.slice(0, 100) });
  }
  if (caminho === '/api/estado' && ['GET', 'POST'].includes(req.method)) return estadoApi(req, res).catch(() => json(res, 500, { erro: 'Erro interno.' }));
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
      ...(entrada[1] === HTML ? { 'Content-Security-Policy': CSP } : {}),
      ...(caminho === '/admin' ? { 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : conteudo);
  });
});

module.exports = servidor;
// Sob o Passenger, PORT pode ser um socket; em local cai para 3100.
if (!process.env.TESTE) servidor.listen(process.env.PORT || 3100);
