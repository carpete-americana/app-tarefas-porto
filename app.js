// Ponto de entrada do Passenger (cPanel → Setup Node.js App).
// Serve a app, regista os aparelhos que a abrem e dá a página /admin (palavra-passe em ADMIN_PASSWORD).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TEXTOS = require('./textos.js');
const PUSH = require('./push.js');
const TEXTO_DEF = Object.fromEntries(TEXTOS.DEF.map((d) => [d.k, d]));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FICHEIRO_DADOS = path.join(DATA_DIR, 'aparelhos.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const SOM_FICHEIRO = path.join(DATA_DIR, 'som-clock.bin');
const SOM_MAX = 600000;
const ASSUNTO_PUSH = process.env.PUSH_ASSUNTO || 'https://porto.bcibizz.pt';
const CONFIG_BASE = { somAtivo: true, somVolume: 70, aprovacao: false, pushNovaTarefa: true, pushTroca: true, pushLembrete: true, pushPedido: true, pushHora: '09:00' };
const MAX_APARELHOS = 1000;
const MAX_HISTORICO = 200;
const SESSAO_MS = 12 * 3600e3;

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PNG = 'image/png';
// Lista fechada: só estes caminhos existem.
const FICHEIROS = {
  '/': ['index.html', HTML],
  '/index.html': ['index.html', HTML],
  '/admin': ['admin.html', HTML],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', JS],
  '/textos.js': ['textos.js', JS],
  '/som.js': ['som.js', JS],
  '/admin.webmanifest': ['admin.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/admin-180.png': ['admin-180.png', PNG],
  '/admin-192.png': ['admin-192.png', PNG],
  '/admin-512.png': ['admin-512.png', PNG],
  '/icon-180.png': ['icon-180.png', PNG],
  '/icon-192.png': ['icon-192.png', PNG],
  '/icon-512.png': ['icon-512.png', PNG],
};

/* ---------- dados ---------- */
const PESSOAS_BASE = ['Sofia', 'Leonor', 'Francisco'];
let db = { som: null, config: { ...CONFIG_BASE }, aparelhos: {}, pessoas: PESSOAS_BASE.slice(), estado: null, versao: 0, historico: [], textos: {}, textosV: 1 };
let estadoCru = null;
try {
  const j = JSON.parse(fs.readFileSync(FICHEIRO_DADOS, 'utf8'));
  if (j && typeof j === 'object') {
    db = { som: j.som && typeof j.som === 'object' && fs.existsSync(SOM_FICHEIRO) ? { tipo: String(j.som.tipo), nome: String(j.som.nome).slice(0, 80), tamanho: Number(j.som.tamanho) || 0, v: Number(j.som.v) || 1 } : null,
      config: configLimpa(j.config), aparelhos: j.aparelhos && typeof j.aparelhos === 'object' ? j.aparelhos : {},
      pessoas: Array.isArray(j.pessoas) && j.pessoas.length === 3 ? j.pessoas.map((n, i) => String(n).slice(0, 20) || PESSOAS_BASE[i]) : PESSOAS_BASE.slice(), estado: null, versao: Number.isInteger(j.versao) ? j.versao : 0,
      textos: j.textos && typeof j.textos === 'object' ? j.textos : {}, textosV: Number.isInteger(j.textosV) ? j.textosV : 1,
      historico: Array.isArray(j.historico) ? j.historico.filter((h) => h && typeof h.t === 'number' && typeof h.texto === 'string').slice(0, MAX_HISTORICO) : [] };
    estadoCru = j.estado;
  }
} catch (e) { /* primeira execução */ }

function configLimpa(c) {
  c = c && typeof c === 'object' ? c : {};
  const bool = (k) => (typeof c[k] === 'boolean' ? c[k] : CONFIG_BASE[k]);
  return {
    somAtivo: typeof c.somAtivo === 'boolean' ? c.somAtivo : true,
    somVolume: Number.isInteger(c.somVolume) && c.somVolume >= 0 && c.somVolume <= 100 ? c.somVolume : CONFIG_BASE.somVolume,
    aprovacao: c.aprovacao === true, pushNovaTarefa: bool('pushNovaTarefa'), pushTroca: bool('pushTroca'), pushLembrete: bool('pushLembrete'), pushPedido: bool('pushPedido'),
    pushHora: /^([01]\d|2[0-3]):[0-5]\d$/.test(c.pushHora) ? c.pushHora : CONFIG_BASE.pushHora,
  };
}

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
// Texto configurável: o valor do admin, ou o original. Listas sorteiam uma alternativa.
function texto(k, vars = {}) {
  const def = TEXTO_DEF[k];
  let v = db.textos[k] !== undefined ? db.textos[k] : def && def.v;
  if (Array.isArray(v)) v = v.length ? v[Math.floor(Math.random() * v.length)] : '';
  return String(v == null ? k : v).replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
}
function textoValido(k, v) {
  const def = TEXTO_DEF[k];
  if (!def) return null;
  const um = (x) => (typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 600) : null);
  if (def.lista) {
    if (!Array.isArray(v) || v.length > 30) return null;
    const l = v.map(um);
    return l.some((x) => x === null) ? null : l.filter((x) => x.trim());
  }
  return um(v);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function tipoAudio(b) { // só se aceita o que realmente é áudio (pelos primeiros bytes), nunca pelo nome ou tipo declarado
  if (b.length < 12) return null;
  const txt = (i, n) => b.subarray(i, i + n).toString('latin1');
  if (txt(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (txt(0, 4) === 'OggS') return 'audio/ogg';
  if (txt(0, 4) === 'RIFF' && txt(8, 4) === 'WAVE') return 'audio/wav';
  if (txt(4, 4) === 'ftyp') return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  return null;
}
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

// O remate vem de graca.<tipo> (lista editável no admin); a frase factual vem sempre primeiro.
function registar(aparelho, textoBase, tipo) {
  const quem = (aparelho && (aparelho.etiqueta || aparelho.pessoa)) || texto('act.alguem');
  let t = textoBase;
  if (tipo && TEXTO_DEF['graca.' + tipo]) { const r = texto('graca.' + tipo); if (r) t += ' — ' + r; }
  db.historico.unshift({ t: Date.now(), quem, texto: limpa(t, 220) });
  if (db.historico.length > MAX_HISTORICO) db.historico.length = MAX_HISTORICO;
}

/* ---------- notificações push ---------- */
const enviosPendentes = new Set();
const comPush = () => Object.values(db.aparelhos).filter((a) => a.push && a.status === 'ativo');
const nomeDe = (a) => (a && (a.etiqueta || a.pessoa)) || texto('act.alguem');

async function enviarAoAparelho(a, msg) {
  const r = await PUSH.enviar(a.push, msg, { dir: DATA_DIR, assunto: ASSUNTO_PUSH });
  if (r === 'ok') a.push.falhas = 0;
  else if (r === 'removida' || ++a.push.falhas >= 5) delete a.push; // o serviço já não a conhece, ou falhou 5 vezes seguidas
  return r;
}
// msg pode ser um objeto ou uma função (aparelho) => objeto. Nunca rejeita: um envio falhado não afeta quem o provocou.
function notificar(alvos, msg) {
  const p = (async () => {
    let enviados = 0;
    for (const a of alvos) {
      if (!a.push) continue;
      const m = typeof msg === 'function' ? msg(a) : msg;
      if ((await enviarAoAparelho(a, { url: '/', icon: '/icon-192.png', ...m })) === 'ok') enviados++;
    }
    gravar();
    return enviados;
  })().catch(() => 0);
  enviosPendentes.add(p); p.finally(() => enviosPendentes.delete(p));
  return p;
}

function agoraLisboa() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => partes.find((x) => x.type === t).value;
  return { dia: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}
// Lembrete da manhã: a partir da hora configurada (janela de 6 h, para uma passagem falhada do cron ainda recuperar) e uma só vez por dia.
async function tickLembretes(agora = agoraLisboa()) {
  if (!db.config.pushLembrete) return 0;
  const [h, m] = db.config.pushHora.split(':').map(Number);
  if (agora.min < h * 60 + m || agora.min > h * 60 + m + 360) return 0;
  const alvos = comPush().filter((a) => a.pessoa && a.lembreteDia !== agora.dia);
  if (!alvos.length) return 0;
  alvos.forEach((a) => { a.lembreteDia = agora.dia; });
  gravar(); // reclama o dia antes de enviar: dois processos não avisam a dobrar
  return notificar(alvos, (a) => ({ title: texto('notif.lembreteTitulo', { nome: a.pessoa }), body: texto('notif.lembrete'), tag: 'lembrete-' + agora.dia }));
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
  json(res, 200, { status: a.status, pessoas: db.pessoas, tv: db.textosV, pushPedir: db.config.pushPedido, push: !!a.push });
}

/* ---------- API pública: mudar o nome de uma pessoa (vale para todos) ---------- */
async function mudarPessoa(req, res) {
  if (excede('pessoas:' + ipDe(req), 30, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  const a = typeof b.id === 'string' && db.aparelhos[b.id];
  if (!a || a.status !== 'ativo') return json(res, 403, { erro: 'Aparelho sem acesso.' });
  const nome = limpa(b.nome, 20);
  if (!Number.isInteger(b.i) || b.i < 0 || b.i > 2 || !nome) return json(res, 400, { erro: 'Nome inválido.' });
  registar(a, texto('act.nome', { n: b.i + 1, nome }), 'nome');
  db.pessoas[b.i] = nome; db.versao++; gravar();
  json(res, 200, { pessoas: db.pessoas, versao: db.versao });
}

/* ---------- API pública: subscrições push ---------- */
async function pushApi(req, res, rota) {
  if (excede('push:' + ipDe(req), 30, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
  let b; try { b = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  const a = typeof b.id === 'string' && db.aparelhos[b.id];
  if (!a || a.status !== 'ativo') return json(res, 403, { erro: 'Aparelho sem acesso.' });
  if (rota === '/api/push/subscrever') {
    const s = b.sub, k = s && s.keys;
    if (!s || typeof s.endpoint !== 'string' || !PUSH.endpointAceite(s.endpoint) || !k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string'
      || PUSH.deB64u(k.p256dh).length !== 65 || PUSH.deB64u(k.auth).length !== 16) return json(res, 400, { erro: 'Subscrição inválida.' });
    const igual = a.push && a.push.endpoint === s.endpoint && a.push.p256dh === k.p256dh && a.push.auth === k.auth;
    if (!igual) { a.push = { endpoint: s.endpoint, p256dh: k.p256dh, auth: k.auth, falhas: 0, desde: Date.now() }; gravar(); }
    return json(res, 200, { ok: true });
  }
  if (rota === '/api/push/cancelar') { if (a.push) { delete a.push; gravar(); } return json(res, 200, { ok: true }); }
  if (rota === '/api/push/teste') {
    if (!a.push) return json(res, 400, { erro: 'Este aparelho não tem notificações ativas.' });
    if (excede('pushteste:' + b.id, 6, 60e3)) return json(res, 429, { erro: 'Demasiados testes.' });
    const r = await enviarAoAparelho(a, { title: texto('notif.testeTitulo', { app: texto('app.nome') }), body: texto('notif.teste'), url: '/', icon: '/icon-192.png', tag: 'teste' });
    gravar();
    return json(res, 200, { resultado: r });
  }
  json(res, 404, { erro: 'Não encontrado.' });
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
  const base = { versao: db.versao, pessoas: db.pessoas, tv: db.textosV };
  if (req.method === 'GET') {
    if (!db.estado) return json(res, 200, { ...base, estado: null });
    return json(res, 200, b.v === db.versao ? { ...base, igual: true } : { ...base, estado: db.estado });
  }
  const titulo = (e, id) => (id === 'lixo' ? texto('lixo.titulo') : ((e && e.tasks.find((t) => t.id === id)) || {}).title || texto('act.tarefaFallback'));
  if (b.op === 'iniciar' || b.op === 'substituir') {
    if (b.op === 'iniciar' && db.estado) return json(res, 409, { ...base, erro: 'Já existe estado.' });
    const novo = estadoLimpo(b.estado);
    if (!novo) return json(res, 400, { erro: 'Estado inválido.' });
    db.estado = novo;
    registar(a, texto(b.op === 'iniciar' ? 'act.inicio' : 'act.substituiu'), 'inicio');
  } else {
    const e = db.estado;
    if (!e) return json(res, 409, { ...base, erro: 'Sem estado.' });
    if (b.op === 'marcar' && typeof b.chave === 'string' && b.chave && b.chave.length <= 200 && typeof b.valor === 'boolean') {
      if (b.valor) e.done[b.chave] = 1; else delete e.done[b.chave];
      podarMarcacoes();
      registar(a, texto(b.valor ? 'act.marcou' : 'act.desmarcou', { titulo: titulo(e, b.chave.split('|')[0]) }), b.valor ? 'marcou' : 'desmarcou');
    } else if (b.op === 'limpar') { e.done = {}; registar(a, texto('act.limpou'), 'limpar'); }
    else if (b.op === 'troca' && typeof b.chave === 'string' && b.chave && b.chave.length <= 100 && (b.valor === null || (Number.isInteger(b.valor) && b.valor >= 0 && b.valor <= 2))) {
      if (b.valor === null) delete e.ov[b.chave]; else e.ov[b.chave] = b.valor;
      const alvo = b.chave.startsWith('lixo|') ? texto('act.alvoLixo', { data: b.chave.slice(5) }) : b.chave.split('|')[1];
      registar(a, b.valor === null ? texto('act.trocaRepor', { alvo }) : texto('act.trocaPara', { alvo, nome: db.pessoas[b.valor] }), 'troca');
      if (b.valor !== null && db.config.pushTroca) notificar(comPush().filter((x) => x.id !== a.id && x.pessoa === db.pessoas[b.valor]), { title: texto('notif.trocaTitulo', { app: texto('app.nome') }), body: texto('notif.troca', { quem: nomeDe(a), alvo }), tag: 'troca-' + b.chave });
    } else if (b.op === 'tarefa') {
      const t = tarefaLimpa(b.tarefa);
      if (!t) return json(res, 400, { erro: 'Tarefa inválida.' });
      const i = e.tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) e.tasks[i] = t; else if (e.tasks.length >= 200) return json(res, 400, { erro: 'Demasiadas tarefas.' }); else e.tasks.push(t);
      registar(a, texto(i >= 0 ? 'act.editou' : 'act.criou', { titulo: t.title }), i >= 0 ? 'editou' : 'criou');
      if (i < 0 && db.config.pushNovaTarefa) notificar(comPush().filter((x) => x.id !== a.id), { title: texto('notif.novaTitulo', { app: texto('app.nome') }), body: texto('notif.nova', { quem: nomeDe(a), titulo: t.title, remate: texto('notif.remateNova') }), tag: 'nova-' + t.id });
    } else if (b.op === 'tarefa-apagar' && typeof b.tid === 'string') {
      registar(a, texto('act.apagou', { titulo: titulo(e, b.tid) }), 'apagou');
      e.tasks = e.tasks.filter((x) => x.id !== b.tid);
    } else if (b.op === 'cfg' && ((b.campo === 'anchor' && DATA_ISO.test(b.valor || '')) || (b.campo === 'roomsBase' && MES_ISO.test(b.valor || '')) || (b.campo === 'trashOn' && typeof b.valor === 'boolean'))) {
      e[b.campo] = b.valor;
      registar(a, { anchor: texto('act.semana1', { valor: b.valor }), roomsBase: texto('act.mesQuartos', { valor: b.valor }), trashOn: texto(b.valor ? 'act.lixoOn' : 'act.lixoOff') }[b.campo], b.campo === 'trashOn' ? 'lixo' : 'config');
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
    return json(res, 200, { agora: Date.now(), config: db.config, pessoas: db.pessoas, som: db.som, aparelhos: Object.values(db.aparelhos).map((a) => ({ ...a, push: !!a.push })).sort((x, y) => y.ultimo - x.ultimo) });
  }
  if (rota === '/api/admin/textos' && req.method === 'GET') return json(res, 200, { def: TEXTOS.DEF, grupos: TEXTOS.GRUPOS, textos: db.textos, tv: db.textosV });
  if (rota === '/api/admin/atividade' && req.method === 'GET') return json(res, 200, { itens: db.historico });
  if (rota === '/api/admin/backup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="tarefas-porto-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify({ ...db, aparelhos: Object.fromEntries(Object.entries(db.aparelhos).map(([k, a]) => [k, { ...a, push: undefined }])) }, null, 1)); // sem as chaves das subscrições push
  }
  let b; try { b = await lerCorpo(req, 1000000); } catch (e) { return json(res, 400, { erro: 'Pedido inválido.' }); }
  if (rota === '/api/admin/textos' && req.method === 'POST') {
    if (b.repor === 'tudo') db.textos = {};
    else if (b.alteracoes && typeof b.alteracoes === 'object') {
      for (const [k, v] of Object.entries(b.alteracoes)) {
        if (!TEXTO_DEF[k]) return json(res, 400, { erro: 'Texto desconhecido: ' + k });
        if (v === null) { delete db.textos[k]; continue; }
        const ok = textoValido(k, v);
        if (ok === null) return json(res, 400, { erro: 'Valor inválido em ' + k });
        if (JSON.stringify(ok) === JSON.stringify(TEXTO_DEF[k].v)) delete db.textos[k]; else db.textos[k] = ok;
      }
    } else return json(res, 400, { erro: 'Pedido inválido.' });
    db.textosV++; gravar();
    return json(res, 200, { tv: db.textosV, textos: db.textos });
  }
  if (rota === '/api/admin/push/enviar' && req.method === 'POST') {
    const msg = limpa(b.mensagem, 200), titulo = limpa(b.titulo, 60) || texto('app.nome');
    if (!msg) return json(res, 400, { erro: 'Escreve a mensagem.' });
    const i = b.destino === 'todos' ? -1 : Number(String(b.destino).replace('pessoa:', ''));
    if (b.destino !== 'todos' && !(Number.isInteger(i) && i >= 0 && i <= 2)) return json(res, 400, { erro: 'Destino inválido.' });
    const alvos = comPush().filter((x) => i < 0 || x.pessoa === db.pessoas[i]);
    const enviados = await notificar(alvos, { title: titulo, body: msg, tag: 'anuncio-' + Date.now() });
    return json(res, 200, { tentados: alvos.length, enviados });
  }
  if (rota === '/api/admin/som' && req.method === 'POST') {
    if (b.remover === true) { db.som = null; try { fs.unlinkSync(SOM_FICHEIRO); } catch (e) { /* já não existia */ } }
    else {
      const dados = typeof b.dados === 'string' ? Buffer.from(b.dados, 'base64') : null;
      if (!dados || !dados.length) return json(res, 400, { erro: 'Escolhe um ficheiro de áudio.' });
      if (dados.length > SOM_MAX) return json(res, 400, { erro: 'O ficheiro é grande demais (máximo 600 KB).' });
      const tipo = tipoAudio(dados);
      if (!tipo) return json(res, 400, { erro: 'Isso não parece áudio (usa mp3, wav, ogg ou m4a).' });
      fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SOM_FICHEIRO, dados);
      db.som = { tipo, nome: limpa(b.nome, 80) || 'som', tamanho: dados.length, v: Date.now() };
    }
    db.textosV++; gravar();
    return json(res, 200, { som: db.som });
  }
  if (rota === '/api/admin/pessoas' && req.method === 'POST') {
    const nomes = Array.isArray(b.pessoas) ? b.pessoas.map((n) => limpa(n, 20)) : [];
    if (nomes.length !== 3 || nomes.some((n) => !n)) return json(res, 400, { erro: 'Indica os 3 nomes.' });
    db.pessoas = nomes; db.versao++; registar({ etiqueta: texto('act.admin') }, texto('act.nomesAdmin')); gravar();
    return json(res, 200, { pessoas: db.pessoas });
  }
  if (rota === '/api/admin/config' && req.method === 'POST') {
    const nova = configLimpa({ ...db.config, ...b });
    if (!(Number.isInteger(b.somVolume) && b.somVolume >= 0 && b.somVolume <= 100)) nova.somVolume = db.config.somVolume; // valor inválido: fica o que estava
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.pushHora)) nova.pushHora = db.config.pushHora;
    db.config = nova; db.textosV++; gravar(); // os aparelhos voltam a pedir os textos (e o som)
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
  if (caminho === '/api/push/chave' && req.method === 'GET') return json(res, 200, { chave: PUSH.carregarChaves(DATA_DIR).publica });
  if (caminho.startsWith('/api/push/') && req.method === 'POST') return pushApi(req, res, caminho).catch(() => json(res, 500, { erro: 'Erro interno.' }));
  if (caminho === '/api/cron/tick' && req.method === 'GET') {
    if (excede('cron:' + ipDe(req), 30, 60e3)) return json(res, 429, { erro: 'Demasiados pedidos.' });
    return tickLembretes().then((n) => json(res, 200, { enviados: n })).catch(() => json(res, 500, { erro: 'Erro interno.' }));
  }
  if (caminho === '/api/textos' && req.method === 'GET') return json(res, 200, { tv: db.textosV, textos: db.textos, fx: { som: db.config.somAtivo, vol: db.config.somVolume, custom: db.som ? db.som.v : 0 } });
  if (caminho === '/api/som' && req.method === 'GET') {
    if (!db.som) return json(res, 404, { erro: 'Sem som personalizado.' });
    return fs.readFile(SOM_FICHEIRO, (err, dados) => {
      if (err) return json(res, 404, { erro: 'Sem som personalizado.' });
      res.writeHead(200, { 'Content-Type': db.som.tipo, 'Content-Length': dados.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(dados);
    });
  }
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
    if (!err && (caminho === '/' || caminho === '/index.html')) conteudo = Buffer.from(conteudo.toString('utf8')
      .replace('<title>Tarefas Porto</title>', () => `<title>${esc(texto('app.nome'))}</title>`)
      .replace('name="apple-mobile-web-app-title" content="Tarefas"', () => `name="apple-mobile-web-app-title" content="${esc(texto('app.nomeCurto'))}"`));
    if (!err && caminho === '/admin.webmanifest') {
      try { const m = JSON.parse(conteudo.toString('utf8')); m.name = texto('app.nome') + ' · Admin'; conteudo = Buffer.from(JSON.stringify(m, null, 2)); } catch (e) { /* fica o ficheiro */ }
    }
    if (!err && caminho === '/manifest.webmanifest') {
      try { const m = JSON.parse(conteudo.toString('utf8')); m.name = texto('app.nome'); m.short_name = texto('app.nomeCurto'); m.description = texto('app.descricao'); conteudo = Buffer.from(JSON.stringify(m, null, 2)); } catch (e) { /* fica o ficheiro */ }
    }
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

servidor.aguardarPush = () => Promise.all([...enviosPendentes]);
servidor.tickLembretes = tickLembretes;
servidor.definirTransportePush = PUSH.definirTransporte;
module.exports = servidor;
// Sob o Passenger, PORT pode ser um socket; em local cai para 3100.
if (!process.env.TESTE) {
  servidor.listen(process.env.PORT || 3100);
  // O Passenger adormece a app quando está parada: em produção convém também um cron do cPanel a chamar /api/cron/tick.
  setInterval(() => tickLembretes().catch(() => {}), 60e3).unref();
}
