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
