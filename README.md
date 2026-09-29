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
- **Estado partilhado** (`/api/estado`): tarefas, marcações, trocas de responsável e definições (semana 1, mês dos quartos, lixo) vivem no servidor e cada aparelho sincroniza de 5 em 5 segundos com a app aberta. O primeiro aparelho a abrir lança o estado; os outros recebem-no. As mudanças são operações pequenas (marcar, trocar, gravar tarefa…), por isso duas pessoas a marcar tarefas diferentes não se sobrepõem. Marcações com mais de 150 dias são apagadas. Sem rede a app continua a funcionar com o que tem, mas o que se marcar offline perde-se no próximo sincronizar.
- Sessão de admin em memória: um Restart obriga a entrar de novo. Trava depois de 8 tentativas falhadas em 15 minutos.
- Testes: `node --test test/app.test.js`.

## Tarefas, estatísticas e atividade

A página **Tarefas** tem três separadores: a lista (procura, filtro por divisão, duplicar, restaurar originais, «Desfazer» ao apagar), **Estatísticas** (% por pessoa nas últimas 4 semanas e o que está em atraso, contando só desde a «Semana 1») e **Atividade** (quem fez o quê, guardado no servidor: últimas 200 ações). Uma tarefa pode ser **rotativa** (muda de pessoa todas as semanas).

## Robustez

- **Sem rede**: as alterações ficam numa fila guardada no aparelho e seguem por ordem quando a ligação volta. O service worker guarda a última versão da app, por isso ela abre offline (rede primeiro, cópia só se a rede falhar).
- **Cópias de segurança**: uma por dia em `data/backups/` (as 14 mais recentes). O admin tem «Exportar» para descarregar tudo.
- **Segurança**: CSP e `frame-ancestors 'none'` nas páginas; `/api/saude` para monitorização.
- **Definições**: tema claro/escuro/automático, estado da sincronização e «Procurar atualização» (limpa a cache da app).

## Textos configuráveis

Todos os textos da app (248) estão em `textos.js` e editam-se no admin, separador **Textos**: pesquisa, grupos, «Repor original» por texto e «Repor todos». As mudanças chegam a todos os aparelhos em poucos segundos e também alteram o nome do ícone (manifest) e o título da página. Nos textos: `**negrito**`, `{variáveis}`; os textos com várias alternativas (remates do feed, lembretes) levam uma por linha e a app sorteia. Fora do dicionário ficam apenas as tarefas em si (editam-se em Tarefas), os nomes das pessoas (Definições ou admin), os nomes das divisões e o texto do próprio admin.

## Notificações push

Só para quem tem a app instalada (no iPhone o push só existe no ecrã principal). Feito sem dependências (`push.js`: VAPID + cifra `aes128gcm` com o módulo `crypto`); validado contra `web-push`/`http_ece`.

- **Chaves VAPID**: geradas no primeiro arranque em `data/vapid.json`. **Não apagar nem regerar**: as subscrições existentes ficam presas a estas chaves e deixam de receber, sem erro nenhum.
- **Quando envia** (admin → Notificações, tudo desligável): tarefa nova (aos outros), responsável trocado (à pessoa), lembrete da manhã (uma vez por dia, a partir da hora escolhida, hora de Lisboa) e avisos escritos à mão para todos ou para uma pessoa. Os textos editam-se no separador Textos, grupo «Notificações».
- **Pedido de ativação**: ao abrir a app instalada aparece uma vez um ecrã a pedir para ativar (o admin pode desligar); «Agora não» adia 7 dias. Também há um cartão em Definições, com botão de teste.
- **Lembrete da manhã em produção** precisa de um **Cron Job no cPanel** (o servidor adormece): `curl -fsS https://porto.bcibizz.pt/api/cron/tick >/dev/null`, de 5 em 5 minutos. Recupera passagens falhadas até 6 horas depois.
- Só se enviam pedidos a serviços de push conhecidos (FCM, Apple, Mozilla, Windows). Subscrições que o serviço recusa (404/410) ou que falham 5 vezes seguidas são removidas. A exportação do admin não leva as subscrições.
- `PUSH_ASSUNTO` (opcional): contacto VAPID, por omissão `https://porto.bcibizz.pt`.
