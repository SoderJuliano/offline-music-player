# Player de Música Offline

🎵 **[Acesse o Player Online](https://offline-music-player.netlify.app/)**

## Sobre o Projeto

Um player de música offline que funciona diretamente no seu navegador. Adicione seus arquivos MP3 favoritos e eles ficarão salvos no banco de dados local do navegador (IndexedDB). Suas músicas estarão sempre disponíveis quando você voltar, mesmo sem conexão com a internet!

## Características

- 🎧 **Totalmente Offline**: Suas músicas são armazenadas localmente no navegador
- 💾 **Persistência de Dados**: Os arquivos ficam salvos mesmo após fechar o navegador
- 📱 **Responsivo**: Funciona perfeitamente em desktop e dispositivos móveis
- 🎨 **Visualizador de Áudio**: Animação de ondas sonoras (apenas em desktop)
- 📂 **Playlists Personalizadas**: Crie e organize suas playlists
- ✏️ **Edição de Playlists**: Renomeie suas playlists facilmente
- 🎵 **Reprodução em Background**: Continue ouvindo suas músicas em segundo plano (mobile)

## Como Usar

1. **Acesse o site**: [https://offline-music-player.netlify.app/](https://offline-music-player.netlify.app/)
2. **Adicione suas músicas**: Clique em "+ Adicionar Músicas" e selecione seus arquivos MP3
3. **Organize em playlists**: Crie e renomeie suas playlists como preferir
4. **Aproveite**: Suas músicas estarão salvas no navegador e disponíveis sempre que você voltar!

## Tecnologias Utilizadas

- **Vue 3**: Framework JavaScript progressivo
- **TypeScript**: Tipagem estática para JavaScript
- **Vite**: Build tool rápido e moderno
- **Dexie.js**: Wrapper para IndexedDB
- **Web Audio API**: Visualizador de áudio em tempo real
- **Ably Realtime**: Sinalização P2P via WebSocket para WebRTC
- **WebRTC**: Troca de dados P2P com STUN/TURN configuráveis

---

## Desenvolvimento Local

Para desenvolvedores que desejam rodar o projeto localmente:

### Requisitos

- Node.js (v20.19.0 ou >=22.12.0)

### Instalação

```sh
npm install
```

### Executar em Modo de Desenvolvimento

```sh
npm run dev
```

### Build para Produção

```sh
npm run build
```

### Type-Check

```sh
npm run type-check
```

## Recomendações de IDE

[VSCode](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (desabilitar Vetur se estiver instalado).

---

## P2P em Produção (Netlify)

Para que múltiplos usuários se vejam no mapa e troquem mensagens entre si em produção, esta app usa:

- Ably Realtime (WebSocket) para sinalização entre pares (negociação WebRTC)
- WebRTC com servidores STUN/TURN configuráveis para atravessar NAT

### Variáveis de Ambiente (Netlify)

Defina em Site settings → Environment variables:

- `VITE_ABLY_API_KEY`: chave do Ably (formato `xxxx:yyyy`).
- `VITE_ICE_SERVERS` (opcional): JSON com a lista de servidores ICE. Exemplo seguro (apenas STUN):

```json
[
	{ "urls": "stun:stun.l.google.com:19302" },
	{ "urls": "stun:global.stun.twilio.com:3478" }
]
```

Para máxima compatibilidade em redes restritivas, adicione um provedor TURN (ex.: Twilio, Metered, Xirsys). Exemplo de formato (substitua pelas suas credenciais):

```json
[
	{ "urls": "stun:stun.l.google.com:19302" },
	{ "urls": "turn:turn.yourprovider.com:3478", "username": "USER", "credential": "PASS" },
	{ "urls": "turns:turn.yourprovider.com:5349", "username": "USER", "credential": "PASS" }
]
```

Observações:

- Em hospedagens estáticas (Netlify), o Ably opera via WebSocket e faz o broadcast de presença, o que permite que cada novo usuário negocie P2P com todos os presentes.
- Se `VITE_ICE_SERVERS` não for definido, o app usa STUNs públicos como padrão. Sem TURN, algumas redes podem não conseguir conectar P2P.

### Deploy

1. Configure as variáveis acima em Netlify.
2. Faça o build localmente ou deixe o Netlify construir:

```sh
npm run build
```

3. Publique. A sinalização P2P usa WebSocket (forçado) e a presença via Ably para que o primeiro usuário receba os próximos que entrarem.
