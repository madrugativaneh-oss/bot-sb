# Bot de grupo WhatsApp (Node.js)

Comandos, moderação, dias de uso por grupo e detector de comprovativos M-Pesa / e-Mola.

## Requisitos
- Node.js 18 ou superior (https://nodejs.org)
- Google Chrome / Chromium (o `whatsapp-web.js` baixa o seu próprio ao instalar)

## Instalar e iniciar
```bash
npm install
npm start
```
1. Escaneie o QR code que aparece no terminal (WhatsApp > Aparelhos conectados).
2. No grupo, o criador (872120576) envia: `.ativarSB`

Para mudar o número do criador, edite `OWNER_NUMBER` no topo do `bot.js`
ou inicie assim: `OWNER_NUMBER=872120576 npm start`

## Deixar sempre ligado (servidor / VPS)
```bash
npm i -g pm2
pm2 start bot.js --name whatsapp-bot
pm2 save && pm2 startup
```
Ver registos: `pm2 logs whatsapp-bot`

## Pastas importantes (faça cópia de segurança)
- `.wwebjs_auth/` – sessão do WhatsApp (se apagar, tem de escanear o QR de novo)
- `data/` – contas, comandos, dias dos grupos, pagamentos e opções

## Principais comandos
- Criador: `.ativarSB`, `.desativarSB`, `.adddia ID dias`, `.deldia ID [dias]`, `.grupos`,
  `.addmpesa 85XXXXXXX - nome`, `.addemola 87XXXXXXX - nome`, `.nanoadd comando, resposta`
- Admins: `.abrir`, `.fechar`, `.ban`, `.promover`, `.rebaixar`, `.todos`, `.link`,
  `.antilink on/off`, `.antispam on/off`, `.bemvindo on/off`, `.setregras`
- Todos: `.menu`, `.contas`, `.regras`, `.pagamentos`, e as palavras-chave criadas com `.nanoadd`

Use `.menu` no grupo para ver a lista completa.

## Linux sem ecrã (VPS)
Se o Chromium falhar ao iniciar, instale as bibliotecas:
```bash
sudo apt update && sudo apt install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2
```
