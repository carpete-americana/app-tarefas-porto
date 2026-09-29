// Ponto de entrada do Passenger (cPanel → Setup Node.js App): serve só o index.html.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ficheiro = path.join(__dirname, 'index.html');

const servidor = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url !== '/' && url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  fs.readFile(ficheiro, (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Erro interno');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
});

// Sob o Passenger, PORT pode ser um socket; em local cai para 3100.
servidor.listen(process.env.PORT || 3100);
