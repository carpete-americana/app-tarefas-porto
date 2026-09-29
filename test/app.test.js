process.env.TESTE = '1';
process.env.ADMIN_PASSWORD = 'segredo-de-teste';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'tp-'));
const test = require('node:test');
const assert = require('node:assert');
const servidor = require('../app.js');

let base;
test.before(async () => { await new Promise((r) => servidor.listen(0, r)); base = `http://127.0.0.1:${servidor.address().port}`; });
test.after(() => servidor.close());

const post = (p, corpo, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(corpo) });
const ID1 = 'aaaaaaaa-1111-2222-3333-444444444444';
let cookie = '';
const adm = (p, corpo) => post(p, corpo, { Cookie: cookie, 'X-Requested-With': 'fetch' });
const dados = async () => (await fetch(base + '/api/admin/dados', { headers: { Cookie: cookie } })).json();

test('aparelho novo fica ativo e aparece no admin', async () => {
  const r = await post('/api/hello', { id: ID1, pessoa: 'Leonor', instalada: true });
  assert.strictEqual((await r.json()).status, 'ativo');
});
test('id inválido é recusado', async () => { assert.strictEqual((await post('/api/hello', { id: '<x>' })).status, 400); });
test('admin recusa sem sessão e com palavra-passe errada', async () => {
  assert.strictEqual((await fetch(base + '/api/admin/dados')).status, 401);
  assert.strictEqual((await post('/api/admin/login', { password: 'errada' })).status, 401);
});
test('login, listar, bloquear, aprovação', async () => {
  const r = await post('/api/admin/login', { password: 'segredo-de-teste' });
  assert.strictEqual(r.status, 200);
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  let d = await dados();
  assert.strictEqual(d.aparelhos.length, 1);
  assert.strictEqual(d.aparelhos[0].pessoa, 'Leonor');
  assert.strictEqual((await post('/api/admin/aparelho', { id: ID1, acao: 'bloquear' }, { Cookie: cookie })).status, 403, 'sem X-Requested-With');
  await adm('/api/admin/aparelho', { id: ID1, acao: 'bloquear' });
  assert.strictEqual((await (await post('/api/hello', { id: ID1 })).json()).status, 'bloqueado');
  await adm('/api/admin/aparelho', { id: ID1, acao: 'desbloquear' });
  await adm('/api/admin/config', { aprovacao: true });
  assert.strictEqual((await (await post('/api/hello', { id: 'bbbbbbbb-1111-2222-3333-444444444444' })).json()).status, 'pendente');
  assert.strictEqual((await (await post('/api/hello', { id: ID1 })).json()).status, 'ativo', 'os existentes não são afetados');
  await adm('/api/admin/aparelho', { id: 'bbbbbbbb-1111-2222-3333-444444444444', acao: 'aprovar' });
  assert.strictEqual((await (await post('/api/hello', { id: 'bbbbbbbb-1111-2222-3333-444444444444' })).json()).status, 'ativo');
  await adm('/api/admin/aparelho', { id: ID1, acao: 'etiqueta', valor: 'Telemóvel <b>Leonor</b>' });
  d = await dados(); assert.ok(!d.aparelhos.find((a) => a.id === ID1).etiqueta.includes('<'));
  await adm('/api/admin/aparelho', { id: 'bbbbbbbb-1111-2222-3333-444444444444', acao: 'apagar' });
  assert.strictEqual((await dados()).aparelhos.length, 1);
});
test('logout termina a sessão; /admin serve a página com noindex', async () => {
  const p = await fetch(base + '/admin'); assert.strictEqual(p.status, 200); assert.match(p.headers.get('x-robots-tag'), /noindex/);
  await adm('/api/admin/logout', {});
  assert.strictEqual((await fetch(base + '/api/admin/dados', { headers: { Cookie: cookie } })).status, 401);
});
test('mudar o nome de uma pessoa vale para todos os aparelhos', async () => {
  const B = 'cccccccc-1111-2222-3333-444444444444';
  cookie = (await post('/api/admin/login', { password: 'segredo-de-teste' })).headers.get('set-cookie').split(';')[0];
  await post('/api/hello', { id: B });
  assert.strictEqual((await post('/api/pessoas', { id: B, i: 1, nome: 'x' })).status, 403, 'pendente não muda');
  await adm('/api/admin/aparelho', { id: B, acao: 'aprovar' });
  const r = await post('/api/pessoas', { id: B, i: 1, nome: '  Maria <b>' });
  assert.strictEqual(r.status, 200);
  const nomes = (await r.json()).pessoas;
  assert.deepStrictEqual(nomes, ['Sofia', 'Maria b', 'Francisco']);
  const h = await (await post('/api/hello', { id: ID1 })).json();
  assert.deepStrictEqual(h.pessoas, nomes, 'outro aparelho recebe o nome novo');
  assert.strictEqual((await post('/api/pessoas', { id: B, i: 3, nome: 'x' })).status, 400);
  assert.strictEqual((await post('/api/pessoas', { id: B, i: 0, nome: '   ' })).status, 400);
  assert.strictEqual((await post('/api/pessoas', { id: 'desconhecido-123', i: 0, nome: 'x' })).status, 403);
  await adm('/api/admin/aparelho', { id: B, acao: 'bloquear' });
  assert.strictEqual((await post('/api/pessoas', { id: B, i: 0, nome: 'x' })).status, 403, 'bloqueado não muda');
});
test('login trava depois de 8 falhas', async () => {
  let ultimo; for (let i = 0; i < 10; i++) ultimo = (await post('/api/admin/login', { password: 'x' })).status;
  assert.strictEqual(ultimo, 429);
});

/* ---------- estado partilhado ---------- */
const T1 = { id: 't1', title: 'Loiça', room: 'Cozinha', repeat: 'daily', who: 'rota', note: '', active: true, date: '', weekday: 0 };
const EST = { tasks: [T1], done: {}, ov: {}, anchor: '2026-09-28', roomsBase: '2026-10', trashOn: true };
const get = async (id, v) => (await fetch(`${base}/api/estado?id=${id}&v=${v}`)).json();
const op = (id, corpo) => post('/api/estado', { id, ...corpo });
const A = 'dddddddd-1111-2222-3333-444444444444', C = 'eeeeeeee-1111-2222-3333-444444444444';

test('estado: o primeiro aparelho lança, o segundo recebe', async () => {
  await adm('/api/admin/config', { aprovacao: false });
  await post('/api/hello', { id: A }); await post('/api/hello', { id: C });
  assert.strictEqual((await get(A, -1)).estado, null);
  const r = await op(A, { op: 'iniciar', estado: EST });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await op(C, { op: 'iniciar', estado: EST })).status, 409, 'já existe');
  const j = await get(C, -1); assert.strictEqual(j.estado.tasks[0].title, 'Loiça');
});
test('estado: marcar, trocar, tarefa, cfg e versão', async () => {
  let v = (await get(A, -1)).versao;
  const r = await (await op(A, { op: 'marcar', chave: 't1|2026-09-29|0|1', valor: true })).json();
  assert.strictEqual(r.versao, v + 1);
  assert.strictEqual((await get(C, v)).estado.done['t1|2026-09-29|0|1'], 1, 'outro aparelho vê a marcação');
  assert.strictEqual((await get(C, v + 1)).igual, true);
  await op(A, { op: 'troca', chave: '2026-09-28|Cozinha', valor: 2 });
  await op(A, { op: 'tarefa', tarefa: { ...T1, id: 't2', title: 'Regar <b>plantas', who: 1, repeat: 'w1' } });
  await op(A, { op: 'cfg', campo: 'trashOn', valor: false });
  let e = (await get(C, -1)).estado;
  assert.strictEqual(e.ov['2026-09-28|Cozinha'], 2);
  assert.strictEqual(e.tasks.find((t) => t.id === 't2').title, 'Regar bplantas');
  assert.strictEqual(e.trashOn, false);
  await op(A, { op: 'troca', chave: '2026-09-28|Cozinha', valor: null });
  await op(A, { op: 'tarefa-apagar', tid: 't2' });
  e = (await get(C, -1)).estado; assert.deepStrictEqual(e.ov, {}); assert.strictEqual(e.tasks.length, 1);
  await op(A, { op: 'limpar' }); assert.deepStrictEqual((await get(C, -1)).estado.done, {});
});
test('estado: entradas inválidas e aparelhos sem acesso são recusados', async () => {
  assert.strictEqual((await op(A, { op: 'tarefa', tarefa: { id: 'x', title: '', room: 'a', repeat: 'daily', who: 'rota' } })).status, 400);
  assert.strictEqual((await op(A, { op: 'tarefa', tarefa: { ...T1, repeat: 'nunca' } })).status, 400);
  assert.strictEqual((await op(A, { op: 'cfg', campo: 'anchor', valor: 'ontem' })).status, 400);
  assert.strictEqual((await op(A, { op: 'troca', chave: 'k', valor: 7 })).status, 400);
  assert.strictEqual((await op(A, { op: 'apagar-tudo' })).status, 400);
  assert.strictEqual((await op(A, { op: 'substituir', estado: { ...EST, anchor: 'x' } })).status, 400);
  assert.strictEqual((await fetch(`${base}/api/estado?id=desconhecido-123&v=0`)).status, 403);
  await adm('/api/admin/aparelho', { id: C, acao: 'bloquear' });
  assert.strictEqual((await get(C, -1)).erro !== undefined, true, 'bloqueado não lê');
  assert.strictEqual((await op(C, { op: 'marcar', chave: 'k', valor: true })).status, 403, 'bloqueado não escreve');
});

/* ---------- atividade, cópias, cabeçalhos ---------- */
test('atividade regista quem fez o quê; só aparelhos ativos a leem', async () => {
  const D = 'ffffffff-1111-2222-3333-444444444444';
  await adm('/api/admin/aparelho', { id: C, acao: 'desbloquear' });
  await post('/api/hello', { id: D, pessoa: 'Sofia' });
  await op(D, { op: 'marcar', chave: 't1|2026-09-29|0|1', valor: true });
  await op(D, { op: 'tarefa', tarefa: { ...T1, id: 't9', title: 'Estender roupa', who: 'rodar', repeat: 'w1' } });
  const j = await (await fetch(`${base}/api/atividade?id=${D}`)).json();
  assert.match(j.itens[0].texto, /criou a tarefa «Estender roupa»/);
  assert.strictEqual(j.itens[0].quem, 'Sofia');
  assert.match(j.itens[1].texto, /marcou «Loiça» — .+/, 'frase factual + remate');
  assert.strictEqual((await fetch(`${base}/api/atividade?id=nao-existe-1`)).status, 403);
  const adminJ = await (await fetch(base + '/api/admin/atividade', { headers: { Cookie: cookie } })).json();
  assert.ok(adminJ.itens.length >= 2);
});
test('cópia diária, exportação do admin e nomes pelo admin', async () => {
  const fs = require('fs'), path = require('path');
  const bk = path.join(process.env.DATA_DIR, 'backups');
  assert.ok(fs.readdirSync(bk).some((f) => /^aparelhos-\d{4}-\d{2}-\d{2}\.json$/.test(f)), 'existe cópia do dia');
  const r = await fetch(base + '/api/admin/backup', { headers: { Cookie: cookie } });
  assert.match(r.headers.get('content-disposition'), /attachment; filename="tarefas-porto-/);
  assert.ok(Array.isArray((await r.json()).historico));
  assert.strictEqual((await fetch(base + '/api/admin/backup')).status, 401, 'sem sessão não exporta');
  assert.strictEqual((await adm('/api/admin/pessoas', { pessoas: ['A', '', 'C'] })).status, 400);
  const ok = await (await adm('/api/admin/pessoas', { pessoas: ['Ana', 'Bea', 'Carlos'] })).json();
  assert.deepStrictEqual(ok.pessoas, ['Ana', 'Bea', 'Carlos']);
  assert.deepStrictEqual((await get(A, -1)).pessoas, ['Ana', 'Bea', 'Carlos']);
});
test('cabeçalhos de segurança e /api/saude', async () => {
  const h = await fetch(base + '/');
  assert.match(h.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual((await (await fetch(base + '/api/saude')).json()).ok, true);
});

/* ---------- textos configuráveis ---------- */
test('textos: dicionário, edição pelo admin, validação e uso no servidor', async () => {
  const ad = await (await fetch(base + '/api/admin/textos', { headers: { Cookie: cookie } })).json();
  assert.ok(ad.def.length > 200 && ad.grupos.length > 5);
  assert.deepStrictEqual((await (await fetch(base + '/api/textos')).json()).textos, {}, 'sem alterações no início');
  assert.strictEqual((await fetch(base + '/api/admin/textos')).status, 401, 'só o admin lê a lista completa');
  // muda o texto do feed e da app
  const tv0 = (await (await fetch(base + '/api/textos')).json()).tv;
  const r = await adm('/api/admin/textos', { alteracoes: { 'act.marcou': 'acabou «{titulo}» 🎯', 'graca.marcou': ['top!', 'boa!'], 'app.nome': 'Casa Porto <3' } });
  assert.strictEqual(r.status, 200);
  const pub = await (await fetch(base + '/api/textos')).json();
  assert.ok(pub.tv > tv0); assert.strictEqual(pub.textos['app.nome'], 'Casa Porto <3');
  await post('/api/hello', { id: A });
  await op(A, { op: 'marcar', chave: 't1|2026-09-29|0|9', valor: true });
  const it = (await (await fetch(`${base}/api/atividade?id=${A}`)).json()).itens[0];
  assert.match(it.texto, /^acabou «Loiça» 🎯 — (top!|boa!)$/);
  // título da página e manifest seguem o nome
  assert.match(await (await fetch(base + '/')).text(), /<title>Casa Porto &lt;3<\/title>/);
  assert.strictEqual((await (await fetch(base + '/manifest.webmanifest')).json()).name, 'Casa Porto <3');
  // validação
  assert.strictEqual((await adm('/api/admin/textos', { alteracoes: { 'nao.existe': 'x' } })).status, 400);
  assert.strictEqual((await adm('/api/admin/textos', { alteracoes: { 'graca.marcou': 'texto solto' } })).status, 400, 'lista tem de ser lista');
  assert.strictEqual((await adm('/api/admin/textos', { alteracoes: { 'app.nome': ['a'] } })).status, 400, 'texto simples não é lista');
  // repor um / repor tudo; valor igual ao original apaga a alteração
  await adm('/api/admin/textos', { alteracoes: { 'app.nome': null, 'act.marcou': 'marcou «{titulo}»' } });
  assert.strictEqual(Object.keys((await (await fetch(base + '/api/textos')).json()).textos).length, 1, 'só resta graca.marcou');
  await adm('/api/admin/textos', { repor: 'tudo' });
  assert.deepStrictEqual((await (await fetch(base + '/api/textos')).json()).textos, {});
  assert.match(await (await fetch(base + '/textos.js')).text(), /TEXTOS_DEF/);
});

/* ---------- notificações push ---------- */
const crypto = require('crypto');
// Decifragem escrita à parte, a partir da RFC 8291 (não partilha código com push.js).
function decifrar(corpo, ua, auth) {
  const salt = corpo.subarray(0, 16), idlen = corpo[20], asPub = corpo.subarray(21, 21 + idlen), ct = corpo.subarray(21 + idlen);
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = hm(hm(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hm(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.length - 1).toString('utf8'));
}
function novoAparelhoPush(id, estadoHttp = 201) {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { id, ua, auth, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, estadoHttp,
    sub: () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }) };
}
const enviosPush = [];
servidor.definirTransportePush(async (endpoint, cab, corpo) => {
  const ap = pushAp.find((x) => x.endpoint === endpoint);
  enviosPush.push({ endpoint, cab, corpo, ap });
  return ap ? ap.estadoHttp : 201;
});
const pushAp = [];
const recebidas = (ap) => enviosPush.filter((e) => e.ap === ap).map((e) => decifrar(e.corpo, ap.ua, ap.auth));
const registarPush = async (id, pessoa) => {
  const ap = novoAparelhoPush(id); pushAp.push(ap);
  await post('/api/hello', { id, pessoa, instalada: true });
  assert.strictEqual((await post('/api/push/subscrever', { id, sub: ap.sub() })).status, 200);
  return ap;
};

test('push: subscrever valida o endereço e as chaves; hello diz se há subscrição', async () => {
  await adm('/api/admin/config', { aprovacao: false });
  const id = 'push0000-1111-2222-3333-444444444444';
  await post('/api/hello', { id });
  const ap = novoAparelhoPush(id);
  assert.strictEqual((await post('/api/push/subscrever', { id, sub: { ...ap.sub(), endpoint: 'http://fcm.googleapis.com/x' } })).status, 400, 'só https');
  assert.strictEqual((await post('/api/push/subscrever', { id, sub: { ...ap.sub(), endpoint: 'https://evil.example.com/x' } })).status, 400, 'só serviços de push conhecidos');
  assert.strictEqual((await post('/api/push/subscrever', { id, sub: { endpoint: ap.endpoint, keys: { p256dh: 'abc', auth: 'def' } } })).status, 400, 'chaves com tamanho errado');
  assert.strictEqual((await post('/api/push/subscrever', { id: 'desconhecido-123', sub: ap.sub() })).status, 403);
  assert.strictEqual((await (await post('/api/hello', { id })).json()).push, false);
  pushAp.push(ap);
  assert.strictEqual((await post('/api/push/subscrever', { id, sub: ap.sub() })).status, 200);
  const h = await (await post('/api/hello', { id })).json();
  assert.strictEqual(h.push, true); assert.strictEqual(h.pushPedir, true);
  const k = await (await fetch(base + '/api/push/chave')).json();
  assert.strictEqual(Buffer.from(k.chave, 'base64url').length, 65);
});

test('push: teste chega cifrado, com VAPID válido', async () => {
  const ap = await registarPush('push1111-1111-2222-3333-444444444444', 'Sofia');
  const r = await (await post('/api/push/teste', { id: ap.id })).json();
  assert.strictEqual(r.resultado, 'ok');
  const env = enviosPush.filter((e) => e.ap === ap).pop();
  const msg = decifrar(env.corpo, ap.ua, ap.auth);
  assert.match(msg.body, /Funciona!/); assert.strictEqual(msg.url, '/');
  assert.strictEqual(env.cab['Content-Encoding'], 'aes128gcm');
  const [, t, k] = env.cab.Authorization.match(/^vapid t=([\w.-]+), k=([\w-]+)$/);
  assert.strictEqual(k, (await (await fetch(base + '/api/push/chave')).json()).chave);
  const [h, c, s] = t.split('.'), pub = Buffer.from(k, 'base64url');
  const chave = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: chave, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'assinatura VAPID');
  assert.strictEqual(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://fcm.googleapis.com');
});

test('push: tarefa nova avisa os outros; troca avisa só a pessoa; interruptores', async () => {
  const S1 = pushAp.find((x) => x.id.startsWith('push1111')), L = await registarPush('push2222-1111-2222-3333-444444444444', (await get(A, -1)).pessoas[1]);
  const antes = (ap) => recebidas(ap).length;
  const nS = antes(S1), nL = antes(L);
  await op(S1.id, { op: 'tarefa', tarefa: { ...T1, id: 'tpush1', title: 'Passar a ferro', who: 'todos', repeat: 'w1' } });
  await servidor.aguardarPush();
  assert.strictEqual(antes(S1), nS, 'o autor não é avisado');
  const m = recebidas(L).pop(); assert.match(m.body, /Passar a ferro/); assert.match(m.body, /^Sofia criou «Passar a ferro»/);
  // troca: passa a Leonor
  const nS2 = antes(S1), nL2 = antes(L);
  await op(S1.id, { op: 'troca', chave: '2026-09-28|Cozinha', valor: 1 });
  await servidor.aguardarPush();
  assert.strictEqual(antes(L), nL2 + 1, 'a pessoa recebe'); assert.strictEqual(antes(S1), nS2, 'quem trocou não recebe');
  assert.match(recebidas(L).pop().body, /passou-te 2026-09-28|passou-te Cozinha/);
  // interruptores desligados
  await adm('/api/admin/config', { pushNovaTarefa: false, pushTroca: false });
  const n3 = antes(L);
  await op(S1.id, { op: 'tarefa', tarefa: { ...T1, id: 'tpush2', title: 'Outra' } });
  await op(S1.id, { op: 'troca', chave: '2026-09-28|Sala', valor: 1 });
  await servidor.aguardarPush();
  assert.strictEqual(antes(L), n3, 'sem avisos com os interruptores desligados');
  await adm('/api/admin/config', { pushNovaTarefa: true, pushTroca: true });
});

test('push: lembrete da manhã uma vez por dia, dentro da janela; textos do admin', async () => {
  const S1 = pushAp.find((x) => x.id.startsWith('push1111'));
  const conta = () => recebidas(S1).filter((m) => /Bom dia/.test(m.title)).length;
  const c0 = conta();
  assert.strictEqual(await servidor.tickLembretes({ dia: '2030-01-01', min: 8 * 60 }), 0, 'antes das 09:00');
  assert.strictEqual(await servidor.tickLembretes({ dia: '2030-01-01', min: 16 * 60 }), 0, 'depois da janela de 6 h');
  const n = await servidor.tickLembretes({ dia: '2030-01-01', min: 9 * 60 + 5 }); assert.ok(n >= 2, 'envia aos aparelhos com pessoa');
  assert.strictEqual(conta(), c0 + 1); assert.match(recebidas(S1).filter((m) => /Bom dia/.test(m.title)).pop().title, /^Bom dia, Sofia/);
  assert.strictEqual(await servidor.tickLembretes({ dia: '2030-01-01', min: 10 * 60 }), 0, 'só uma vez por dia');
  assert.ok(await servidor.tickLembretes({ dia: '2030-01-02', min: 9 * 60 }) >= 2, 'no dia seguinte volta');
  // o admin muda o texto e a hora
  await adm('/api/admin/textos', { alteracoes: { 'notif.lembrete': ['Bora limpar!'], 'notif.lembreteTitulo': 'Ei {nome}!' } });
  await adm('/api/admin/config', { pushHora: '07:30' });
  await servidor.tickLembretes({ dia: '2030-01-03', min: 7 * 60 + 30 });
  const ult = recebidas(S1).pop(); assert.strictEqual(ult.title, 'Ei Sofia!'); assert.strictEqual(ult.body, 'Bora limpar!');
  await adm('/api/admin/config', { pushLembrete: false });
  assert.strictEqual(await servidor.tickLembretes({ dia: '2030-01-04', min: 8 * 60 }), 0, 'desligado');
  await adm('/api/admin/config', { pushLembrete: true, pushHora: '09:00' });
  assert.strictEqual((await adm('/api/admin/config', { pushHora: '25:99' })).status, 200);
  assert.strictEqual((await (await fetch(base + '/api/admin/dados', { headers: { Cookie: cookie } })).json()).config.pushHora, '09:00', 'hora inválida é ignorada');
  await adm('/api/admin/textos', { repor: 'tudo' });
  const tick = await (await fetch(base + '/api/cron/tick')).json(); assert.strictEqual(typeof tick.enviados, 'number');
});

test('push: anúncio do admin, subscrição caducada é removida, segredos não vazam', async () => {
  const S1 = pushAp.find((x) => x.id.startsWith('push1111')), L = pushAp.find((x) => x.id.startsWith('push2222'));
  const nS = recebidas(S1).length, nL = recebidas(L).length;
  assert.strictEqual((await adm('/api/admin/push/enviar', { mensagem: '   ', destino: 'todos' })).status, 400);
  assert.strictEqual((await adm('/api/admin/push/enviar', { mensagem: 'x', destino: 'pessoa:9' })).status, 400);
  const r = await (await adm('/api/admin/push/enviar', { titulo: 'Aviso', mensagem: 'Reunião às 20h 🍕', destino: 'pessoa:1' })).json();
  assert.ok(r.enviados >= 1); assert.strictEqual(recebidas(S1).length, nS); assert.ok(recebidas(L).length > nL);
  const ult = recebidas(L).pop(); assert.strictEqual(ult.title, 'Aviso'); assert.strictEqual(ult.body, 'Reunião às 20h 🍕');
  L.estadoHttp = 410; // o serviço deixou de conhecer a subscrição
  await adm('/api/admin/push/enviar', { mensagem: 'ola', destino: 'todos' });
  assert.strictEqual((await (await post('/api/hello', { id: L.id })).json()).push, false, 'subscrição removida após 410');
  const dados = await (await fetch(base + '/api/admin/dados', { headers: { Cookie: cookie } })).json();
  assert.ok(dados.aparelhos.every((a) => typeof a.push === 'boolean'), 'o admin só vê se tem push, não as chaves');
  const bk = await (await fetch(base + '/api/admin/backup', { headers: { Cookie: cookie } })).text();
  assert.ok(!bk.includes('fcm.googleapis.com/fcm/send'), 'a exportação não leva as subscrições');
  assert.strictEqual((await post('/api/push/cancelar', { id: S1.id })).status, 200);
  assert.strictEqual((await (await post('/api/hello', { id: S1.id })).json()).push, false);
});
