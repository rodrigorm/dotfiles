# Deploy do bridge Cloudflare Sandbox

Pesquisa realizada em 9 de setembro de 2026 com fontes primárias: código do
[`cloudflare/sandbox-sdk`](https://github.com/cloudflare/sandbox-sdk), documentação
oficial do Cloudflare e o adapter Cloudflare deste repositório. Nenhum deploy,
login, secret ou chamada live foi executado.

## Conclusão

Usar o Worker pronto em `cloudflare/sandbox-sdk/bridge/worker` e preferir o
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/bridge/worker).
O botão clona o diretório para o GitHub, provisiona Durable Objects e
Containers via Workers Builds e faz o deploy ([README oficial](https://github.com/cloudflare/sandbox-sdk/blob/main/bridge/worker/README.md)).

Para este repositório, o secret `CLOUDFLARE_API_TOKEN` também é necessário:
o provider local sempre solicita um túnel nomeado, não um quick tunnel.

## Pré-requisitos

- Conta Cloudflare Workers Paid com Containers/Sandbox habilitado.
- Uma zona DNS Cloudflare para túneis nomeados.
- GitHub autorizado para o botão One-click.
- Node.js/npm para deploy manual; Docker é necessário quando o deploy local
  constrói uma imagem a partir de `Dockerfile` ([guia de deploy](https://developers.cloudflare.com/sandbox/guides/deploy/)).

## Configuração efetiva

O [`bridge/worker/wrangler.jsonc`](https://github.com/cloudflare/sandbox-sdk/blob/main/bridge/worker/wrangler.jsonc)
atual define:

- Worker `cloudflare-sandbox-bridge`, entrypoint `src/index.ts` e
  `nodejs_compat`.
- Durable Objects `Sandbox` e `WarmPool`.
- Imagem local `./Dockerfile`, `instance_type: "standard-1"` e
  `max_instances: 3`.
- `SANDBOX_TRANSPORT="rpc"`.
- `WARM_POOL_TARGET="0"`, `WARM_POOL_REFRESH_INTERVAL="10000"`,
  `WARM_POOL_MAX_INSTANCES="0"` e `WARM_POOL_SCALE_BATCH_SIZE="5"`.
- Cron `* * * * *`, que inicia o loop do warm pool; target zero mantém o pool
  desativado.

Há uma inconsistência importante: o README diz que o default usa `lite` e
descreve `standard-1` como 4 vCPU/8 GiB, enquanto o `wrangler.jsonc` efetivo
usa `standard-1`. A tabela oficial atual define `standard-1` como 1/2 vCPU,
4 GiB e 8 GB ([limites e tipos](https://developers.cloudflare.com/containers/platform/limits/#instance-types),
[preços](https://developers.cloudflare.com/containers/platform/pricing/)).
Para saber o que o template realmente publica, prevalece o `wrangler.jsonc`;
o comentário e a prosa do README precisam ser tratados como desatualizados.

O `WARM_POOL_MAX_INSTANCES="0"` também é efetivo: o pool aprende o limite por
erros da plataforma. Se o pool for habilitado, configurar esse valor para
`3`, igual a `containers[].max_instances`, evita depender desse aprendizado.

Containers cobram pelo uso ativo; o plano Workers Paid inclui 375 vCPU-minutos,
25 GiB-horas e 200 GB-horas por mês ([preços oficiais](https://developers.cloudflare.com/containers/platform/pricing/)).
Um pool aquecido acima de zero inicia containers e consome recursos.

## Secrets e variáveis

O Worker deve receber:

```sh
npx wrangler secret put SANDBOX_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

`SANDBOX_API_KEY` autentica as rotas `/v1/sandbox/*`; gerar com:

```sh
openssl rand -hex 32
```

`CLOUDFLARE_API_TOKEN` é usado somente para túneis nomeados. O token precisa
destas permissões, limitado à conta e zona escolhidas:

- Account / Cloudflare Tunnel / Edit;
- Zone / DNS / Edit;
- Zone / Zone / Read;
- Account / Account Settings / Read é opcional e ajuda a inferir o account ID.

O SDK tenta inferir account e zone quando o token vê exatamente uma de cada.
O override específico de túnel `CLOUDFLARE_TUNNEL_ACCOUNT_ID` tem precedência
sobre `CLOUDFLARE_ACCOUNT_ID`; em caso ambíguo, definir account e zone como
variáveis não secretas:

```jsonc
{
  "vars": {
    "CLOUDFLARE_ACCOUNT_ID": "<account-id>",
    "CLOUDFLARE_ZONE_ID": "<zone-id>"
  }
}
```

Os nomes vêm de [`credentials.ts`](https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/src/tunnels/credentials.ts)
e da [documentação oficial de túneis](https://developers.cloudflare.com/sandbox/api/tunnels/).
Secrets devem ser administrados como secrets, não como `vars` ([Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).

## Túneis nomeados

O provider local deriva `oc-<shortHash(workspaceId)>` em
[`cloudflare-provider.ts`](../home/.config/opencode/sandbox/cloudflare-provider.ts#L1075)
e envia esse valor no body `{ "name": "..." }` para
`POST /v1/sandbox/:id/tunnel/:port`.

O bridge/SDK então:

1. Resolve `<name>.<zone>`.
2. Cria ou reutiliza um Tunnel chamado
   `sandbox-<sandbox-id>-<name>`.
3. Cria ou atualiza o CNAME proxied `<name>.<zone>` apontando para
   `<tunnel-id>.cfargotunnel.com`.
4. Executa `cloudflared` no container.
5. Em `destroy`, para o processo e remove o Tunnel e o CNAME.

O valor de `name` é um único label DNS; não passar um hostname completo. Quick
tunnels (`sandbox.tunnels.get(port)`) não exigem token nem zona, mas o adapter
local não usa esse caminho ([túneis oficiais](https://developers.cloudflare.com/sandbox/api/tunnels/),
[`cloudflare-bridge.ts`](../home/.config/opencode/sandbox/cloudflare-bridge.ts#L219)).

## Deploy manual

O README do bridge mostra `npm ci` no diretório do Worker. O repositório atual,
porém, possui o lockfile e o workspace na raiz (`bridge/worker` depende de
`@cloudflare/sandbox: "*"`). Para um clone completo do monorepo, usar a raiz
para instalar e compilar e só então executar Wrangler no projeto do Worker:

```sh
git clone --depth 1 https://github.com/cloudflare/sandbox-sdk.git
cd sandbox-sdk
npm ci
npm run build
cd bridge/worker
npx wrangler login
npx wrangler secret put SANDBOX_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

O `Dockerfile` atual fixa `cloudflare/sandbox:0.12.9`; a documentação exige
manter a versão da imagem e do pacote `@cloudflare/sandbox` na mesma linha
([Dockerfile](https://github.com/cloudflare/sandbox-sdk/blob/main/bridge/worker/Dockerfile),
[guia de deploy](https://developers.cloudflare.com/sandbox/guides/deploy/)).
Não atualizar apenas um dos dois.

## Configuração local

Depois do deploy, `SANDBOX_PROVIDER=cloudflare` seleciona o provider. A URL é a
raiz do Worker, sem acrescentar `/v1`. Também é possível configurar um projeto
literalmente em `.opencode/sandbox.json`:

```json
{
  "provider": "cloudflare",
  "apiUrl": "https://<worker>.<subdomain>.workers.dev",
  "apiKey": "<sandbox-api-key>"
}
```

A precedência, da menor para a maior, é: defaults (com `apiUrl` e `apiKey`
nulos), arquivo do projeto, objeto JSON em `SANDBOX_CONFIG`, e cada variável de
ambiente correspondente (`SANDBOX_API_URL` ou `SANDBOX_API_KEY`) quando ela
está presente. Uma variável vazia ainda sobrescreve o campo e falha na
validação. Cloudflare exige os dois campos; outros providers podem omiti-los
ou usar `null`. A URL aceita HTTPS ou HTTP apenas em loopback permitido e não
pode conter credenciais.

A opção de arquivo não exclui o segredo do Git: este repositório já rastreia
`.opencode/sandbox.json`, e não se deve inserir uma chave real nele nem alterar
silenciosamente seu provider ou versão. Um arquivo com segredo precisa ser
não rastreado e ignorado antes do uso; adicionar uma regra ao `.gitignore` não
desrastreia um arquivo existente. Arquivos rastreados podem entrar no capture
ou archive do Git e no checkout do provider. Portanto, não se deve afirmar que
uma chave no arquivo será automaticamente excluída; prefira variáveis de
ambiente ou `SANDBOX_CONFIG`.

A configuração equivalente por ambiente é:

```sh
export SANDBOX_PROVIDER=cloudflare
export SANDBOX_API_URL='https://<worker>.<subdomain>.workers.dev'
read -r -s SANDBOX_API_KEY
export SANDBOX_API_KEY
```

Isso corresponde a [`plugin-runtime.ts`](../home/.config/opencode/sandbox/plugin-runtime.ts#L275)
e ao cliente HTTP em [`cloudflare-bridge.ts`](../home/.config/opencode/sandbox/cloudflare-bridge.ts#L46).

## Smoke test e limpeza

O health check não exige autenticação; criação, execução e destruição exigem o
Bearer token:

```sh
export BRIDGE_URL='https://<worker>.<subdomain>.workers.dev'
curl -fsS "$BRIDGE_URL/health"

id="$(curl -fsS -X POST "$BRIDGE_URL/v1/sandbox" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" | jq -r .id)"

curl -fsS -X POST "$BRIDGE_URL/v1/sandbox/$id/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"argv":["sh","-lc","printf bridge-ok"],"cwd":"/workspace"}'

curl -fsS -X DELETE "$BRIDGE_URL/v1/sandbox/$id" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -o /dev/null
```

O `DELETE` deve ser executado mesmo após falha parcial, pois é o caminho que
remove o sandbox e os túneis associados quando a informação de túnel está
disponível.
