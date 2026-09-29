# App Tarefas Porto

App responsiva para gerir as tarefas domésticas do T2 (rotação de 3 semanas, quartos por mês, lixo). Sem dependências; os dados ficam no `localStorage` de cada aparelho (Definições → Exportar/Importar).

- Local: `node app.js` → http://localhost:3100 (ou abrir o `index.html` directamente).
- Produção: cPanel → Setup Node.js App, root `porto`, ficheiro de arranque `app.js` (porto.bcibizz.pt).

## Admin (aparelhos)

`/admin` — sem link em lado nenhum, com `noindex`. Mostra cada aparelho que abriu a app (pessoa escolhida, plataforma, instalada ou não, última vez, visitas), deixa aprovar, bloquear, renomear e apagar, e tem o interruptor «Exigir aprovação de aparelhos novos».

**Precisa de `ADMIN_PASSWORD`**: no cPanel, *Setup Node.js App → Environment variables → Add variable* (nome `ADMIN_PASSWORD`, o valor é a palavra-passe) e **Restart**. Sem ela o admin responde 503; não há palavra-passe por omissão.

- Os dados ficam em `data/aparelhos.json` (fora do Git). O `.cpanel.yml` só copia ficheiros da app, por isso um deploy não apaga `data/`.
- Não se guarda IP nem o user-agent completo, só uma identificação (iPhone/iPad, Android, Computador).
- Os nomes das pessoas (Sofia, Leonor, Francisco) ficam também em `data/aparelhos.json`: quem mudar um nome nas Definições muda-o para todos (`POST /api/pessoas`, só de aparelhos ativos), e cada aparelho sincroniza no arranque e ao voltar à app.
- Sessão de admin em memória: um Restart obriga a entrar de novo. Trava depois de 8 tentativas falhadas em 15 minutos.
- Testes: `node --test test/app.test.js`.
