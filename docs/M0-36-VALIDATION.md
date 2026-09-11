# STK-M0-36 — Validação: identidade exata do runtime root (bigint)

Origem: [issue #97](https://github.com/RhianB14/stakeframe/issues/97) — flaky
transitório em `tests/operations/restore-runtime-root.test.mjs` observado na
rodada de revisão da STK-M0-35 (PR #96), nos testes
`cleanup refuses a divergent identity and keeps the root` e
`assertRootStillSafe runs the production order: shape, policy, realpath, identity`.

## Diagnóstico sanitizado (coleta local, sem valores reais)

Coleta em máquina local Windows 11 (NTFS), apenas tipos, booleanos e conclusões —
nenhum valor real de `ino`, `dev` ou caminho é publicado:

| Observação                                           | Resultado                      |
| ---------------------------------------------------- | ------------------------------ |
| `typeof info.ino` (lstat convencional)               | `number`                       |
| `typeof info.ino` (lstat com `{ bigint: true }`)     | `bigint`                       |
| `Number.isSafeInteger(info.ino)` convencional        | `false`                        |
| `info.ino + 1 === info.ino` (convencional)           | `true`                         |
| `big.ino > BigInt(Number.MAX_SAFE_INTEGER)`          | `true`                         |
| `Number(big.ino) === info.ino`                       | `true` (mesmo valor colapsado) |
| Prova sintética: `Number(2^53) === Number(2^53 + 1)` | `true`                         |
| Prova sintética: `2^53n !== 2^53n + 1n`              | `true` (bigint distingue)      |

Conclusão da coleta: nesta máquina, o file ID NTFS do diretório temporário excede
`Number.MAX_SAFE_INTEGER`; a leitura convencional devolve um `number` que perde
precisão e a aritmética `ino + 1` retorna o mesmo valor (`ino + 1 === ino`). Com
`{ bigint: true }` o valor é exato e adjacentes permanecem distintos.

### Causa histórica × mecanismo demonstrado

- **Mecanismo tecnicamente demonstrado:** a perda de precisão float64 colapsa
  file IDs adjacentes acima de `Number.MAX_SAFE_INTEGER`; reproduzido ao vivo e
  provado sinteticamente. Os dois testes flaky usavam exatamente `real.ino + 1`
  como identidade divergente.
- **Causa histórica das falhas passadas: consistente, não formalmente
  comprovada.** O mecanismo explica plenamente o sintoma (produção "aceitava" a
  identidade que deveria divergir) e a magnitude real do file ID na máquina onde
  as falhas ocorreram; não havia instrumentação rodando durante as falhas
  originais, por isso não há prova direta contra aquelas execuções. A hipótese
  secundária (reutilização concorrente de inode) permanece sem evidência.
- Correção no **código de produção** (não apenas nos testes): captura e
  comparação de identidade com precisão exata, conforme a issue.

## Alteração realizada

- `scripts/deployment/restore-runtime-root.mjs`
  - Todas as leituras que sustentam identidade e política usam
    `lstat(..., { bigint: true })` (criação, recriação pós-erro, leituras de
    preparação do diretório individual, primeira e última revalidação antes do
    `rmdir`).
  - `captureIdentity()` garante bigint na captura (pós-criação, retorno de
    `prepareRuntimeRoot` e identidade inicial de rollback) e recusa captura não
    bigint.
  - `assertSameIdentity()` recusa qualquer representação não bigint (Number,
    string, `undefined`) — representações incompatíveis nunca são "a mesma
    identidade", mesmo que uma conversão lossy colapsasse os valores.
  - Política de modo/proprietário adaptada a campos bigint (`0o700n`, `0n`)
    **sem redução**: diretório real, nunca symlink, modo efetivo exatamente
    `0700`, `root:root`, realpath exato, mesma identidade dev+ino.
  - `dev`/`ino` permanecem somente em memória; nenhum relatório, código
    sanitizado ou mensagem pública os expõe.
- `scripts/restore-rehearsal.mjs` — armazenamento transitório da identidade
  (`runtimeRoot`) mantido bigint de ponta a ponta; o relatório continua
  registrando apenas `'created'`/`'preexisting'`.
- `tests/operations/restore-runtime-root.test.mjs`
  - Usos frágeis `info.ino + 1` substituídos por identidades divergentes
    determinísticas e exatamente representáveis (`divergentOf`, sintéticos
    acima de `Number.MAX_SAFE_INTEGER`).
  - Fixtures sintéticas na forma bigint (espelhando a produção); comparação
    permanece estrita entre representações (bigint vs number = recusa).
  - Cobertura nova: dois IDs bigint distintos acima de `Number.MAX_SAFE_INTEGER`
    são recusados mesmo quando a conversão Number colapsaria; divergência de dev
    recusada; identidade exata aceita; limpeza preserva o diretório com
    identidade divergente; rollback pós-falha de validação usa a identidade
    exata.
  - Nenhuma verificação enfraquecida para Windows ou para os testes; os skips
    pré-existentes (POSIX-only, privilégio de chown, criação de symlink) foram
    preservados.

## Verificações executadas (runtime do projeto: Node v24.20.0, pnpm 11.24.0)

| Verificação                                                                | Resultado                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `node --test tests/operations/restore-runtime-root.test.mjs`               | 30 pass / 0 fail / 3 skip (POSIX-only), rc 0                                                     |
| Teste específico — 20 repetições consecutivas                              | 20/20 rc 0 (30 pass / 0 fail cada)                                                               |
| `pnpm operations:test` (concorrência padrão) — 10 repetições               | 10/10 rc 0 (40 pass / 0 fail / 3 skip cada)                                                      |
| `node --test --test-concurrency=1 tests/operations/*.test.mjs` — 3 rodadas | 3/3 rc 0 (40 pass / 0 fail / 3 skip cada)                                                        |
| Saídas completas                                                           | preservadas localmente (não publicadas; apenas contagens aqui)                                   |
| `pnpm format:check` nos arquivos alterados                                 | Prettier OK (forma LF, igual à CI)                                                               |
| `git diff --check`                                                         | sem conflitos de whitespace                                                                      |
| Revisão integral do diff                                                   | revisada linha a linha antes do commit                                                           |
| Busca residual por aritmética `ino + 1` e fixtures numéricas de dev/ino    | apenas comentários explicativos e as recusas cross-type intencionais; nenhum uso frágil restante |
| Busca por segredos/identificadores privados nas linhas adicionadas         | limpa                                                                                            |

Nota sobre `pnpm format:check` local: com `core.autocrlf=true`, o checkout
Windows produz CRLF em 258 arquivos intocados e o Prettier (`endOfLine: lf`)
falha localmente; a CI executa em checkout LF e passa. Os três arquivos
modificados foram validados no Prettier em forma LF (idêntica à indexada pelo
git), conforme prática já registrada no repositório.

## Rodadas de correção pós-primeiro push

A primeira rodada (head `a03e23a…`) falhou na CI: `format-check` (Prettier do
repo, `printWidth 100`, acusou o arquivo de testes — a validação local havia
usado o Prettier de outro diretório, sem o `.prettierrc.json` do repo) e
`application-check`/`application-arm64-check` (o teste POSIX-only
`refuses an insecure runtime root mode` quebrou porque o spread de um `Stats`
real descarta os métodos de protótipo `isDirectory`/`isSymbolicLink` — o teste
é pulado no Windows, o que mascarou a regressão localmente). O commit
`5e534963…` restaura a delegação explícita no `Stats` real (uid/gid bigint) e
aplica a formatação do repo. Mesma tarefa, correção documentada — sem reescrita
de histórico.

- **Nenhuma operação em produção:** sem deploy Cloudflare, sem instalação ou
  leitura de segredos, sem mensagens Telegram, sem operação na VPS, sem
  migração de banco, sem merge. A execução ficou restrita a testes locais com
  diretórios temporários.
- Nenhuma evidência anterior da issue #97 foi removida.
- O merge depende de revisão do Codex vinculada ao head SHA e à base validados.
