// Web Push sem dependências: VAPID (RFC 8292) + cifra aes128gcm (RFC 8291/8188), só com o módulo crypto.
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(String(s), 'base64url');

// Só se fazem pedidos aos serviços de push conhecidos (o endereço vem do browser do cliente).
const HOSTS_OK = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com|push\.microsoft\.com)$/;
function endpointAceite(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && HOSTS_OK.test(u.hostname) && endpoint.length <= 600; } catch (e) { return false; }
}

/* ---------- chaves VAPID (geradas uma vez e guardadas; mudá-las invalida todas as subscrições) ---------- */
let chaves = null;
function carregarChaves(dir) {
  if (chaves) return chaves;
  const ficheiro = path.join(dir, 'vapid.json');
  try {
    const j = JSON.parse(fs.readFileSync(ficheiro, 'utf8'));
    chaves = { publica: j.publica, privada: crypto.createPrivateKey({ key: j.privadaJwk, format: 'jwk' }) };
    return chaves;
  } catch (e) { /* gera novas */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const publica = b64u(Buffer.concat([Buffer.from([4]), deB64u(pub.x), deB64u(pub.y)]));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ficheiro, JSON.stringify({ publica, privadaJwk: privateKey.export({ format: 'jwk' }) }), { mode: 0o600 });
  chaves = { publica, privada: privateKey };
  return chaves;
}

function jwtVapid(audiencia, privada, assunto) {
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = b64u(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: assunto }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${corpo}`), { key: privada, dsaEncoding: 'ieee-p1363' });
  return `${cab}.${corpo}.${b64u(assinatura)}`;
}

/* ---------- cifra do conteúdo ---------- */
function cifrar(texto, p256dh, auth) {
  const uaPub = deB64u(p256dh), authSecret = deB64u(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || authSecret.length !== 16) throw new Error('subscrição inválida');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const segredo = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const infoChave = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', segredo, authSecret, infoChave, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const dados = Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])]); // 0x02 = último registo
  if (dados.length > 4096 - 17) throw new Error('mensagem demasiado grande');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([c.update(dados), c.final(), c.getAuthTag()]);
  const cab = Buffer.alloc(21 + 65);
  salt.copy(cab, 0); cab.writeUInt32BE(4096, 16); cab[20] = 65; asPub.copy(cab, 21);
  return Buffer.concat([cab, cifrado]);
}

/* ---------- envio ---------- */
let transporte = (endpoint, cabecalhos, corpo) => new Promise((resolve, reject) => {
  const u = new URL(endpoint);
  const req = https.request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { ...cabecalhos, 'Content-Length': corpo.length }, timeout: 10000 }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
  req.on('error', reject);
  req.end(corpo);
});
// Para testes: troca o envio real por uma função (endpoint, cabeçalhos, corpo) => estado HTTP.
const definirTransporte = (fn) => { transporte = fn; };

// Devolve: 'ok' | 'removida' (o serviço já não conhece a subscrição) | 'falhou'
async function enviar(sub, mensagem, { dir, assunto }) {
  if (!endpointAceite(sub.endpoint)) return 'removida';
  try {
    const { publica, privada } = carregarChaves(dir);
    const corpo = cifrar(JSON.stringify(mensagem), sub.p256dh, sub.auth);
    const jwt = jwtVapid(new URL(sub.endpoint).origin, privada, assunto);
    const estado = await transporte(sub.endpoint, {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal',
      Authorization: `vapid t=${jwt}, k=${publica}`,
    }, corpo);
    if (estado >= 200 && estado < 300) return 'ok';
    if (estado === 404 || estado === 410) return 'removida';
    return 'falhou';
  } catch (e) { return 'falhou'; }
}

module.exports = { endpointAceite, carregarChaves, jwtVapid, cifrar, enviar, definirTransporte, b64u, deB64u };
