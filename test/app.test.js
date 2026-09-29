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
