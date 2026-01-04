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
