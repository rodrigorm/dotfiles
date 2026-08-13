# Acesso remoto a instâncias OpenCode

Pesquisa realizada em 11 de agosto de 2026. Foram usadas fontes primárias: documentação e código-fonte oficiais de T3 Code, OpenCode, Tailscale e Cloudflare, além dos dois scripts atuais deste repositório. O T3 Code foi auditado no commit [`35172010b131510d36d0cef54e174926e38a3013`](https://github.com/pingdotgg/t3code/tree/35172010b131510d36d0cef54e174926e38a3013) e o OpenCode no commit [`0d927ba03f36d7f87e3cdb2b6c1f34c44913a099`](https://github.com/anomalyco/opencode/tree/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099).

## Conclusão executiva

**Recomendação para substituir `ap-host` e `ax` hoje:** remover FRP e `ap-host`; manter somente `ax` como atalho opcional de uma linha para iniciar o OpenCode no IP da tailnet:

1. Na máquina remota, `ax [--web] [diretório]` obtém `tailscale ip -4` e inicia uma única instância `opencode serve` — ou `opencode web` — com `--hostname <IP-Tailscale> --port 4096`.
2. O processo não escuta em `0.0.0.0`, na interface LAN ou na internet pública: somente no endereço `100.x` daquela node.
3. O OpenCode Desktop central cadastra `http://<MagicDNS>:4096`. O cliente atual já persiste e opera múltiplos servidores, projetos e sessões; não é preciso construir outro proxy central para o MVP ([modelo e store de servidores](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/app/src/context/server.tsx#L148-L223), [formulário de servidor](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/app/src/components/dialog-select-server.tsx#L80-L175)). A TUI conecta com `opencode attach http://<MagicDNS>:4096` ([documentação da CLI](https://opencode.ai/docs/cli/#attach)).
4. Não configurar Basic Auth no MVP. A identidade, autorização de rede e criptografia de transporte ficam a cargo do Tailscale; grants/ACLs da tailnet definem quais nodes alcançam a porta 4096.

Isso entrega o objetivo principal sem `devpod`, `devcontainer`, FRP, `ap-host`, Tailscale Serve ou servidor central adicional. A execução, filesystem, git, credenciais de providers e sessões permanecem na máquina cliente/VM; o equipamento central é apenas cliente. Se HTTPS passar a ser necessário para uma UI central hospedada em HTTPS, Tailscale Serve continua disponível como modo opcional posterior.

O equivalente completo de `npx t3 connect` — login único, descoberta automática de todas as máquinas e tunnel público sem Tailscale — é um projeto posterior. O T3 mostra que isso exige um control plane, identidade, provisioning de Cloudflare Tunnel/DNS, credenciais de curta duração e lifecycle do connector; não é uma simples troca de `frpc` por `cloudflared`.

## Estado local e problema dos scripts atuais

Na inspeção local:

- OpenCode `1.18.15` está instalado.
- `/Applications/Tailscale.app` existe, mas o executável `tailscale` não está no `PATH`; o MVP deve localizar o CLI empacotado no app no macOS ou documentar/instalar a variante CLI.
- [`bootstrap.sh`](../bootstrap.sh) ainda instala `frpc` e `frps`.
- [`ap-host`](../home/bin/ap-host) inicia `frps` em `0.0.0.0:7500`, publica um vhost HTTP em `8080` e usa por padrão o token estático `agentpod`.
- [`ax`](../home/bin/ax) cria um `frpc` por porta, roteia por `customDomains` e pode iniciar o processo filho dentro do ambiente atual.

Esse desenho resolve “porta de um container → host central”, mas introduz um control plane FRP próprio, hostnames artificiais e um segredo default compartilhado. Ele também mantém o OpenCode dentro do Dev Container, que é justamente o acoplamento a remover.

## O padrão arquitetural útil do T3 Code

O post de Theo apresenta `npx t3 connect` como uma camada mínima e open source para controlar remotamente uma instância T3 em qualquer máquina conectada à internet, com Tailscale e self-hosting como alternativas ([post original](https://x.com/theo/status/2082277789395501263)). Os detalhes técnicos abaixo foram confirmados no repositório, não inferidos do anúncio.

### Runtime único, transportes intercambiáveis

O T3 separa três conceitos:

- o **execution environment** é um servidor que possui providers, projetos, threads, terminal, git e filesystem;
- o **access method** pode ser HTTP/WSS direto, Tailscale Serve, Cloudflare Tunnel gerenciado ou port forwarding SSH;
- o **launch method** decide quem inicia o servidor, sem mudar o protocolo nem a identidade do ambiente.

Essa separação está explícita na [arquitetura remota](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/remote.md#L7-L30) e é o aspecto que deve ser copiado. Tailscale é só um endpoint provider; não vira um tipo especial de ambiente ([mesmo documento](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/remote.md#L47-L55)).

### Tailscale primeiro

O caminho privado do T3 deixa o backend em loopback e configura Tailscale Serve HTTPS para apontar ao port local. O código executa o equivalente a:

```text
tailscale serve --bg --https=443 http://127.0.0.1:<porta>
```

([implementação do T3](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/packages/tailscale/src/tailscale.ts#L339-L360)). A documentação do produto oferece `t3 pair --tailscale` e `t3 serve --tailscale-serve`, retornando a URL MagicDNS HTTPS ([guia de acesso remoto](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/user/remote-access.md#L7-L23)).

Esse é o melhor modelo para o MVP porque:

- Tailscale Serve compartilha o serviço somente dentro da tailnet; Funnel é o produto que o tornaria público ([Serve](https://tailscale.com/docs/features/tailscale-serve), [Funnel](https://tailscale.com/docs/features/tailscale-funnel)).
- O proxy HTTPS termina TLS no daemon Tailscale e usa certificado provisionado automaticamente ([referência do comando](https://tailscale.com/docs/reference/tailscale-cli/serve#use-https-and-http-servers)).
- Conexões entre nodes já são criptografadas ponta a ponta; o HTTPS adicional satisfaz browsers e clientes que exigem TLS ([HTTPS no Tailscale](https://tailscale.com/docs/how-to/set-up-https-certificates#configure-https)).
- MagicDNS fornece nomes estáveis por máquina ([MagicDNS](https://tailscale.com/docs/features/magicdns#accessing-devices-over-magicdns)).

### O que `t3 connect` acrescenta de verdade

O caminho cloud do T3 não passa o tráfego da aplicação pelo Worker de relay. O Worker autentica o usuário, registra ambientes e provisiona um endpoint; o tráfego segue pelo hostname do Cloudflare Tunnel ([arquitetura](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/remote.md#L135-L145)).

No host, `t3 connect link`:

- autoriza a CLI por OAuth public client + PKCE, sem client secret;
- instala um `cloudflared` pinado se necessário;
- grava a intenção durável de publicar o ambiente;
- reconcilia e inicia o tunnel quando `t3 serve`/`t3 start` roda.

Esses comportamentos estão documentados em [`t3-connect.md`](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/t3-connect.md#L76-L118). O downloader fixa versão e SHA-256 por plataforma antes de ativar o binário ([`relayClient.ts`](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/packages/shared/src/relayClient.ts#L22-L99), [verificação](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/packages/shared/src/relayClient.ts#L280-L325)).

No control plane, o relay cria/reutiliza um tunnel Cloudflare por ambiente, configura ingress para a origin local, cria CNAME e devolve um connector token ([`ManagedEndpointProvider.ts`](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/infra/relay/src/environments/ManagedEndpointProvider.ts#L640-L855)). No host, esse token é passado ao processo `cloudflared tunnel run`, que é supervisionado e reiniciado se sair ([`ManagedEndpointRuntime.ts`](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/apps/server/src/cloud/ManagedEndpointRuntime.ts#L187-L287)).

Portanto, a experiência “mesma conta mostra todas as máquinas” depende de **registro de ambientes + identidade + tunnel provisioning**. O OpenCode atual já tem a parte client/server e a lista local de servidores, mas não tem esse registry de conta.

## Capacidades e lacunas do OpenCode

### O que já existe

`opencode serve` inicia um servidor HTTP headless em `127.0.0.1:4096` por padrão; `opencode web` adiciona a UI web. Ambos aceitam hostname, porta e CORS, e ambos podem ser protegidos com HTTP Basic por `OPENCODE_SERVER_PASSWORD` e `OPENCODE_SERVER_USERNAME` ([server](https://opencode.ai/docs/server/#usage), [autenticação](https://opencode.ai/docs/server/#authentication), [web](https://opencode.ai/docs/web/#configuration)).

O processo normal também é client/server: a TUI é um cliente do servidor HTTP, o protocolo possui OpenAPI 3.1 e foi desenhado para múltiplos clientes ([como funciona](https://opencode.ai/docs/server/#how-it-works)). A CLI conecta remotamente com `opencode attach`; o cliente web/desktop mantém uma lista de conexões HTTP com URL, usuário e senha e separa projetos por servidor ([source do cliente](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/app/src/context/server.tsx#L181-L242)).

### Autenticação de aplicação disponível, mas fora do MVP

A autenticação opcional do OpenCode é hoje um usuário/senha estático em Basic Auth. O servidor compara essas credenciais e, sem senha configurada, não exige autenticação ([implementação](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/server/src/auth.ts#L20-L57)). O MVP deliberadamente deixa essa camada desabilitada e confia na membership e policy da tailnet. Diferente do T3, não há no fluxo atual:

- pairing token de uso único;
- sessão separada por dispositivo;
- revogação individual de clients;
- scopes diferentes para leitura, operação e terminal;
- ticket WebSocket curto ou DPoP.

O T3 implementa exatamente essas camadas: pairing comum dá apenas scopes operacionais, sessions bearer duram 30 dias, DPoP dura uma hora e ticket WebSocket dura cinco minutos ([perfil de autenticação](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/environment-auth.md#L9-L29), [fluxos](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/internals/environment-auth.md#L31-L105)). Isso é inspiração para uma contribuição upstream ao OpenCode, não requisito para começar dentro de uma tailnet pessoal.

## Arquitetura recomendada

```text
Máquina central
  OpenCode Desktop / opencode attach / browser
        |
        | HTTP dentro do túnel WireGuard da tailnet
        v
100.x.y.z:4096 -> opencode serve
        |
        +-- filesystem, git, providers, sessões e processos da máquina A

vm-cliente-b.<tailnet>:4096
        |
        v
100.a.b.c:4096 -> outro opencode serve, totalmente independente
```

### Unidade de implantação

Usar **uma instância OpenCode por máquina/VM**, não por repositório. O servidor já expõe projetos e sessões, e o cliente central agrupa servidores e projetos. Isso elimina o vínculo “um Dev Container = uma instalação/sessão OpenCode”.

O `opencode serve` deve fazer bind no endereço retornado por `tailscale ip -4`, nunca em `0.0.0.0`. Assim o socket não escuta nas interfaces LAN/Wi-Fi. Tailscale Serve em loopback é uma alternativa opcional para HTTPS e identity headers, mas não é necessário para Desktop, TUI ou acesso direto ao `opencode web` dentro da tailnet.

### Identidade das máquinas

O nome MagicDNS é o identificador humano inicial (`cliente-a`, `vm-cliente-b`). Para automação, persistir também a URL completa retornada por `tailscale status --json`, porque o FQDN contém o nome da tailnet.

Não colocar “Cliente X”, domínio corporativo ou outros dados confidenciais no hostname. Para emitir o certificado público, o FQDN da máquina aparece em Certificate Transparency; Tailscale alerta explicitamente que os nomes ficam públicos, embora o acesso continue privado ([documentação HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates#machine-names-in-the-public-ledger)).

## MVP proposto para os comandos

Não implementar nesta etapa; esta é a interface recomendada para a substituição.

### `ax [--web] [diretório]`

Responsabilidade na máquina de execução:

1. validar `opencode` e o CLI `tailscale`;
2. verificar que Tailscale está online e obter o endereço com `tailscale ip -4`;
3. iniciar `opencode serve --hostname <IP-Tailscale> --port 4096` no diretório escolhido, ou `opencode web` quando `--web` for solicitado;
4. aguardar `/global/health` via `http://<IP-Tailscale>:4096`;
5. imprimir as URLs por IP e MagicDNS e os comandos de conexão para Desktop/TUI/browser.

Modo foreground é preferível no primeiro corte: sinais e exit status permanecem fáceis de entender. Depois, `ax service install` pode instalar `launchd`/`systemd --user` para disponibilidade após logout. `ax` não configura rotas do Tailscale e não mantém outro daemon além do próprio OpenCode.

### `ax status` e `ax stop`

- `status`: saúde do processo, IP/MagicDNS, URL e versão do OpenCode.
- `stop`: encerra a instância gerenciada.

### Remover `ap-host`

Não existe mais um host central de proxy. No equipamento central, usar diretamente:

- `opencode attach http://<MagicDNS>:4096` para TUI;
- `http://<MagicDNS>:4096` cadastrado no Desktop;
- `http://<MagicDNS>:4096` no browser quando a máquina executa `ax --web`.

O Desktop já é o registry funcional principal. Se depois for desejado um seletor de terminal, `ax attach <nome-ou-url>` pode ser adicionado ao mesmo comando, sem ressuscitar `ap-host`.

### Compatibilidade web

Há duas opções:

- iniciar `ax --web` e acessar `opencode web` em cada máquina pela própria URL HTTP da tailnet; é same-origin e o caminho mais simples;
- usar uma UI web central e cadastrar vários servers. Nesse caso, cada servidor remoto precisa permitir explicitamente a origin da UI com `--cors https://<ui-central>`. O OpenCode mantém uma allowlist de origins built-in e adiciona os valores passados por config/CLI ([implementação de CORS](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/server/src/cors.ts#L3-L25)).

Se a UI central for servida por HTTPS, os backends também precisarão de HTTPS para evitar mixed content; nesse modo específico, adicionar `ax --https` com Tailscale Serve sobre um backend em loopback. O T3 confirma a mesma restrição: uma UI HTTPS não consegue conectar a backend HTTP/WS e o browser continua falando diretamente com cada backend ([hosted pairing](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/docs/user/remote-access.md#L196-L214)).

## Autorização Tailscale recomendada

Não confiar na policy inicial sem verificá-la. Tailscale declara que ACLs/grants são deny-by-default **quando configurados**, mas a ausência da seção aplica a policy default allow-all entre devices ([ACLs](https://tailscale.com/docs/features/access-control/acls#how-acls-work)).

Criar grants restritos para:

- devices pessoais autorizados → porta 4096 dos nodes OpenCode;
- administração/SSH → portas separadas e grupo menor;
- nenhum acesso de devices de clientes entre si.

VMs e servidores não humanos podem receber tag própria; laptops de uso humano devem continuar associados ao usuário, pois Tailscale recomenda tags para service devices, não end-user devices ([tags](https://tailscale.com/docs/features/tags#tag-vs-user-authentication)). Planejar expiração de keys: quando a node key expira, o endpoint fica inacessível; nodes tagged têm expiração desabilitada por padrão ([key expiry](https://tailscale.com/docs/features/access-control/key-expiry)).

## Modelo de ameaça e riscos

### Impacto de uma node autorizada comprometida

O OpenCode remoto é deliberadamente uma interface de alto privilégio: expõe sessões, arquivos, PTY, ferramentas e execução no contexto do usuário da máquina. Uma node que os grants autorizam a alcançar a porta 4096 deve ser tratada como tendo acesso de shell a todos os recursos que esse usuário e o processo OpenCode conseguem ler ou alterar. A API oficial inclui arquivos, sessões, comandos, providers e eventos ([especificação do server](https://opencode.ai/docs/server/#apis)).

Mitigações do MVP:

- Tailscale grant restrito às nodes pessoais que devem controlar o OpenCode;
- OpenCode com bind exclusivo no IP `100.x`; nada em `0.0.0.0` ou no IP LAN;
- usuário de sistema dedicado ou sandbox quando o projeto de execução isolada avançar;
- não encaminhar Docker socket, SSH agent ou credenciais desnecessárias;
- manter OpenCode atualizado e testar bind/CORS após upgrades.

### Limites do Tailscale como autenticação

No modelo de confiança escolhido, Tailscale é a única camada de autenticação e autorização remota. Isso implica aceitar que:

- uma máquina pessoal comprometida ainda está dentro da tailnet;
- a policy default pode permitir mais peers do que o esperado;
- qualquer node autorizada à porta 4096 recebe a API OpenCode sem novo desafio;
- processos locais no host também podem alcançar o serviço pelo próprio IP Tailscale.

Esses riscos são compatíveis com uma tailnet pessoal pequena e confiável. Se devices menos confiáveis entrarem na mesma tailnet, restringir a porta 4096 com grants; Basic Auth continua sendo uma opção futura, não requisito do MVP.

### HTTPS opcional e colisões

Se `ax --https` for adicionado no futuro, Tailscale Serve 443 é configuração por node. Se outro serviço já ocupa o handler, o launcher deve recusar sobrescrever e oferecer porta HTTPS alternativa. O T3 faz probe e detecta exatamente esse conflito antes de publicar ([`pair.ts`](https://github.com/pingdotgg/t3code/blob/35172010b131510d36d0cef54e174926e38a3013/apps/server/src/cli/pair.ts#L101-L216)).

Uma rota `--bg` pode sobreviver ao processo OpenCode e resultar em endpoint 502/offline; isso é aceitável se `status` diagnosticar claramente. A alternativa é remover a rota no trap, mas ela reduz a estabilidade e conflita com o objetivo de daemon persistente.

## Comparação de alternativas

| Alternativa | Alcance | Auth | Complexidade | Recomendação |
|---|---|---|---|---|
| Bind no IP `100.x` sem Serve | Tailnet | grants Tailscale | mínima | **MVP** |
| OpenCode loopback + Tailscale Serve | Tailnet | grants Tailscale | baixa | opcional quando HTTPS for necessário |
| SSH local forwarding | Quem tem SSH | SSH | média por conexão | fallback e bootstrap; não é experiência always-on |
| Tailscale Funnel | Internet pública | ausente no app | baixa, mas exposição pública | não usar para o padrão |
| Cloudflare Tunnel + Access manual | Internet | Cloudflare Access | média | experimento posterior |
| Control plane estilo T3 Connect | Internet + descoberta por conta | OAuth/registry + app auth | alta | projeto OSS separado |
| FRP atual | depende do `frps` | token FRP compartilhado + app auth opcional | média | remover |

## Cloudflare como projeto open source futuro

Cloudflare Tunnel é apropriado como transport provider: `cloudflared` abre conexões outbound-only e não exige porta pública no origin ([arquitetura oficial](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/#how-it-works)). Cloudflare suporta WebSockets proxied; porém deployments do edge podem encerrar conexões, então o client precisa reconnect/keepalive ([WebSockets](https://developers.cloudflare.com/network/websockets/#technical-note)).

Não usar Quick Tunnel como produto: ele cria URL aleatória pública e é voltado a testes ([TryCloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/#use-trycloudflare)). Um tunnel publicado sem Access fica disponível a qualquer pessoa na internet; a própria Cloudflare recomenda criar Access antes da rota e validar o token no origin/`cloudflared` ([self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/#2-connect-your-origin-to-cloudflare)).

### Escopo mínimo sensato

Um projeto genérico poderia oferecer:

1. adapter de harness (`opencode`, futuramente outros) que só descreve comando, health endpoint e auth;
2. connector local que mantém o harness em loopback, instala/verifica `cloudflared` e supervisiona o processo;
3. registry/control plane self-hostable que autentica usuários e mantém apenas metadata de ambientes;
4. provider de endpoints Cloudflare que provisiona tunnel/DNS e emite connector token por ambiente;
5. client-side discovery que lista ambientes da mesma conta e cadastra o URL no harness UI;
6. protocolo de pairing/session próprio ou contribuição upstream, sem enviar a senha Basic do OpenCode ao registry.

Decisão de produto importante: oferecer infraestrutura compartilhada “grátis” cria custo e superfície de abuso. Para um primeiro release OSS, prefiro **self-hosted/BYO Cloudflare account**; a API cria tunnel e DNS na conta do usuário. Um serviço público patrocinado pode vir depois, com quotas, revogação, rate limits, abuse handling e observabilidade.

## Plano incremental recomendado

### Fase 1 — substituir FRP com Tailscale

- remover `ap-host` e substituir `ax` por `ax [--web] [diretório]`, com `status`/`stop` opcionais;
- resolver o CLI Tailscale no macOS e Linux;
- obter o IP Tailscale e fazer bind somente nele, sem Basic Auth;
- documentar cadastro no Desktop e `opencode attach`;
- remover `frpc`/`frps` do bootstrap somente após o novo fluxo passar em macOS e Ubuntu.

### Fase 2 — serviço persistente e hardening

- `launchd` no macOS e `systemd --user` no Linux;
- health/restart e logs;
- policy/grants Tailscale versionada com testes;
- detectar expiração da node key e ausência de MagicDNS;
- adicionar modo Tailscale Serve somente se uma UI HTTPS central exigir backends HTTPS;
- integrar o sandbox planejado sem misturá-lo ao transporte remoto.

### Fase 3 — UX de pairing e sync

- propor ao OpenCode pairing token one-time → session por dispositivo → revogação;
- importar/exportar inventário sem segredos ou sincronizar por um registry opt-in;
- QR/deep link somente depois de existir uma credencial curta apropriada para uso fora da tailnet.

### Fase 4 — provider Cloudflare OSS

- protótipo BYO Cloudflare + Access;
- separar control plane de application traffic como no T3;
- pin/checksum do connector, lifecycle e fail-closed;
- só então avaliar serviço compartilhado e clientes mobile/web fora da tailnet.

## Perguntas para decidir antes da implementação

1. Cada notebook de cliente pode entrar na tailnet pessoal, ou algumas organizações proíbem VPN/overlay de terceiros? Essas máquinas precisarão de SSH/Cloudflare como fallback.
2. Uma máquina deve servir todos os projetos, ou há necessidade real de múltiplas instâncias OpenCode isoladas no mesmo host? Isso muda a estratégia de portas/Serve.
3. O Desktop central é suficiente no início, ou a UI web central multi-servidor é requisito do primeiro release? A segunda opção adiciona CORS, HTTPS e browser policies.
4. O processo deve sobreviver a logout/reboot já no primeiro corte? Se sim, a fase de service manager entra no MVP.
5. As VMs são service devices tagged ou devices humanos? Isso muda grants e expiração de keys.

## Veredito

O trabalho “de hoje” não precisa recriar T3 Connect. O OpenCode já tem o runtime remoto e o cliente multi-server; a peça ausente é apenas um launcher conveniente. **OpenCode com bind exclusivo no IP Tailscale, sem Basic Auth, e conexão direta por MagicDNS** é a menor mudança que remove FRP e desacopla OpenCode de DevPod/Dev Containers. `ap-host` deve ser removido; `ax` sobrevive apenas como atalho, não como tunnel ou proxy.

A parte mais valiosa a copiar do T3 não é `cloudflared`; é a divisão entre environment, access e launch, seguida por pairing/session auth. Cloudflare pode virar um bom projeto OSS quando houver demanda por devices fora da tailnet, mas deve nascer como provider separado e com um modelo de identidade explícito, não como outro token estático de tunnel.
