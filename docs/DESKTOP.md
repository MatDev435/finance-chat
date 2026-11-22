# App para computador (Tauri 2)

O app para computador (`desktop/`) é uma casca leve em volta do mesmo site do Finance Chat. Ele acrescenta três coisas que um PWA não consegue: ficar na bandeja do sistema, um **atalho global** para o registro rápido e **voz transcrita no computador**. Sessões, prévias, confirmações, desfazer e histórico continuam exatamente como no navegador. Como compilar e distribuir: [desktop/README.md](../desktop/README.md).

## Por que Tauri

- Usa o navegador embutido do sistema (WebView2 no Windows, WKWebView no macOS, WebKitGTK no Linux): instaladores de poucos MB e pouco uso de memória, ao contrário do Electron, que leva um Chromium inteiro.
- Bandeja, atalho global, instância única e início com o sistema são plugins oficiais.
- O lado nativo é Rust, onde a captura do microfone e o whisper.cpp rodam bem.

A Web Speech API **não** é usada no app: nas webviews embutidas ela não existe ou não funciona. O site continua usando a Web Speech API nos navegadores.

## Janelas

| Janela | Conteúdo |
| --- | --- |
| Principal | O site do Finance Chat. Fechar esconde na bandeja; sair pelo menu da bandeja. |
| Registro rápido | A página `/quick` do site, numa janela sem moldura, sempre por cima e sem ícone na barra de tarefas. A altura acompanha o conteúdo. Esconde com Esc, ao perder o foco ou depois de um registro bem-sucedido. |
| Configurações do app | Página embutida: endereço do servidor, atalho, modelo de voz, sons, início com o sistema. |

As janelas principal e rápida começam numa página embutida que confere o servidor (`GET /health`, feito pelo Rust) e então abre o site. Na primeira execução, ela pede o endereço. Servidor fora do ar: mensagem acessível com **Tentar de novo**.

## Atalho global: tocar ou segurar

```text
Alt+Espaço pressionado ─┬─ solto em menos de 280 ms → toque
                        │      janela rápida escondida → mostra para digitar
                        │      janela rápida em foco   → esconde
                        └─ ainda pressionado aos 280 ms → segurar
                               mostra a janela no modo voz, liga o microfone, som de início
                               solto → som de fim, transcreve, o texto entra no campo
```

- A decisão fica numa máquina de estados pura (`src-tauri/src/shortcut.rs`), testada sem timers. Ela absorve a repetição automática do teclado: em X11, segurar uma tecla gera pares solta/pressiona, então uma soltura só vale depois de 60 ms sem nova pressão.
- O atalho é configurável (Alt+Espaço, Ctrl+Shift+Espaço, Ctrl+Alt+Espaço, Win+Shift+Espaço). Se outro programa já usa o escolhido (por exemplo, o PowerToys Run usa Alt+Espaço), as configurações e o menu da bandeja avisam.
- O menu da bandeja pausa o atalho. `finance-chat-desktop --quick` abre o registro rápido (instância única), o que serve de alternativa no Wayland, onde atalhos globais não funcionam.

## Fluxo do registro rápido

1. A janela aparece com o foco no campo, na conta padrão (ou na última usada nela). Tab leva ao seletor de conta.
2. Digite ou dite. A transcrição **só preenche o campo** e é lida de volta para o leitor de tela; nada é enviado sozinho.
3. **Enter** envia para `POST /api/chat/preview`. A resposta aparece com os mesmos cards do chat: prévia, lote, esclarecimento, busca com gráfico, resumo.
4. **Ctrl+Enter** (⌘+Enter no macOS) aprova a prévia. Ele é ignorado nos primeiros 600 ms depois de a prévia aparecer, para que um segundo Enter por reflexo nunca aprove algo não lido. **Ctrl+1/2/3** escolhem uma categoria sugerida. Os botões também funcionam.
5. Depois de um registro limpo, a janela avisa e se esconde em 2,5 s; o desfazer continua por 10 minutos (botão ou "desfazer"). Registros com aviso (lote parcial, sincronização pendente) mantêm a janela aberta.
6. **Esc** só esconde: nunca cancela nem aprova. Uma prévia pendente continua lá ao reabrir (até expirar no servidor).
7. Tudo vai para o mesmo histórico da conta. A janela principal se atualiza quando o histórico muda ou quando ganha o foco, e "Abrir na conversa" leva à conta certa.

## Voz

- **Captura:** microfone padrão (cpal), numa thread dedicada, até soltar o atalho ou clicar de novo no microfone. O limite é de 60 s.
- **Sons:** tons gerados na hora, sem arquivos: dois tons subindo quando o microfone **começa a ouvir**, descendo quando para, um tom grave em erros. O áudio gravado durante o som de início é descartado. Os sons podem ser desligados.
- **Transcrição:** whisper.cpp (whisper-rs) em português, com o modelo carregado uma vez e mantido em memória.
  - Silêncio ou falas muito curtas nem chegam ao Whisper, que costuma inventar texto no silêncio.
  - Anotações como "[Música]" e alucinações conhecidas ("Legendas pela comunidade Amara.org") são removidas.
  - O prompt inicial é uma lista de palavras do domínio. Uma frase de exemplo no prompt foi copiada para a transcrição nos testes.
- **Modelos:** "Básico" (base, cerca de 150 MB) ou "Pequeno" (small, cerca de 490 MB, recomendado).
  - São baixados uma vez do repositório oficial do whisper.cpp no Hugging Face, com progresso.
  - O download usa um arquivo `.part` e verificação de tamanho.
  - Ficam na pasta de dados do app.
- **Resultado nos testes,** com voz sintetizada (espeak-ng) e o modelo small:
  - "Gastei 40 reais no mercado, categoria, alimentação."
  - "Quanto gastei com transporte, nos últimos três meses, por mês."
  - O parser aceita a pontuação típica de textos ditados.
- O áudio **nunca sai do computador**.

## Acessibilidade

Requisito do projeto em todas as janelas:

- As janelas têm títulos descritivos ("Registro rápido — Finance Chat"), que o leitor de tela anuncia ao aparecerem. O foco vai direto para o campo.
- O campo do registro rápido tem rótulo, e os atalhos ficam ligados a ele por `aria-describedby`.
- Cada mudança de estado tem uma linha de status visível e um anúncio numa região ao vivo: ouvindo, transcrevendo, texto transcrito (lido por inteiro), erros, modelo ausente, registrado.
- A voz tem duas sinalizações independentes: som e anúncio. Quem não ouve o som recebe o texto, e quem não vê a tela recebe o som e a fala.
- Páginas embutidas:
  - campos com `label` e grupos com `fieldset`/`legend`;
  - erros em `role="alert"` ou `role="status"`;
  - progresso do download com texto, anunciado a cada 25%;
  - foco visível, suporte a `prefers-reduced-motion` e `forced-colors`.
- A bandeja usa menus nativos do sistema, lidos pelos leitores de tela.
- A janela rápida se esconde sozinha só depois de anunciar o registro (2,5 s). O resultado continua no histórico da janela principal.

## Segurança

- O app abre o site configurado; o resto continua com o servidor (cookies `HttpOnly`, CSRF, CSP).
- O site só pode chamar o conjunto de comandos `site` (`src-tauri/permissions/default.toml`):
  - mostrar, esconder e redimensionar a janela rápida;
  - abrir a janela principal ou as configurações;
  - ligar e desligar a captura de voz;
  - ler um resumo (versão, atalho, se a voz está pronta).
- A permissão é concedida **em tempo de execução, só para a origem configurada**, e só nas janelas principal e rápida.
- O site **não** pode alterar configurações, baixar arquivos nem ler o sistema de arquivos.
- A captura de voz sempre toca o som de início (se ligado) e mostra o estado na janela rápida.
- A CSP do servidor só acrescenta os endereços do IPC do Tauri (`ipc:` e `http://ipc.localhost`) ao `connect-src`.
- Configurações do app sem segredos (endereço, atalho, modelo, sons) em JSON na pasta de configuração. A sessão fica nos cookies da webview, como num navegador.

## Limitações conhecidas

- Wayland: sem atalho global (use `--quick` num atalho do sistema e o botão de microfone).
- Linux: a bandeja precisa da `libayatana-appindicator3` (dependência do pacote `.deb`). Sem ela, o app funciona sem bandeja, e fechar a janela principal encerra o app.
- Sem assinatura de código, o Windows e o macOS mostram avisos na instalação.
- Sem atualização automática: novas versões são baixadas pelas configurações do site.
- O desempenho do Whisper depende do processador. O modelo small leva alguns segundos para frases curtas num processador comum, e o base é mais rápido e menos preciso.
