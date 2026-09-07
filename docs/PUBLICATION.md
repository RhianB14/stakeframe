# Publicação do candidato aprovado

STK-M0-20 publica os cinco índices ARM64 revisados na
[PR #49](https://github.com/RhianB14/stakeframe/pull/49#issuecomment-5568186537).
Rhian autorizou expressamente em 07/09/2026 a publicação como pacotes públicos
no GHCR e a permissão `packages: write` do workflow. Codex implementa e verifica
diretamente; esse registro não é uma revisão independente no GitHub.

O registro `infra/release/approved-arm64.json` fixa origem, run, artifact,
checksum do ZIP, destinos e digests aprovados. O workflow manual
`Publish approved candidate` não recebe parâmetros para substituir esses valores.
Só executa na `main` atual, após a CI de push e seus cinco checks aprovados.

A origem das imagens continua sendo `13823486556454b56398db451e1c7887798f9c0e`;
o commit posterior contém apenas o procedimento de publicação. O download
ocorre dentro do GitHub Actions, com o token temporário do job. Antes de
autenticar no registry, o procedimento confere run e artifact, checksum e
tamanho do ZIP, a lista exata de arquivos, os cinco arquivos OCI, manifests e
proveniência. Uma alteração no último target também impede o primeiro push.

O Skopeo fornecido pelo Ubuntu do runner copia todos os manifests, incluindo
proveniência, com `--all --preserve-digests`. Não há rebuild ou novo índice
multiarch. A versão utilizada é registrada no log. O token entra por stdin,
o arquivo de autenticação fica em diretório temporário e é removido ao sair.
Cada digest remoto é conferido pelos bytes do manifest devolvido pelo registry.
Uma falha pode deixar apenas parte dos cinco pacotes publicada; uma nova
execução usa os mesmos bytes e a mesma tag, sem exclusões.

O GitHub cria novos pacotes privados por padrão. Após o push, alterar para
público os cinco pacotes aprovados na interface do GitHub e verificar leitura
anônima por digest. `published.json` registra o push, mas não declara leitura
pública antes dessa verificação. Os relatórios são retidos por 30 dias.

O ZIP aprovado expira em 08/09/2026 às 09:01:23 UTC. Se estiver indisponível,
o procedimento falha; gerar novos bytes exige nova conferência e autorização.
Deploy, migrações, rede e release `v1.0.0` permanecem nos gates de
[FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md).

Referências: [Skopeo copy](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
e [permissões do GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).
