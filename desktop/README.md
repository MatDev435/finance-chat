# Finance Chat para computador (Tauri 2)

App para Windows, macOS e Linux que:

- fica na **bandeja do sistema** e abre o Finance Chat (o mesmo site do navegador) na janela principal;
- abre o **registro rápido** com um atalho global (Alt+Espaço por padrão): **toque** para digitar, **segure** enquanto fala para ditar;
- transcreve a voz **no próprio computador** com o Whisper (whisper.cpp), com sons de início e fim da gravação.

A arquitetura, os fluxos e as decisões de acessibilidade estão em [docs/DESKTOP.md](../docs/DESKTOP.md).

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `src/` | Páginas embutidas no app: carregador (`index.html`, `quick.html`), configuração inicial e configurações do app (`settings.html`). |
| `src-tauri/src/` | Rust: janelas, bandeja, atalho global, voz (captura, Whisper, sons), modelos, comandos. |
| `src-tauri/permissions/default.toml` | Comandos que cada página pode chamar (o site só recebe o conjunto `site`). |
| `src-tauri/capabilities/local.json` | Permissões das páginas embutidas. A permissão do site é concedida em tempo de execução, só para o endereço configurado. |

## Requisitos para compilar

- Node.js 20+ e Rust estável (1.90 ou mais recente): <https://rustup.rs>.
- CMake e um compilador C/C++ (para o whisper.cpp).
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev libxdo-dev cmake build-essential
  ```
- **Windows:** Microsoft C++ Build Tools, WebView2 (já vem no Windows 10/11) e CMake.
- **macOS:** Xcode Command Line Tools e CMake.

Detalhes por sistema: <https://v2.tauri.app/start/prerequisites/>.

## Desenvolver e testar

```bash
cd desktop
npm ci
npm run dev                      # abre o app em modo de desenvolvimento
cd src-tauri && cargo test       # testes unitários (atalho, configurações, áudio, sons)
```

Teste de ponta a ponta da transcrição (opcional, não roda por padrão): precisa de um modelo e de um WAV PCM de 16 bits com uma fala em português.

```bash
FINANCE_CHAT_TEST_MODEL=~/ggml-small.bin FINANCE_CHAT_TEST_WAV=fala.wav FINANCE_CHAT_TEST_EXPECT=mercado \
  cargo test -- --ignored --nocapture
```

Para compilar sem o Whisper (por exemplo, sem CMake disponível): `cargo build --no-default-features`. O app funciona, e a voz informa que não está disponível nesta versão.

## Gerar os instaladores

```bash
cd desktop
npm ci
npm run build
```

Os arquivos ficam em `src-tauri/target/release/bundle/`:

| Sistema | Arquivos |
| --- | --- |
| Windows | `nsis/Finance Chat_<versão>_x64-setup.exe`, `msi/Finance Chat_<versão>_x64_en-US.msi` |
| macOS | `dmg/Finance Chat_<versão>_aarch64.dmg` (ou `x64`) |
| Linux | `appimage/finance-chat_<versão>_amd64.AppImage`, `deb/…_amd64.deb`, `rpm/…x86_64.rpm` |

Cada instalador é gerado no próprio sistema (Windows no Windows, e assim por diante). O workflow `.github/workflows/desktop.yml` gera os três em uma versão de rascunho no GitHub, quando acionado manualmente ou por uma tag `desktop-v*`.

**Assinatura:** sem certificado de assinatura, o Windows (SmartScreen) e o macOS (Gatekeeper) avisam que o app é de um desenvolvedor desconhecido. Para uso próprio, basta confirmar; para distribuir, configure a assinatura (<https://v2.tauri.app/distribute/sign/>).

## Oferecer os instaladores no Finance Chat

Copie os arquivos gerados para a pasta `DESKTOP_DIR` do servidor (padrão: `DATA_DIR/desktop`, por exemplo `/var/lib/finance-chat/desktop`):

```bash
sudo install -d -o finance-chat -g finance-chat -m 750 /var/lib/finance-chat/desktop
sudo install -o finance-chat -g finance-chat -m 640 "Finance Chat_0.1.0_x64-setup.exe" /var/lib/finance-chat/desktop/
```

Eles aparecem em **Configurações → App para computador**, com o botão para o sistema de quem acessa, todas as versões e o SHA-256 de cada arquivo. Só usuários com sessão podem baixar. Não é preciso reiniciar o servidor.

## Usar

1. Instale e abra o app. Na primeira vez, informe o endereço do seu Finance Chat (o mesmo do navegador) e entre normalmente.
2. Em **Configurações do app** (menu da bandeja), baixe o modelo de voz (o **Pequeno** é o recomendado; cerca de 490 MB, uma vez só).
3. Use **Alt+Espaço**: toque para digitar; segure, fale e solte para ditar. Enter envia, Ctrl+Enter aprova a prévia, Esc fecha.

**Linux com Wayland:** os atalhos globais só funcionam em sessões X11. No Wayland, crie um atalho do sistema que execute `finance-chat-desktop --quick` (abre o registro rápido; a voz fica no botão de microfone da janela), ou use o menu da bandeja.
