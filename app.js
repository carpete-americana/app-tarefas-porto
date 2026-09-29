// Ponto de entrada do Passenger (cPanel → Setup Node.js App): serve a página e os ficheiros da app instalável.
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML = 'text/html; charset=utf-8';
const PNG = 'image/png';
// Lista fechada: só estes caminhos existem.
const FICHEIROS = {
  '/': ['index.html', HTML],
  '/index.html': ['index.html', HTML],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-180.png': ['icon-180.png', PNG],
  '/icon-192.png': ['icon-192.png', PNG],
  '/icon-512.png': ['icon-512.png', PNG],
};

const servidor = http.createServer((req, res) => {
  const entrada = FICHEIROS[req.url.split('?')[0]];
  if (!entrada) {
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
    });
    res.end(req.method === 'HEAD' ? undefined : conteudo);
  });
});

// Sob o Passenger, PORT pode ser um socket; em local cai para 3100.
servidor.listen(process.env.PORT || 3100);
