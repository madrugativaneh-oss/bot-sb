/**
 * Bot de grupo WhatsApp (whatsapp-web.js)
 * - Responde a comandos no grupo
 * - Permite adicionar/remover comandos (.nanoadd / .delcmd) – só o criador
 * - Só fica ativo no grupo depois que o número do criador o ativar (.ativarSB)
 * - Reconhece comprovativos M-Pesa e e-Mola (texto e imagem via OCR)
 *
 * Instalação:
 *   npm init -y
 *   npm i whatsapp-web.js qrcode-terminal tesseract.js
 *
 * Uso:
 *   1) Edite OWNER_NUMBER abaixo (872120576 ou 258872120576)
 *   2) node bot.js  → escaneie o QR code
 *   3) No grupo, o criador envia: .ativarSB
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let Tesseract = null;
try { Tesseract = require('tesseract.js'); } catch (_) { /* OCR opcional */ }

// ===================== CONFIGURAÇÃO =====================
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '872120576').replace(/\D/g, '');
const PREFIX = '.';
const ANTILINK_ACTION = 'remove';    // 'remove' = apaga a mensagem e remove quem enviou | 'delete' = só apaga
const SPAM_MAX_MSGS = 6;             // mais de 6 mensagens...
const SPAM_WINDOW_MS = 8 * 1000;     // ...em 8 segundos = spam
const SPAM_STRIKES_TO_REMOVE = 3;    // após 3 avisos, remove o membro
const REMINDER_DAYS = [3, 1];           // avisa o criador 3 dias e 1 dia antes de expirar (e quando expira)
const CHECK_EVERY_MS = 30 * 60 * 1000; // verifica a cada 30 minutos
const KEYWORD_MAX_WORDS = 12;        // só reage a mensagens curtas (evita disparar em conversa longa)
const KEYWORD_COOLDOWN_MS = 30 * 1000; // não repete a mesma resposta no grupo durante 30s
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  commands: path.join(DATA_DIR, 'commands.json'),
  groups: path.join(DATA_DIR, 'groups.json'),
  payments: path.join(DATA_DIR, 'payments.json'),
  accounts: path.join(DATA_DIR, 'accounts.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  subs: path.join(DATA_DIR, 'subscriptions.json'),
  notices: path.join(DATA_DIR, 'notices.json'),
};
// ========================================================

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const load = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let customCommands = load(FILES.commands, {
  regras: 'Respeite todos os membros. Sem spam nem links não autorizados.',
});
let activeGroups = load(FILES.groups, []);
let payments = load(FILES.payments, []);
// contas que recebem pagamentos, por grupo: { gid: [{ number, name }] }
let accounts = load(FILES.accounts, {});
// validade por grupo (dias adicionados com .adddia): { gid: timestampDeExpiracao }
let subs = load(FILES.subs, {});
// avisos já enviados ao criador: { gid: { exp, sent: ['d3','d1','expirado'] } }
let notices = load(FILES.notices, {});
// opções por grupo: { gid: { antilink, antispam, bemvindo, welcome } }
let settings = load(FILES.settings, {});
const gs = gid => (settings[gid] = settings[gid] || { antilink: false, antispam: false, bemvindo: false, welcome: null });
const saveSettings = () => save(FILES.settings, settings);

const ADMIN_CMDS = new Set(['abrir', 'fechar', 'ban', 'promover', 'rebaixar', 'todos', 'link', 'antilink', 'antispam', 'bemvindo', 'setregras', 'setbemvindo']);
const BOT_ADMIN_CMDS = new Set(['abrir', 'fechar', 'ban', 'promover', 'rebaixar', 'link']);
const RESERVED = ['ajuda', 'menu', 'ping', 'comprovativo', 'pagamentos', 'nanoadd', 'delcmd', 'listcmd', 'ativarsb', 'desativarsb', 'desativar',
  'addmpesa', 'addemola', 'contas', 'delconta', 'regras', 'setregras', 'setbemvindo', 'adddia', 'deldia', 'dias', 'grupos', 'idgrupo', ...ADMIN_CMDS];

// ===================== COMPROVATIVOS =====================
function detectOperator(text) {
  const t = text.toLowerCase();
  if (/m-?pesa|vodacom/.test(t)) return 'M-Pesa';
  if (/e-?mola|movitel/.test(t)) return 'e-Mola';
  // SMS sem nome da operadora: deduz pelo formato
  if (/\bconfirmad[oa]\s+[a-z0-9]{8,14}\b/.test(t)) return 'M-Pesa';
  if (/id\s+da\s+transac[aã]o\s*:?\s*pp\d/.test(t)) return 'e-Mola';
  return null;
}

function parsePayment(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const operator = detectOperator(clean);

  // Valor: 500.00MT, 500,00 MT, 500 MZN, MT 500
  const amountMatch =
    clean.match(/(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:MT|MZN|MTn)\b/i) ||
    clean.match(/\b(?:MT|MZN)\s*(\d+(?:[.,]\d{1,2})?)/i);

  // ID da transação: "Confirmado XXXXXXXX" (M-Pesa) / "ID da transacao: XXXX" (e-Mola)
  const idMatch =
    clean.match(/Confirmad[oa]\s+([A-Z0-9]{8,14})/i) ||
    clean.match(/(?:ID(?:\s+da)?\s+transac[aã]o|Ref(?:er[eê]ncia)?|Transaction\s*ID)\s*[:\-]?\s*([A-Z0-9.\-]{6,25})/i);

  // Número de telefone moçambicano: 82/83/84/85/86/87 + 7 dígitos
  const phones = [...clean.matchAll(/(?:\+?258)?\s?(8[2-7]\d{7})/g)].map(m => m[1]);

  const dateMatch = clean.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  const timeMatch = clean.match(/(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i);

  const kind = /recebeste|recebeu|received/i.test(clean) ? 'recebido'
    : /transferiste|transferiu|enviaste|enviou|pagaste|pagou|sent|paid/i.test(clean) ? 'enviado'
    : 'indefinido';

  let amount = null;
  if (amountMatch) {
    let a = amountMatch[1].replace(/\s/g, '');
    if (/,\d{1,2}$/.test(a)) a = a.replace(/\./g, '').replace(',', '.');
    else a = a.replace(/,/g, '');
    amount = parseFloat(a);
  }

  // Destinatário (quem recebeu o dinheiro): "para conta 86..., nome: X as ..." ou "para 84... - X em ..."
  const toNum = clean.match(/\bpara\s+(?:a\s+)?(?:conta\s+)?(?:\+?258)?\s?(8[2-7]\d{7})/i);
  const nameMatch =
    clean.match(/\bnome\s*:\s*(.+?)\s+(?:as|às|aos|em|at)\s/i) ||
    clean.match(/\bpara\s+(?:a\s+)?(?:conta\s+)?(?:\+?258)?\s?8[2-7]\d{7}\s*[-–]\s*(.+?)\s+(?:as|às|aos|em|at)\s/i);

  const isReceipt = !!(operator && amount && (idMatch || kind !== 'indefinido'));
  return {
    isReceipt,
    operator,
    id: idMatch ? idMatch[1].replace(/[.\-]+$/, '') : null,
    amount,
    kind,
    recipientNumber: toNum ? toNum[1] : null,
    recipientName: nameMatch ? nameMatch[1].trim() : null,
    phones: [...new Set(phones)],
    date: dateMatch ? dateMatch[1] : null,
    time: timeMatch ? timeMatch[1] : null,
  };
}

const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const last9 = n => (n || '').replace(/\D/g, '').slice(-9);

function nameMatches(registered, found) {
  const reg = norm(registered).split(' ').filter(t => t.length > 1);
  const got = new Set(norm(found).split(' '));
  if (!reg.length || got.size === 0) return false;
  const hits = reg.filter(t => got.has(t)).length;
  return reg.length <= 2 ? hits === reg.length : hits / reg.length >= 0.6;
}

/**
 * Compara o comprovativo com as contas registadas no grupo.
 * status: 'ok' | 'nome' | 'invalido' | 'desconhecido' | 'sem-contas'
 */
function validatePayment(p, list) {
  if (!list || !list.length) return { status: 'sem-contas' };
  if (p.kind === 'recebido' || (!p.recipientNumber && !p.recipientName)) return { status: 'desconhecido' };
  if (p.recipientNumber) {
    const acc = list.find(a => last9(a.number) === last9(p.recipientNumber));
    if (!acc) return { status: 'invalido' };
    if (p.operator && acc.operator && p.operator !== acc.operator) return { status: 'operadora', account: acc };
    if (p.recipientName && !nameMatches(acc.name, p.recipientName)) return { status: 'nome', account: acc };
    return { status: 'ok', account: acc };
  }
  const acc = list.find(a => nameMatches(a.name, p.recipientName));
  return acc ? { status: 'ok', account: acc } : { status: 'invalido' };
}

async function ocrImage(media) {
  if (!Tesseract) return '';
  const buffer = Buffer.from(media.data, 'base64');
  const { data } = await Tesseract.recognize(buffer, 'por+eng');
  return data.text || '';
}

// "28/10/2026 às 12:52" – usa a data/hora do SMS; se faltar, usa a hora da mensagem
function fmtReceivedAt(p, msg) {
  const TZ = 'Africa/Maputo';
  const ts = new Date(((msg && msg.timestamp) || Date.now() / 1000) * 1000);
  let date = null;
  if (p.date) {
    const m = p.date.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) date = `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3].length === 2 ? '20' + m[3] : m[3]}`;
  }
  if (!date) date = ts.toLocaleDateString('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

  let time = null;
  const t = (p.time || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
  if (t) {
    let h = parseInt(t[1], 10);
    if (t[3]) { const pm = t[3].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    time = `${String(h).padStart(2, '0')}:${t[2]}`;
  }
  if (!time) time = ts.toLocaleTimeString('pt-PT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} às ${time}`;
}

function buildReceiptReply(p, v, msg, senderNumber) {
  const acc = v.account || {};
  const header = {
    ok: '✅ *Comprovante detectado com sucesso* 🇲🇿',
    desconhecido: '✅ *Comprovante detectado com sucesso* 🇲🇿',
    'sem-contas': '✅ *Comprovante detectado com sucesso* 🇲🇿',
    nome: `⚠️ *Comprovante detectado, mas o nome não confere* com a conta registada (${acc.name}).`,
    operadora: `⚠️ *Comprovante detectado, mas a operadora é diferente*: a conta ${acc.number} é ${acc.operator}.`,
    invalido: '❌ *Comprovante detectado, mas o destinatário não é uma conta registada.* Use .contas para ver as corretas.',
  }[v.status];

  const receiver = last9(senderNumber) || senderNumber;
  return [
    header,
    '',
    p.id ? `🔑 *Chave:* \`${p.id}\`` : null,
    `💳 *Valor:* ${p.amount.toFixed(2)} MT`,
    p.recipientName ? `🏷️ *Nome do destinatário:* ${p.recipientName}` : null,
    p.recipientNumber ? `☎️ *Destinatário:* ${p.recipientNumber}` : null,
    `⏰ *Recebido em:* ${fmtReceivedAt(p, msg)}`,
    `👁️ *Número a receber:* ${receiver}`,
    '',
    '🙏 Obrigado por enviar o comprovativo',
  ].filter(l => l !== null).join('\n');
}

async function handlePaymentCandidate(msg, text, senderNumber) {
  const p = parsePayment(text);
  if (!p.isReceipt) return false;
  const gid = (await msg.getChat()).id._serialized;
  const v = validatePayment(p, accounts[gid]);

  if (p.id && payments.some(x => (x.id || '').toUpperCase() === p.id.toUpperCase())) {
    await msg.reply(`⚠️ *Comprovante duplicado*\n🔑 *Chave:* \`${p.id}\`\nEste comprovativo já foi enviado antes.`);
    return true;
  }

  payments.push({
    id: p.id,
    operator: p.operator,
    amount: p.amount,
    kind: p.kind,
    phones: p.phones,
    date: p.date,
    time: p.time,
    sender: senderNumber,
    group: gid,
    validation: v.status,
    recipientNumber: p.recipientNumber,
    recipientName: p.recipientName,
    registeredAt: new Date().toISOString(),
  });
  save(FILES.payments, payments);

  await msg.reply(buildReceiptReply(p, v, msg, senderNumber));
  return true;
}

// ===================== BOT =====================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', qr => {
  console.log('Escaneie o QR code com o WhatsApp:');
  qrcode.generate(qr, { small: true });
});
let checkerStarted = false;
client.on('ready', () => {
  console.log('✅ Bot pronto. Criador:', OWNER_NUMBER);
  if (checkerStarted) return;
  checkerStarted = true;
  checkSubscriptions().catch(e => console.error(e));
  setInterval(() => checkSubscriptions().catch(e => console.error(e)), CHECK_EVERY_MS);
});
client.on('auth_failure', m => console.error('Falha de autenticação:', m));

// ===================== PALAVRA-CHAVE (sem prefixo) =====================
// Se alguém escrever, por exemplo, "pagamento", o bot responde com o texto do
// comando "pagamento" criado com .nanoadd pagamento, Resposta
const lastKeyword = {};

function matchKeyword(text) {
  const words = norm(text).split(' ').filter(Boolean);
  if (!words.length || words.length > KEYWORD_MAX_WORDS) return null;
  const set = new Set(words);
  for (const [name, reply] of Object.entries(customCommands)) {
    if (set.has(norm(name))) return { name, reply };
  }
  return null;
}

async function handleKeyword(msg, text, gid) {
  const hit = matchKeyword(text);
  if (!hit) return false;
  const key = gid + ':' + hit.name;
  const now = Date.now();
  if (lastKeyword[key] && now - lastKeyword[key] < KEYWORD_COOLDOWN_MS) return true;
  lastKeyword[key] = now;
  await msg.reply(hit.reply);
  return true;
}

async function isOwner(msg) {
  if (msg.fromMe) return true;
  try {
    const contact = await msg.getContact();
    const num = (contact.number || '').replace(/\D/g, '');
    if (num && last9(num) === last9(OWNER_NUMBER)) return true;
  } catch (_) {}
  const raw = (msg.author || msg.from || '').split('@')[0].replace(/\D/g, '');
  return !!raw && last9(raw) === last9(OWNER_NUMBER);
}

// ===================== GESTÃO DE GRUPO / MODERAÇÃO =====================
const GROUP_LINK_RE = /chat\.whatsapp\.com\/[A-Za-z0-9]+/i;
const spamLog = {};
const spamStrikes = {};

function findParticipant(chat, contact) {
  const id = contact.id._serialized;
  return chat.participants.find(p => p.id._serialized === id) ||
    (contact.number ? chat.participants.find(p => p.id.user === contact.number) : null);
}

async function isGroupAdmin(chat, msg) {
  try {
    const p = findParticipant(chat, await msg.getContact());
    return !!(p && (p.isAdmin || p.isSuperAdmin));
  } catch { return false; }
}

function botIsAdmin(chat) {
  const me = client.info && client.info.wid;
  if (!me) return false;
  const p = chat.participants.find(x => x.id._serialized === me._serialized || x.id.user === me.user);
  return !!(p && (p.isAdmin || p.isSuperAdmin));
}

// @pessoa mencionada, ou autor da mensagem respondida
async function targetsFrom(msg) {
  const ids = (await msg.getMentions()).map(c => c.id._serialized);
  if (!ids.length && msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage();
    ids.push(q.author || q.from);
  }
  return [...new Set(ids.filter(Boolean))];
}

// devolve true se a mensagem foi tratada (apagada) e não deve ser processada
async function moderate(msg, chat, s, gid) {
  const contact = await msg.getContact();
  const uid = contact.id._serialized;
  const tag = '@' + contact.id.user;
  const canAct = botIsAdmin(chat);
  if (!canAct) return false;

  if (s.antilink && GROUP_LINK_RE.test(msg.body || '')) {
    try { await msg.delete(true); } catch (_) {}
    if (ANTILINK_ACTION === 'remove') {
      try { await chat.removeParticipants([uid]); } catch (_) {}
      await chat.sendMessage(`🚫 ${tag} foi removido: links de grupo não são permitidos.`, { mentions: [uid] });
    } else {
      await chat.sendMessage(`🚫 ${tag}, links de grupo não são permitidos aqui.`, { mentions: [uid] });
    }
    return true;
  }

  if (s.antispam) {
    const key = gid + ':' + uid;
    const now = Date.now();
    const arr = (spamLog[key] = (spamLog[key] || []).filter(t => now - t < SPAM_WINDOW_MS));
    arr.push(now);
    if (arr.length > SPAM_MAX_MSGS) {
      try { await msg.delete(true); } catch (_) {}
      if (arr.length === SPAM_MAX_MSGS + 1) { // avisa uma vez por rajada
        spamStrikes[key] = (spamStrikes[key] || 0) + 1;
        if (spamStrikes[key] >= SPAM_STRIKES_TO_REMOVE) {
          spamStrikes[key] = 0;
          try { await chat.removeParticipants([uid]); } catch (_) {}
          await chat.sendMessage(`🚫 ${tag} foi removido por spam.`, { mentions: [uid] });
        } else {
          await chat.sendMessage(`⚠️ ${tag}, pare de enviar mensagens em excesso (aviso ${spamStrikes[key]}/${SPAM_STRIKES_TO_REMOVE}).`, { mentions: [uid] });
        }
      }
      return true;
    }
  }
  return false;
}

// ===================== DIAS DE USO POR GRUPO (pelo ID do grupo) =====================
const DAY_MS = 24 * 60 * 60 * 1000;
const expiredNotified = {};
const SUB_CMDS = new Set(['adddia', 'deldia', 'grupos', 'dias', 'idgrupo']);

function normGid(x) {
  x = (x || '').trim();
  if (!x) return null;
  if (!x.includes('@')) x += '@g.us';
  return /^\d{10,}(?:-\d+)?@g\.us$/.test(x) ? x : null;
}

// ativo = ligado com .ativarSB / .adddia e (sem validade ou validade ainda não passou)
function isGroupActive(gid) {
  if (!activeGroups.includes(gid)) return false;
  const e = subs[gid];
  return !e || e > Date.now();
}

const fmtDate = ms => new Date(ms).toLocaleDateString('pt-PT', { timeZone: 'Africa/Maputo' });

function statusText(gid) {
  if (!activeGroups.includes(gid)) return '🔴 inativo';
  const e = subs[gid];
  if (!e) return '🟢 ativo (sem limite de dias)';
  if (e <= Date.now()) return `🔴 expirado em ${fmtDate(e)}`;
  return `🟢 ativo – ${Math.ceil((e - Date.now()) / DAY_MS)} dia(s), expira em ${fmtDate(e)}`;
}

async function chatName(gid) {
  try { const c = await client.getChatById(gid); return c && c.isGroup ? c.name : null; } catch { return null; }
}

function parseGidDays(tokens, chat) {
  // no grupo: ".adddia 30" usa o próprio grupo | em qualquer lugar: ".adddia ID 30"
  if (chat.isGroup && tokens.length === 1 && /^\d{1,4}$/.test(tokens[0])) {
    return { gid: chat.id._serialized, days: parseInt(tokens[0], 10), hasDays: true };
  }
  return { gid: normGid(tokens[0]), days: parseInt(tokens[1], 10), hasDays: tokens.length > 1 };
}

async function handleSubscription(msg, chat, cmd, rest, owner) {
  const inGroup = chat.isGroup;
  const tokens = rest.split(/\s+/).filter(Boolean);
  const deny = () => undefined; // quem não é o criador não recebe resposta (o comando fica "invisível")

  if (cmd === 'idgrupo') {
    if (!inGroup) return msg.reply('Use .idgrupo dentro do grupo.');
    if (!(owner || (await isGroupAdmin(chat, msg)))) return msg.reply('⛔ Apenas administradores podem ver o ID.');
    return msg.reply(`🆔 ID do grupo:\n${chat.id._serialized.replace('@g.us', '')}`);
  }

  if (cmd === 'dias') {
    let gid = inGroup ? chat.id._serialized : null;
    if (tokens[0]) {
      if (!owner) return deny();
      gid = normGid(tokens[0]);
    } else if (!owner && !(inGroup && (await isGroupAdmin(chat, msg)))) {
      return inGroup ? msg.reply('⛔ Apenas administradores podem ver os dias.') : undefined;
    }
    if (!gid) return msg.reply('Uso: .dias ID_DO_GRUPO (ou só .dias dentro do grupo)');
    return msg.reply(`📅 ${(await chatName(gid)) || 'Grupo'}\n${statusText(gid)}`);
  }

  if (!owner) return deny();

  if (cmd === 'grupos') {
    const ids = [...new Set([...activeGroups, ...Object.keys(subs)])];
    if (!ids.length) return msg.reply('Nenhum grupo registado.');
    const lines = [];
    for (const gid of ids) {
      lines.push(`• *${(await chatName(gid)) || 'grupo desconhecido'}*\n  ${gid.replace('@g.us', '')}\n  ${statusText(gid)}`);
    }
    return msg.reply('📋 *Grupos*\n\n' + lines.join('\n\n'));
  }

  if (cmd === 'adddia') {
    const { gid, days } = parseGidDays(tokens, chat);
    if (!gid || !(days > 0 && days <= 3650)) {
      return msg.reply('Uso: .adddia ID_DO_GRUPO dias\nExemplo: .adddia 120363XXXXXXXXXXXX 30\n(dentro do grupo basta: .adddia 30)');
    }
    const name = await chatName(gid);
    if (!name) return msg.reply('⚠️ Não encontrei esse grupo. Confirme o ID (use .idgrupo no grupo) e se o bot está nele.');
    subs[gid] = Math.max(Date.now(), subs[gid] || 0) + days * DAY_MS;
    if (!activeGroups.includes(gid)) activeGroups.push(gid);
    expiredNotified[gid] = false;
    save(FILES.subs, subs);
    save(FILES.groups, activeGroups);
    return msg.reply(`✅ +${days} dia(s) para *${name}*\n${statusText(gid)}`);
  }

  if (cmd === 'deldia') {
    const { gid, days, hasDays } = parseGidDays(tokens, chat);
    if (!gid || (hasDays && !(days > 0))) {
      return msg.reply('Uso: .deldia ID_DO_GRUPO dias  (remove dias)\nou: .deldia ID_DO_GRUPO  (desativa o grupo)');
    }
    if (!activeGroups.includes(gid) && !subs[gid]) return msg.reply('Esse grupo não está registado.');
    const name = (await chatName(gid)) || gid.replace('@g.us', '');
    if (hasDays && !subs[gid]) {
      return msg.reply('Esse grupo não tem limite de dias. Use .deldia ID_DO_GRUPO (sem dias) para desativar.');
    }
    const novo = hasDays ? subs[gid] - days * DAY_MS : 0;
    if (!hasDays || novo <= Date.now()) {
      activeGroups = activeGroups.filter(g => g !== gid);
      delete subs[gid];
      save(FILES.groups, activeGroups);
      save(FILES.subs, subs);
      return msg.reply(`🔴 *${name}* desativado.`);
    }
    subs[gid] = novo;
    save(FILES.subs, subs);
    return msg.reply(`➖ -${days} dia(s) em *${name}*\n${statusText(gid)}`);
  }
}

// ===================== AVISOS DE RENOVAÇÃO AO CRIADOR =====================
async function notifyOwner(text) {
  try {
    const id = await client.getNumberId('258' + last9(OWNER_NUMBER));
    if (!id) { console.warn('Não consegui resolver o número do criador:', OWNER_NUMBER); return false; }
    await client.sendMessage(id._serialized, text);
    return true;
  } catch (e) {
    console.error('Falha ao avisar o criador:', e.message);
    return false;
  }
}

async function checkSubscriptions() {
  const now = Date.now();
  for (const [gid, exp] of Object.entries(subs)) {
    if (!activeGroups.includes(gid)) continue;
    if (!notices[gid] || notices[gid].exp !== exp) notices[gid] = { exp, sent: [] }; // renovou → recomeça
    const n = notices[gid];
    const left = exp - now;
    let stage = null;
    if (left <= 0) stage = 'expirado';
    else for (const d of [...REMINDER_DAYS].sort((x, y) => x - y)) {
      if (left <= d * DAY_MS) { stage = 'd' + d; break; }
    }
    if (!stage || n.sent.includes(stage)) continue;

    const name = (await chatName(gid)) || 'grupo';
    const id = gid.replace('@g.us', '');
    const text = stage === 'expirado'
      ? `⏰ *Plano EXPIRADO*\nGrupo: *${name}*\nExpirou em ${fmtDate(exp)}. O bot parou de responder nesse grupo.\n\nPara renovar:\n${PREFIX}adddia ${id} 30`
      : `⚠️ *Renovar o plano*\nGrupo: *${name}*\nExpira em ${Math.ceil(left / DAY_MS)} dia(s) (${fmtDate(exp)}).\n\nPara renovar:\n${PREFIX}adddia ${id} 30`;
    if (await notifyOwner(text)) { n.sent.push(stage); save(FILES.notices, notices); }
  }
}

// ===================== MENU =====================
// Os comandos de criador (🔒) só aparecem no menu quando é o criador a pedir.
const BUILTIN_HELP = (extra, isOwnerView) =>
  `*GESTÃO DE GRUPO* _(admins)_\n` +
  `${PREFIX}abrir – abre o grupo para todos falarem\n` +
  `${PREFIX}fechar – fecha o grupo (só adm fala)\n` +
  `${PREFIX}ban @pessoa – remove pessoa\n` +
  `${PREFIX}promover @pessoa – vira adm\n` +
  `${PREFIX}rebaixar @pessoa – tira adm\n` +
  `${PREFIX}todos – marca todos do grupo\n` +
  `${PREFIX}link – pega o link do grupo\n` +
  `${PREFIX}idgrupo – mostra o ID do grupo\n` +
  `${PREFIX}dias – dias restantes do plano\n` +
  `\n*SEGURANÇA & MODERAÇÃO* _(admins)_\n` +
  `${PREFIX}antilink on/off – bloqueia quem manda link de grupo\n` +
  `${PREFIX}antispam on/off – bloqueia spam\n` +
  `${PREFIX}bemvindo on/off – mensagem automática para quem entra\n` +
  `${PREFIX}setbemvindo texto – muda a mensagem ({user} e {grupo})\n` +
  `${PREFIX}regras – manda as regras do grupo\n` +
  `${PREFIX}setregras texto – define as regras\n` +
  `\n*PAGAMENTOS*\n` +
  `${PREFIX}contas – contas que recebem pagamentos\n` +
  `${PREFIX}pagamentos – últimos comprovativos\n` +
  `${PREFIX}comprovativo – como enviar comprovativo\n` +
  (extra.length ? `\n*RESPOSTAS RÁPIDAS*\n${extra.map(c => PREFIX + c).join(' ')}\n` : '') +
  (isOwnerView
    ? `\n*🔒 SÓ O CRIADOR*\n` +
      `${PREFIX}ativarSB / ${PREFIX}desativarSB – liga/desliga o bot no grupo\n` +
      `${PREFIX}adddia ID dias – adiciona dias e ativa o grupo\n` +
      `${PREFIX}deldia ID [dias] – remove dias (sem dias = desativa)\n` +
      `${PREFIX}dias ID – dias restantes de um grupo\n` +
      `${PREFIX}grupos – lista grupos e dias\n` +
      `${PREFIX}addmpesa 85XXXXXXX - nome – regista conta M-Pesa\n` +
      `${PREFIX}addemola 87XXXXXXX - nome – regista conta e-Mola\n` +
      `${PREFIX}delconta número – remove conta\n` +
      `${PREFIX}nanoadd comando, resposta – adiciona resposta\n` +
      `${PREFIX}delcmd nome – remove resposta\n` +
      `${PREFIX}listcmd – lista respostas\n`
    : '') +
  `\n*GERAIS*\n` +
  `${PREFIX}menu / ${PREFIX}ajuda – mostra os comandos\n` +
  `${PREFIX}ping – testa o bot`;

client.on('message_create', async msg => {
  try {
    const chat = await msg.getChat();
    const body = (msg.body || '').trim();
    const owner = await isOwner(msg);
    const gid = chat.id._serialized;
    const active = chat.isGroup && isGroupActive(gid);

    // comando = prefixo seguido de letra (evita confundir com "..." no texto)
    const isCommand = body.startsWith(PREFIX) && /^[a-zA-Z]/.test(body.slice(PREFIX.length));
    const [rawCmd, ...args] = isCommand ? body.slice(PREFIX.length).split(/\s+/) : [''];
    const cmd = (rawCmd || '').toLowerCase();
    const rest = isCommand ? body.slice(PREFIX.length + (rawCmd || '').length).trim() : '';

    // --- Dias de uso por ID do grupo: funciona no privado do bot e nos grupos, mesmo se inativo ---
    if (isCommand && SUB_CMDS.has(cmd)) {
      if (msg.fromMe && !owner) return;
      return handleSubscription(msg, chat, cmd, rest, owner);
    }

    if (!chat.isGroup) return; // fora disso, só grupos

    // --- Ativar / desativar (somente o criador, funciona mesmo se inativo) ---
    if (isCommand && ['ativarsb', 'desativarsb', 'desativar'].includes(cmd)) {
      if (!owner) return; // só o criador: para os outros o comando não existe
      if (cmd === 'ativarsb') {
        if (!activeGroups.includes(gid)) activeGroups.push(gid);
        delete subs[gid]; // .ativarSB = sem limite de dias
        expiredNotified[gid] = false;
        save(FILES.groups, activeGroups);
        save(FILES.subs, subs);
        return msg.reply('✅ Bot *ativado* neste grupo (sem limite de dias). Use .ajuda para ver os comandos.');
      }
      activeGroups = activeGroups.filter(g => g !== gid);
      save(FILES.groups, activeGroups);
      return msg.reply('🔕 Bot *desativado* neste grupo.');
    }

    // Se não está ativo, ignora tudo (avisa uma vez quando os dias acabaram)
    if (!active) {
      if (activeGroups.includes(gid) && subs[gid] && subs[gid] <= Date.now() && !msg.fromMe && !expiredNotified[gid]) {
        expiredNotified[gid] = true;
        await msg.reply('⏰ O plano do bot neste grupo *expirou*. Peça ao administrador para *renovar o plano* com o criador.');
        checkSubscriptions().catch(() => {}); // avisa o criador já
      }
      return;
    }
    if (msg.fromMe && !isCommand) return; // não processa as próprias respostas do bot

    const sender = (await msg.getContact()).number || (msg.author || '').split('@')[0];

    // --- Moderação (antilink / antispam): ignora criador, admins e o próprio bot ---
    if (!msg.fromMe && !owner) {
      const st = gs(gid);
      if ((st.antilink || st.antispam) && !(await isGroupAdmin(chat, msg))) {
        if (await moderate(msg, chat, st, gid)) return;
      }
    }

    // --- Comandos ---
    if (isCommand) {
      if (ADMIN_CMDS.has(cmd) && !(owner || (await isGroupAdmin(chat, msg)))) {
        return msg.reply('⛔ Apenas administradores do grupo podem usar este comando.');
      }
      if (BOT_ADMIN_CMDS.has(cmd) && !botIsAdmin(chat)) {
        return msg.reply('⚠️ Preciso ser *administrador* do grupo para fazer isso.');
      }
      switch (cmd) {
        case 'ajuda':
        case 'menu':
          return msg.reply(BUILTIN_HELP(Object.keys(customCommands), owner));

        case 'ping':
          return msg.reply('🏓 pong');

        case 'comprovativo':
          return msg.reply(
            '💳 Envie o comprovativo M-Pesa ou e-Mola como *texto* (SMS copiado) ou *imagem* (print). ' +
            'O bot lê automaticamente o ID, valor e operadora.'
          );

        case 'pagamentos': {
          const list = payments.filter(p => p.group === gid).slice(-10).reverse();
          if (!list.length) return msg.reply('Nenhum comprovativo registado neste grupo.');
          return msg.reply(
            '🧾 *Últimos comprovativos*\n' +
            list.map(p => `• ${({ ok: '✅', nome: '⚠️', operadora: '⚠️', invalido: '❌' })[p.validation] || '•'} ${p.operator} | ${p.id || 's/ID'} | ${p.amount.toFixed(2)} MT | ${p.sender}`).join('\n')
          );
        }

        case 'abrir':
          await chat.setMessagesAdminsOnly(false);
          return msg.reply('🔓 Grupo *aberto*: todos podem falar.');

        case 'fechar':
          await chat.setMessagesAdminsOnly(true);
          return msg.reply('🔒 Grupo *fechado*: só administradores podem falar.');

        case 'ban':
        case 'promover':
        case 'rebaixar': {
          const ids = await targetsFrom(msg);
          if (!ids.length) return msg.reply(`Uso: ${PREFIX}${cmd} @pessoa (ou responda à mensagem da pessoa)`);
          const me = client.info.wid;
          const valid = ids.filter(id => {
            const user = id.split('@')[0];
            return last9(user) !== last9(OWNER_NUMBER) && user !== me.user;
          });
          if (!valid.length) return msg.reply('⚠️ Não posso aplicar isso ao criador nem a mim mesmo.');
          const isAdm = id => { const x = chat.participants.find(p => p.id._serialized === id); return !!(x && (x.isAdmin || x.isSuperAdmin)); };
          if (cmd === 'ban') {
            const alvo = valid.filter(id => !isAdm(id));
            if (!alvo.length) return msg.reply('⚠️ Essa pessoa é administradora. Use .rebaixar primeiro.');
            await chat.removeParticipants(alvo);
            return msg.reply(`🚫 ${alvo.length} pessoa(s) removida(s).`);
          }
          if (cmd === 'promover') {
            await chat.promoteParticipants(valid);
            return msg.reply('⬆️ Promovido(a) a administrador(a).');
          }
          await chat.demoteParticipants(valid);
          return msg.reply('⬇️ Administração removida.');
        }

        case 'todos': {
          const ids = chat.participants.map(p => p.id._serialized);
          const tags = chat.participants.map(p => '@' + p.id.user).join(' ');
          return chat.sendMessage((rest ? rest + '\n\n' : '📢 *Atenção, todos!*\n\n') + tags, { mentions: ids });
        }

        case 'link': {
          const code = await chat.getInviteCode();
          return msg.reply(`🔗 Link do grupo:\nhttps://chat.whatsapp.com/${code}`);
        }

        case 'antilink':
        case 'antispam':
        case 'bemvindo': {
          const st = gs(gid);
          const arg = (args[0] || '').toLowerCase();
          const label = { antilink: 'Anti-link', antispam: 'Anti-spam', bemvindo: 'Boas-vindas' }[cmd];
          if (arg !== 'on' && arg !== 'off') {
            return msg.reply(`${label}: *${st[cmd] ? 'ligado' : 'desligado'}*\nUso: ${PREFIX}${cmd} on/off`);
          }
          st[cmd] = arg === 'on';
          saveSettings();
          const extraMsg = st[cmd] && cmd !== 'bemvindo' && !botIsAdmin(chat) ? '\n⚠️ Para funcionar, o bot precisa ser administrador do grupo.' : '';
          return msg.reply(`${st[cmd] ? '✅' : '🔕'} ${label} *${st[cmd] ? 'ligado' : 'desligado'}*.${extraMsg}`);
        }

        case 'regras':
          return msg.reply(customCommands.regras
            ? `📜 *Regras do grupo*\n${customCommands.regras}`
            : `Ainda não há regras definidas. Um admin pode usar ${PREFIX}setregras texto`);

        case 'setregras':
          if (!rest) return msg.reply(`Uso: ${PREFIX}setregras texto das regras`);
          customCommands.regras = rest;
          save(FILES.commands, customCommands);
          return msg.reply('✅ Regras atualizadas.');

        case 'setbemvindo':
          if (!rest) return msg.reply(`Uso: ${PREFIX}setbemvindo Bem-vindo {user} ao {grupo}!`);
          gs(gid).welcome = rest;
          saveSettings();
          return msg.reply('✅ Mensagem de boas-vindas atualizada.');

        case 'addmpesa':
        case 'addemola': {
          if (!owner) return msg.reply('⛔ Apenas o criador pode registar contas.');
          const isMpesa = cmd === 'addmpesa';
          const operator = isMpesa ? 'M-Pesa' : 'e-Mola';
          const m = rest.match(/^\+?(?:258)?\s*(\d{9})\s*[-–,:]?\s*(.+)$/s);
          const example = isMpesa ? '.addmpesa 85XXXXXXX - Nome' : '.addemola 87XXXXXXX - Nome';
          if (!m) return msg.reply(`Uso: ${example}`);
          const number = m[1];
          const name = m[2].trim();
          const okPrefix = isMpesa ? /^8[45]/ : /^8[67]/;
          if (!okPrefix.test(number)) {
            return msg.reply(`⚠️ Número inválido para ${operator}: ${isMpesa ? 'M-Pesa começa com 84 ou 85' : 'e-Mola começa com 86 ou 87'}.`);
          }
          accounts[gid] = (accounts[gid] || []).filter(a => last9(a.number) !== number);
          accounts[gid].push({ number, name, operator });
          save(FILES.accounts, accounts);
          return msg.reply(`✅ Conta *${operator}* registada: ${number} – ${name}\nOs comprovativos serão comparados com esta conta.`);
        }

        case 'contas': {
          const list = accounts[gid] || [];
          if (!list.length) return msg.reply('Nenhuma conta registada neste grupo.');
          return msg.reply('💳 *Contas para pagamento*\n' + list.map(a => `• ${a.operator || ''} ${a.number} – ${a.name}`.replace('•  ', '• ')).join('\n'));
        }

        case 'delconta': {
          if (!owner) return msg.reply('⛔ Apenas o criador pode remover contas.');
          const number = last9(args[0] || '');
          const before = (accounts[gid] || []).length;
          accounts[gid] = (accounts[gid] || []).filter(a => last9(a.number) !== number);
          save(FILES.accounts, accounts);
          return msg.reply(accounts[gid].length < before ? '🗑️ Conta removida.' : 'Conta não encontrada.');
        }

        case 'nanoadd': {
          if (!owner) return msg.reply('⛔ Apenas o criador pode adicionar comandos.');
          const i = rest.indexOf(',');
          const name = (i === -1 ? '' : rest.slice(0, i)).trim().toLowerCase().replace(/^\./, '').replace(/\s+/g, '');
          const reply = i === -1 ? '' : rest.slice(i + 1).trim();
          const reserved = RESERVED;
          if (!name || !reply) return msg.reply(`Uso: ${PREFIX}nanoadd comando, Resposta`);
          if (reserved.includes(name)) return msg.reply('⚠️ Esse nome é reservado.');
          customCommands[name] = reply;
          save(FILES.commands, customCommands);
          return msg.reply(`✅ Comando *${PREFIX}${name}* adicionado.`);
        }

        case 'delcmd': {
          if (!owner) return msg.reply('⛔ Apenas o criador pode remover comandos.');
          const name = (args[0] || '').toLowerCase().replace(PREFIX, '');
          if (!customCommands[name]) return msg.reply('Comando não encontrado.');
          delete customCommands[name];
          save(FILES.commands, customCommands);
          return msg.reply(`🗑️ Comando *${PREFIX}${name}* removido.`);
        }

        case 'listcmd': {
          if (!owner) return msg.reply('⛔ Apenas o criador pode listar.');
          const keys = Object.keys(customCommands);
          return msg.reply(keys.length ? keys.map(k => `${PREFIX}${k} → ${customCommands[k]}`).join('\n') : 'Sem comandos personalizados.');
        }

        default:
          if (customCommands[cmd]) return msg.reply(customCommands[cmd]);
          return; // comando desconhecido: ignora
      }
    }

    // --- Reconhecimento de comprovativo (texto) ---
    if (body && !msg.hasMedia) {
      const isPayment = await handlePaymentCandidate(msg, body, sender);
      if (!isPayment) await handleKeyword(msg, body, gid); // ex.: "pagamento"
      return;
    }

    // --- Reconhecimento de comprovativo (imagem + OCR) ---
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (!media || !media.mimetype.startsWith('image/')) return;
      if (!Tesseract) {
        console.warn('OCR indisponível (npm i tesseract.js) – imagens não são lidas.');
        if (body) await handleKeyword(msg, body, gid);
        return;
      }
      const text = [body, await ocrImage(media)].filter(Boolean).join(' ');
      const isPayment = await handlePaymentCandidate(msg, text, sender);
      if (!isPayment && body) await handleKeyword(msg, body, gid); // legenda da imagem
    }
  } catch (err) {
    console.error('Erro ao processar mensagem:', err);
  }
});

client.on('group_join', async n => {
  try {
    const gid = n.chatId;
    if (!isGroupActive(gid) || !gs(gid).bemvindo) return;
    const chat = await n.getChat();
    const ids = n.recipientIds || [];
    if (!ids.length) return;
    const tags = ids.map(id => '@' + id.split('@')[0]).join(' ');
    const text = (gs(gid).welcome || '👋 Bem-vindo(a) {user} ao grupo *{grupo}*!\nUse .regras para ver as regras.')
      .replace(/\{user\}/g, tags).replace(/\{grupo\}/g, chat.name);
    await chat.sendMessage(text, { mentions: ids });
  } catch (err) {
    console.error('Erro nas boas-vindas:', err);
  }
});

client.initialize();
