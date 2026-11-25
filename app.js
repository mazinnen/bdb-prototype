'use strict';
/* ビルディバイドブライト 対戦テーブル（非公式）
 * 一人回し ＋ PeerJS(WebRTC) によるP2Pオンライン対戦。
 * 各プレイヤーは「自分側」の盤面だけを編集し、相手には非公開情報を伏せた状態を送る。
 */

// ---------- 定数 ----------
const ZONE_LABEL = {
  deck: '山札', hand: '手札', field: 'フィールド', energy: 'エナジー', drop: 'ドロップ',
  lifeY: 'ライフ(イエロー)', lifeR: 'ライフ(レッド)', territory: 'テリトリー',
};
const PUBLIC_ZONES = ['field', 'energy', 'drop', 'territory'];
const HIDDEN_ZONES = ['deck', 'hand', 'lifeY', 'lifeR'];
const PHASES = ['stand', 'draw', 'main', 'attack', 'end'];
const PHASE_LABEL = { stand: 'スタンド', draw: 'ドロー', main: 'メイン', attack: 'アタック', end: 'エンド' };
const COLORS = { 赤: '#d9534f', 青: '#3b7dd8', 白: '#c9d1da', 黒: '#333', 緑: '#3a9a5b', 黄: '#e0b52a', 紫: '#8a4fbf' };
const PEER_PREFIX = 'bdbtable-';
const LS_DECKS = 'bdbt_decks_v1';
const LS_NAME = 'bdbt_name';

const SAMPLE_DECK = `# デッキの書き方（1行に1種類）
# 枚数 カード名 / 種類 色 コスト パワー ヒット トリガー img=画像URL
#   種類: ユニット / エース / コマンド
#   色:   赤 青 白 黒 緑 黄 紫（複数可：赤 青）
#   C3 = コスト3、P5000 = パワー5000、H1 = ヒット1
#   トリガー: バースト（またはB） / ショット（またはS）
#   img=https://... で画像（任意）
# テリトリーは「T: 名前 / img=表 img2=開放面」

T: サンプルテリトリー
4 サンプルエースA / エース 赤 C3 P6000 H2
4 サンプルエースB / エース 赤 C4 P7000 H2
4 バーストユニットA / ユニット 赤 C2 P4000 H1 バースト
4 バーストユニットB / ユニット 青 C3 P5000 H1 バースト
4 バーストコマンド / コマンド 赤 C2 バースト
4 ショットユニット / ユニット 青 C2 P3000 H1 ショット
4 ショットコマンド / コマンド 青 C1 ショット
4 ユニットA / ユニット 赤 C1 P3000 H1
4 ユニットB / ユニット 青 C2 P4000 H1
4 コマンドA / コマンド 赤 C1
`;

// ---------- 状態 ----------
function newSide(name) {
  return {
    name, deckName: '', deckDef: null,
    zones: { deck: [], hand: [], field: [], energy: [], drop: [], lifeY: [], lifeR: [], territory: [] },
    territoryOpen: false, myTurns: 0, energySet: 0, stage: 'none', lost: false,
  };
}
const S = {
  mode: 'solo',          // solo | host | guest
  mySeat: 0,             // オンライン時の自分の席
  ctrl: 0,               // 操作中（画面下側）の席
  sides: [newSide('P1'), newSide('P2')],
  game: { firstSeat: null, turnPlayer: null, turn: 0, phase: null, started: false },
  lastStarted: 0,
  logs: [], undo: [],
  sel: null,             // {seat, uid}
  preview: null,
  modal: null,           // 表示中のモーダル
  room: '', connected: false, oppName: '',
  showOppHand: false, autoSwitch: true, zoomOn: true,
};

// ---------- ユーティリティ ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '');
let uidSeq = 1;
const newUid = () => Math.random().toString(36).slice(2, 7) + (uidSeq++).toString(36);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const other = (seat) => 1 - seat;
const me = () => S.sides[S.ctrl];
const online = () => S.mode !== 'solo';
const canEdit = (seat) => !online() || seat === S.mySeat;
const now = () => new Date().toTimeString().slice(0, 5);

let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- デッキ解析 ----------
function parseCardBody(s) {
  const ref = String(s).match(/^@(\d+)/);
  if (ref) { const d = defFromVid(+ref[1]); if (d) return d; s = s.replace(/^@\d+\s*/, '') || `不明なカード @${ref[1]}`; }
  const parts = s.split(/\s*[\/／]\s*/);
  const def = { name: parts[0].trim(), type: '', trig: '', color: '', cost: null, power: null, hit: null, img: '', img2: '', memo: '' };
  const toks = parts.slice(1).join(' ').split(/\s+/).filter(Boolean);
  for (const tk of toks) {
    let m;
    if (/^img2=/i.test(tk)) def.img2 = safeUrl(tk.slice(5));
    else if (/^img=/i.test(tk)) def.img = safeUrl(tk.slice(4));
    else if (/^(ユニット|U)$/i.test(tk)) def.type = 'ユニット';
    else if (/^(エース|ACE)$/i.test(tk)) def.type = 'エース';
    else if (/^(コマンド|CMD)$/i.test(tk)) def.type = 'コマンド';
    else if (/^(バースト|B|💣)$/i.test(tk)) def.trig = 'B';
    else if (/^(ショット|S|★|☆)$/i.test(tk)) def.trig = 'S';
    else if ((m = tk.match(/^P(\d+)$/i))) def.power = +m[1];
    else if ((m = tk.match(/^H(\d+)$/i))) def.hit = +m[1];
    else if ((m = tk.match(/^(?:C|コスト)(\d+)$/i))) def.cost = +m[1];
    else if (/^[赤青白黒緑黄紫]+$/.test(tk)) def.color += tk;
    else def.memo += (def.memo ? ' ' : '') + tk;
  }
  return def;
}
function parseDeck(text) {
  const cards = []; let territory = null; const warns = []; const kinds = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    let m = line.match(/^(?:T|テリトリー)\s*[:：]\s*(.+)$/i);
    if (m) { territory = parseCardBody(m[1]); territory.type = 'テリトリー'; return; }
    m = line.match(/^(\d+)\s*[xX×]?\s+(.+)$/);
    if (!m) { warns.push(`${i + 1}行目を読み取れません：「${line}」`); return; }
    const n = +m[1]; const def = parseCardBody(m[2]);
    kinds.push({ n, def });
    for (let k = 0; k < n; k++) cards.push(def);
  });
  return { cards, territory, warns, kinds };
}
function checkDeck(p) {
  const res = [];
  const total = p.cards.length;
  const b = p.cards.filter((c) => c.trig === 'B').length;
  const s = p.cards.filter((c) => c.trig === 'S').length;
  res.push([total >= 40 && total <= 50, `デッキ枚数 ${total}枚（40〜50枚）`]);
  res.push([b === 12, `バースト ${b}枚（ちょうど12枚）`]);
  res.push([s <= 12, `ショット ${s}枚（12枚まで）`]);
  res.push([!!p.territory, p.territory ? `テリトリー：${p.territory.name}` : 'テリトリーが未登録（T: 名前）']);
  const byName = {};
  p.cards.forEach((c) => (byName[c.name] = (byName[c.name] || 0) + 1));
  const over = Object.entries(byName).filter(([, n]) => n > 4);
  res.push([over.length === 0, over.length ? `同名5枚以上：${over.map(([k, n]) => `${k}×${n}`).join('、')}（例外カードなら無視してOK）` : '同名カード4枚以内']);
  return res;
}
const loadDecks = () => { try { return JSON.parse(localStorage.getItem(LS_DECKS) || '[]'); } catch { return []; } };
const saveDecks = (d) => { try { localStorage.setItem(LS_DECKS, JSON.stringify(d)); } catch { toast('保存できませんでした'); } };

function makeCard(def) {
  return { uid: newUid(), ...def, rest: false, faceDown: false, dmg: 0, pmod: 0, revealed: false };
}

// ---------- ログ・通信 ----------
function addLog(entry) {
  S.logs.push(entry);
  if (S.logs.length > 400) S.logs.shift();
  renderLog();
}
function log(text, kind = '') {
  const e = { t: now(), text, kind };
  addLog(e);
  send({ t: 'log', e });
}
function seatName(seat) { return S.sides[seat]?.name || `P${seat + 1}`; }

let peer = null, conn = null;
function send(msg) { if (conn && conn.open) { try { conn.send(msg); } catch (e) { console.warn(e); } } }
function maskSide(side) {
  const o = JSON.parse(JSON.stringify(side));
  delete o.deckDef;
  for (const z of HIDDEN_ZONES) {
    o.zones[z] = o.zones[z].map((c) => (z === 'hand' && c.revealed ? c : { uid: c.uid, hidden: true }));
  }
  for (const z of PUBLIC_ZONES) {
    o.zones[z] = o.zones[z].map((c) => (c.faceDown ? { uid: c.uid, hidden: true, faceDown: true, rest: c.rest } : c));
  }
  return o;
}
function sendSide() { if (online()) send({ t: 'side', seat: S.mySeat, side: maskSide(S.sides[S.mySeat]) }); }
function sendGame() { if (online()) send({ t: 'game', game: S.game }); }

function onData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'hello':
      S.oppName = String(msg.name || '相手').slice(0, 20);
      addLog({ t: now(), text: `${S.oppName} が入室しました`, kind: 'sys' });
      break;
    case 'side':
      if (msg.seat === other(S.mySeat) && msg.side) S.sides[msg.seat] = msg.side;
      break;
    case 'game':
      if (msg.game) { S.game = msg.game; maybeAutoStart(); }
      break;
    case 'log': if (msg.e) addLog({ t: String(msg.e.t || now()).slice(0, 5), text: String(msg.e.text).slice(0, 300), kind: ['sys', ''].includes(msg.e.kind) ? msg.e.kind : '' }); break;
    case 'chat': addLog({ t: now(), text: `${esc(String(msg.from || '相手').slice(0, 20))}: ${esc(String(msg.text).slice(0, 200))}`, kind: 'chat', html: true }); break;
    case 'reqsync': sendSide(); if (S.mode === 'host') sendGame(); break;
  }
  render();
}

function myName() { return (localStorage.getItem(LS_NAME) || '').trim() || 'プレイヤー'; }
function randCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 6; i++) s += ch[Math.floor(Math.random() * ch.length)];
  return s;
}
function ensurePeerLib() {
  if (!window.Peer) { toast('通信ライブラリ(PeerJS)を読み込めませんでした。ネット接続を確認してください'); return false; }
  return true;
}
function goOnline(mode, code) {
  const mine = S.sides[S.ctrl];
  mine.name = myName();
  S.mode = mode; S.mySeat = mode === 'host' ? 0 : 1; S.ctrl = S.mySeat;
  S.sides = [null, null];
  S.sides[S.mySeat] = mine;
  S.sides[other(S.mySeat)] = newSide('相手');
  S.game = { firstSeat: null, turnPlayer: null, turn: 0, phase: null, started: false };
  S.lastStarted = 0; S.undo = []; S.room = code; S.connected = false;
  resetZones(mine);
}
function hostRoom() {
  if (!ensurePeerLib()) return;
  leaveRoom(true);
  const code = randCode();
  peer = new Peer(PEER_PREFIX + code);
  peer.on('open', () => {
    goOnline('host', code);
    addLog({ t: now(), text: `ルーム ${code} を作成しました。相手にコードか招待リンクを伝えてください`, kind: 'sys' });
    render(); openModal({ type: 'room' });
  });
  peer.on('connection', (c) => {
    if (conn && conn.open) { c.on('open', () => { c.send({ t: 'log', e: { t: now(), text: 'このルームは満員です', kind: 'sys' } }); setTimeout(() => c.close(), 500); }); return; }
    setupConn(c);
  });
  peer.on('error', (e) => { toast('通信エラー：' + e.type); console.warn(e); });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* noop */ } });
}
function joinRoom(code) {
  if (!ensurePeerLib()) return;
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) { toast('ルームコードを確認してください'); return; }
  leaveRoom(true);
  peer = new Peer();
  peer.on('open', () => {
    goOnline('guest', code);
    const c = peer.connect(PEER_PREFIX + code, { reliable: true });
    setupConn(c);
    addLog({ t: now(), text: `ルーム ${code} に接続中…`, kind: 'sys' });
    render();
  });
  peer.on('error', (e) => {
    toast(e.type === 'peer-unavailable' ? 'ルームが見つかりません（コード違い／相手がページを閉じた可能性）' : '通信エラー：' + e.type);
    console.warn(e);
  });
}
function setupConn(c) {
  conn = c;
  c.on('open', () => {
    S.connected = true;
    send({ t: 'hello', name: myName() });
    sendSide();
    if (S.mode === 'host') sendGame();
    send({ t: 'reqsync' });
    addLog({ t: now(), text: '相手と接続しました', kind: 'sys' });
    if (S.modal?.type === 'room') closeModal();
    render();
  });
  c.on('data', onData);
  c.on('close', () => { S.connected = false; conn = null; addLog({ t: now(), text: '相手との接続が切れました', kind: 'sys' }); render(); });
  c.on('error', (e) => console.warn(e));
}
function leaveRoom(silent) {
  try { conn && conn.close(); } catch { /* noop */ }
  try { peer && peer.destroy(); } catch { /* noop */ }
  conn = null; peer = null;
  if (!silent && online()) {
    const mine = S.sides[S.mySeat];
    S.mode = 'solo'; S.mySeat = 0; S.ctrl = 0; S.sides = [mine, newSide('P2')];
    S.game = { firstSeat: null, turnPlayer: null, turn: 0, phase: null, started: false };
    S.connected = false; S.room = ''; S.undo = [];
    addLog({ t: now(), text: '一人回しモードに戻りました', kind: 'sys' });
    render();
  }
}

// ---------- 盤面操作 ----------
function snapshot() {
  const snap = online()
    ? { side: JSON.stringify(S.sides[S.mySeat]) }
    : { sides: JSON.stringify(S.sides), game: JSON.stringify(S.game), ctrl: S.ctrl, lastStarted: S.lastStarted };
  S.undo.push(snap);
  if (S.undo.length > 40) S.undo.shift();
}
function undo() {
  const snap = S.undo.pop();
  if (!snap) return toast('これ以上戻せません');
  if (snap.side) S.sides[S.mySeat] = JSON.parse(snap.side);
  else { S.sides = JSON.parse(snap.sides); S.game = JSON.parse(snap.game); S.ctrl = snap.ctrl; S.lastStarted = snap.lastStarted; }
  S.sel = null;
  log(`${seatName(S.ctrl)}：1手戻しました`, 'sys');
  commit();
}
function commit() { sendSide(); render(); }

function findCard(side, uid) {
  for (const z of Object.keys(side.zones)) {
    const i = side.zones[z].findIndex((c) => c.uid === uid);
    if (i >= 0) return { zone: z, idx: i, card: side.zones[z][i] };
  }
  return null;
}
function cardLabel(c, from, to) {
  const vis = !c.faceDown && (PUBLIC_ZONES.includes(from) || PUBLIC_ZONES.includes(to) || c.revealed);
  return vis ? `「${c.name}」` : '1枚';
}
function moveCard(seat, uid, to, pos = 'end', silent = false) {
  const side = S.sides[seat];
  const f = findCard(side, uid); if (!f) return null;
  const [c] = side.zones[f.zone].splice(f.idx, 1);
  if (!['field', 'energy'].includes(to)) { c.rest = false; c.dmg = 0; c.pmod = 0; }
  if (!PUBLIC_ZONES.includes(to)) c.faceDown = false;
  if (to !== 'hand') c.revealed = false;
  if (pos === 'top') side.zones[to].unshift(c); else side.zones[to].push(c);
  if (!silent) {
    const where = to === 'deck' ? (pos === 'top' ? '山札の上' : '山札の下') : ZONE_LABEL[to];
    log(`${side.name}：${cardLabel(c, f.zone, to)}を${ZONE_LABEL[f.zone]}→${where}`);
  }
  return c;
}
function drawCards(seat, n = 1, why = '') {
  const side = S.sides[seat];
  for (let i = 0; i < n; i++) {
    let c = side.zones.deck.shift();
    if (!c) {
      c = side.zones.lifeY.shift() || side.zones.lifeR.shift();
      if (!c) { side.lost = true; log(`${side.name}：山札もライフもないため引けません → 敗北`, 'sys'); return; }
      log(`${side.name}：山札切れ。ライフから1枚引きました`, 'sys');
    }
    side.zones.hand.push(c);
  }
  log(`${side.name}：${why}${n}枚ドロー（山札 残り${side.zones.deck.length}）`);
}
function resetZones(side) {
  side.zones = { deck: [], hand: [], field: [], energy: [], drop: [], lifeY: [], lifeR: [], territory: [] };
  side.territoryOpen = false; side.myTurns = 0; side.energySet = 0; side.stage = 'none'; side.lost = false;
}
function useDeck(seat, deck) {
  const p = parseDeck(deck.text);
  if (!p.cards.length) return toast('カードが1枚もありません');
  const side = S.sides[seat];
  side.deckDef = { cards: p.cards, territory: p.territory };
  side.deckName = deck.name;
  resetZones(side);
  side.zones.deck = p.cards.map(makeCard);
  if (p.territory) side.zones.territory = [makeCard(p.territory)];
  log(`${side.name}：デッキ「${deck.name}」（${p.cards.length}枚）をセットしました`, 'sys');
  commit();
}
function prepare(seat) {
  const side = S.sides[seat];
  if (!side.deckDef) return toast('先にデッキを選んでください（デッキ）');
  snapshot();
  resetZones(side);
  side.zones.deck = shuffle(side.deckDef.cards.map(makeCard));
  if (side.deckDef.territory) side.zones.territory = [makeCard(side.deckDef.territory)];
  side.zones.hand = side.zones.deck.splice(0, 5);
  side.stage = 'mulligan';
  log(`${side.name}：ゲーム準備（シャッフルして5枚引きました）`, 'sys');
  openModal({ type: 'mulligan', seat });
  commit();
}
function finishMulligan(seat, redo) {
  const side = S.sides[seat];
  if (redo) {
    const old = side.zones.hand; side.zones.hand = side.zones.deck.splice(0, 5);
    side.zones.deck.push(...old); shuffle(side.zones.deck);
    log(`${side.name}：手札を引き直しました`, 'sys');
  }
  side.zones.lifeY = side.zones.deck.splice(0, 5);
  side.zones.lifeR = side.zones.deck.splice(0, 5);
  side.zones.energy = side.zones.deck.splice(0, 2);
  side.stage = 'ready';
  log(`${side.name}：ライフ10枚（イエロー5・レッド5）とエナジー2枚を配置しました`, 'sys');
  closeModal(); commit();
}
function startGame(firstSeat) {
  snapshot();
  S.game = { firstSeat, turnPlayer: firstSeat, turn: 1, phase: 'stand', started: true };
  S.lastStarted = 0;
  log(`ゲーム開始！ 先攻：${seatName(firstSeat)}`, 'sys');
  closeModal();
  sendGame();
  maybeAutoStart();
  commit();
}
function maybeAutoStart() {
  const g = S.game;
  if (!g.started || g.phase !== 'stand' || S.lastStarted === g.turn) return;
  if (!canEdit(g.turnPlayer)) return;
  S.lastStarted = g.turn;
  if (!online() && S.autoSwitch) S.ctrl = g.turnPlayer;
  startTurn(g.turnPlayer);
}
function startTurn(seat) {
  const side = S.sides[seat];
  side.myTurns++; side.energySet = 0;
  for (const z of ['field', 'energy', 'territory']) side.zones[z].forEach((c) => (c.rest = false));
  log(`── ターン${S.game.turn}：${side.name} ──`, 'sys');
  log(`${side.name}：スタンドフェイズ（全てスタンド）`);
  S.game.phase = 'draw';
  if (S.game.firstSeat === seat && side.myTurns === 1) log(`${side.name}：先攻1ターン目のためドローなし`);
  else drawCards(seat, 1, 'ドローフェイズ ');
  S.game.phase = 'main';
  sendGame(); commit();
}
function setPhase(ph) {
  if (!canEdit(S.game.turnPlayer)) return toast('相手のターンです');
  snapshot();
  S.game.phase = ph;
  if (ph !== 'end') log(`${seatName(S.game.turnPlayer)}：${PHASE_LABEL[ph]}フェイズ`);
  sendGame();
  if (ph === 'end') { doEndPhase(); return; }
  commit();
}
function doEndPhase() {
  const seat = S.game.turnPlayer; const side = S.sides[seat];
  side.zones.field.forEach((c) => { c.dmg = 0; c.pmod = 0; });
  log(`${side.name}：エンドフェイズ（ダメージ・パワー修正を解除）`);
  if (side.zones.hand.length >= 6) { openModal({ type: 'discard', seat }); commit(); return; }
  passTurn();
}
function passTurn() {
  const seat = S.game.turnPlayer;
  S.game.turnPlayer = other(seat); S.game.turn++; S.game.phase = 'stand';
  closeModal();
  sendGame();
  maybeAutoStart();
  commit();
}

// ---------- ダメージ処理 ----------
function startDamage(seat, n) {
  n = Math.max(1, Math.min(20, +n || 1));
  snapshot();
  log(`${S.sides[seat].name}：${n}ダメージを受けます`, 'sys');
  openModal({ type: 'damage', seat, remain: n, flipped: null, note: '' });
  stepDamage();
}
function stepDamage() {
  const m = S.modal; if (!m || m.type !== 'damage') return;
  const side = S.sides[m.seat];
  if (m.remain <= 0) { log(`${side.name}：ダメージ処理終了（ライフ残り${side.zones.lifeY.length + side.zones.lifeR.length}）`); closeModal(); commit(); return; }
  const fromY = side.zones.lifeY.length > 0;
  const c = side.zones.lifeY.shift() || side.zones.lifeR.shift();
  if (!c) {
    side.lost = true; m.flipped = null; m.remain = 0;
    m.note = 'ライフがない状態でダメージを受けました。敗北です。';
    log(`${side.name}：ライフ0でダメージ → 敗北`, 'sys');
    commit(); return;
  }
  m.remain--;
  side.zones.drop.push(c);
  m.flipped = c.uid;
  let t = `${side.name}：${fromY ? 'イエロー' : 'レッド'}ライフから「${c.name}」をめくりドロップへ`;
  if (c.trig === 'B') { m.remain++; t += '【バースト：追加1ダメージ】'; m.note = 'バーストトリガー！ 追加で1ダメージを受けます。'; }
  else if (c.trig === 'S') { t += '【ショットトリガー】'; m.note = 'ショットトリガー！ コストを払わずにプレイできます（任意）。'; }
  else m.note = 'トリガーなし。';
  log(t);
  commit();
}

// ---------- 描画 ----------
function cardHTML(c, seat, zone, opts = {}) {
  const hidden = c.hidden || opts.back;
  const sel = S.sel && S.sel.uid === c.uid ? ' sel' : '';
  const rest = c.rest ? ' rest' : '';
  const data = `data-uid="${esc(c.uid)}" data-seat="${seat}" data-zone="${zone}"`;
  const drag = canEdit(seat) && !opts.nodrag ? ' draggable="true"' : '';
  if (hidden) return `<div class="card back${rest}${sel}" ${data}${drag} title="裏向き"></div>`;
  const isTerr = zone === 'territory';
  const open = isTerr && S.sides[seat]?.territoryOpen;
  const img = safeUrl(open && c.img2 ? c.img2 : c.img);
  const stripe = c.color ? `<div class="stripe">${[...String(c.color)].map((k) => `<i style="background:${COLORS[k] || '#888'}"></i>`).join('')}</div>` : '';
  const tg = c.trig === 'B' ? '💣' : c.trig === 'S' ? '★' : '';
  const num = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
  const cost = num(c.cost), hit = num(c.hit), dmgv = num(c.dmg) || 0, pmod = num(c.pmod) || 0;
  const pow = num(c.power) != null ? num(c.power) + pmod : null;
  const dead = zone === 'field' && pow != null && (dmgv >= pow || pow <= 0) ? ' dead' : '';
  const st = (pow != null || hit != null || cost != null)
    ? `<div class="st"><span>${pow != null ? pow : ''}</span><span>${hit != null ? 'H' + hit : ''}</span></div>` : '';
  const dmg = dmgv ? `<div class="dmg">-${dmgv}</div>` : '';
  const pm = pmod ? `<div class="pm${pmod < 0 ? ' neg' : ''}">${pmod > 0 ? '+' : ''}${pmod}</div>` : '';
  const rev = zone === 'hand' && c.revealed ? '<div class="rev" title="公開中"></div>' : '';
  const cls = `card${img ? ' img' : ''}${isTerr ? ' terr' : ''}${open ? ' open' : ''}${rest}${sel}${dead}`;
  const shown = opts.full ? img : thumbOf(img);
  const style = img ? ` style="background-image:url('${esc(shown)}')"` : '';
  const label = isTerr ? `${esc(c.name)}${open ? '<br>【開放】' : ''}` : esc(c.name);
  const zoom = img ? ` data-zoom="${esc(img)}"${isTerr && c.img2 && !open ? ` data-zoom2="${esc(safeUrl(c.img2))}"` : ''}` : '';
  return `<div class="${cls}" ${data}${drag}${style}${zoom} title="${esc(c.name)}">${stripe}<div class="nm">${label}</div><div class="tg">${tg}</div><div class="ty">${esc(c.type)}${cost != null ? ' C' + cost : ''}</div>${st}${dmg}${pm}${rev}</div>`;
}
function zoneHead(label, extra = '') { return `<div class="zl"><span>${label}</span><span>${extra}</span></div>`; }

function sideHTML(seat, pos) {
  const side = S.sides[seat]; const z = side.zones;
  const deckTop = z.deck.length ? cardHTML(z.deck[0], seat, 'deck', { back: true }) : '<div class="empty-slot"></div>';
  const dropTop = z.drop.length ? cardHTML(z.drop[z.drop.length - 1], seat, 'drop', { nodrag: false }) : '<div class="empty-slot"></div>';
  const lifeBox = (key, cls, nm) => {
    const arr = z[key]; const n = arr.length;
    const stack = arr.slice(0, Math.min(n, 5)).map((c, i) => `<div class="card back" style="left:${i * 2}px;top:${i * 2}px" data-pile="${key}" data-seat="${seat}"></div>`).join('');
    return `<div class="lifebox ${cls}" data-pile="${key}" data-seat="${seat}"><span class="lname">${nm}</span><div class="lstack">${stack}</div><span class="lcnt">${n}</span></div>`;
  };
  const energyStand = z.energy.filter((c) => !c.rest).length;
  return `
  <div class="side ${pos}" data-seat="${seat}">
    <div class="zone z-life" data-dropzone="lifeY" data-seat="${seat}">${zoneHead('ライフ', `計${z.lifeY.length + z.lifeR.length}`)}
      <div class="life-wrap">${lifeBox('lifeY', 'y', 'イエロー')}${lifeBox('lifeR', 'r', 'レッド')}</div></div>
    <div class="zone z-field" data-dropzone="field" data-seat="${seat}">${zoneHead('フィールド', `${z.field.length}体`)}
      <div class="cards">${z.field.map((c) => cardHTML(c, seat, 'field')).join('')}</div></div>
    <div class="zone z-deck" data-dropzone="deck" data-seat="${seat}">${zoneHead('山札')}
      <div class="pile" data-pile="deck" data-seat="${seat}">${deckTop}<span class="cnt">${z.deck.length}枚</span></div></div>
    <div class="zone z-terr" data-dropzone="territory" data-seat="${seat}">${zoneHead('テリトリー', side.territoryOpen ? '<b style="color:var(--warn)">開放中</b>' : '')}
      <div class="cards">${z.territory.map((c) => cardHTML(c, seat, 'territory')).join('') || '<span class="muted">なし</span>'}</div></div>
    <div class="zone z-energy" data-dropzone="energy" data-seat="${seat}">${zoneHead('エナジー', `スタンド ${energyStand}/${z.energy.length}`)}
      <div class="cards">${z.energy.map((c) => cardHTML(c, seat, 'energy')).join('')}</div></div>
    <div class="zone z-drop" data-dropzone="drop" data-seat="${seat}">${zoneHead('ドロップ')}
      <div class="pile" data-pile="drop" data-seat="${seat}">${dropTop}<span class="cnt">${z.drop.length}枚</span></div></div>
  </div>`;
}
function handHTML(seat, pos) {
  const side = S.sides[seat]; const hand = side.zones.hand;
  const faceUp = pos === 'me' || (!online() && S.showOppHand);
  const cards = hand.map((c) => cardHTML(c, seat, 'hand', { back: !faceUp && !c.revealed })).join('');
  const lost = side.lost ? ' <span class="lost">敗北</span>' : '';
  const turn = S.game.started && S.game.turnPlayer === seat ? ' <span class="badge on">ターン中</span>' : '';
  return `<div class="hand ${pos}" data-dropzone="hand" data-seat="${seat}">
    <div class="sidebar-title"><b>${esc(side.name)}</b><span>手札 ${hand.length}枚</span><span>${esc(side.deckName || 'デッキ未選択')}</span>${turn}${lost}</div>
    <div class="cards">${cards}</div></div>`;
}
function centerHTML() {
  const g = S.game; const seat = S.ctrl; const side = S.sides[seat];
  const myTurn = g.started && g.turnPlayer === seat && canEdit(seat);
  const phases = PHASES.map((p) => `<span class="phase${g.phase === p ? ' cur' : ''}">${PHASE_LABEL[p]}</span>`).join('');
  const turnInfo = g.started ? `ターン${g.turn}：${esc(seatName(g.turnPlayer))}` : '開始前';
  const oppReady = S.sides[other(seat)].stage === 'ready' || !online();
  const b = [];
  if (!g.started) {
    b.push(`<button data-act="deck">デッキ</button>`);
    b.push(`<button data-act="prepare" ${side.deckDef ? '' : 'disabled'}>ゲーム準備</button>`);
    b.push(`<button class="primary" data-act="start" ${side.stage === 'ready' && oppReady ? '' : 'disabled'} title="${oppReady ? '' : '相手の準備待ち'}">先攻・後攻を決めて開始</button>`);
  } else {
    if (myTurn && g.phase === 'main') b.push(`<button class="primary" data-act="phase-attack">アタックフェイズへ</button>`);
    if (myTurn && (g.phase === 'main' || g.phase === 'attack')) b.push(`<button data-act="phase-end">ターン終了</button>`);
  }
  b.push(`<button data-act="draw">1枚ドロー</button>`);
  b.push(`<button data-act="damage">ダメージを受ける</button>`);
  b.push(`<button data-act="standall">全てスタンド</button>`);
  b.push(`<button data-act="undo" ${S.undo.length ? '' : 'disabled'}>元に戻す</button>`);
  b.push(`<span class="grow"></span>`);
  b.push(`<button data-act="dice" title="サイコロ">🎲</button><button data-act="coin" title="コイン">🪙</button>`);
  if (!online()) b.push(`<button data-act="switch" title="操作する側を入れ替え">操作側 切替</button>`);
  if (g.started) b.push(`<button data-act="reset" class="danger">対戦リセット</button>`);
  return `<div class="center"><span class="turninfo">${turnInfo}</span><div class="phases">${phases}</div>${b.join('')}</div>`;
}
function headerHTML() {
  const st = online()
    ? `<span class="badge ${S.connected ? 'on' : 'off'}">${S.mode === 'host' ? 'ホスト' : 'ゲスト'} ${esc(S.room)} ${S.connected ? '接続中' : '待機中'}</span>
       <button data-act="room">招待</button><button data-act="leave">退出</button>`
    : `<span class="badge">一人回し</span>
       <button data-act="host" class="primary">ルームを作る</button><button data-act="join">ルームに入る</button>
       <label class="muted"><input type="checkbox" data-act="showopp" ${S.showOppHand ? 'checked' : ''}> 相手側の手札を表示</label>
       <label class="muted"><input type="checkbox" data-act="autoswitch" ${S.autoSwitch ? 'checked' : ''}> ターン交代で操作側も切替</label>`;
  return `${st}<span class="sep"></span>
    <label class="muted" title="カードにマウスを乗せたとき原寸で拡大表示"><input type="checkbox" data-act="zoomtoggle" ${S.zoomOn ? 'checked' : ''}> 拡大</label>
    <label class="muted">名前 <input id="name-input" value="${esc(myName())}" size="10" maxlength="20"></label>
    <button data-act="help">使い方</button>`;
}

function render() {
  const hc = $('#header-controls');
  if (document.activeElement?.id !== 'name-input') hc.innerHTML = headerHTML();
  const bottom = S.ctrl, top = other(S.ctrl);
  $('#board').innerHTML = handHTML(top, 'opp') + sideHTML(top, 'opp') + centerHTML() + sideHTML(bottom, 'me') + handHTML(bottom, 'me');
  renderPreview();
  renderModal();
}
function renderLog() {
  const el = $('#log'); if (!el) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = S.logs.map((e) => `<div class="l ${e.kind || ''}"><span class="t">${esc(e.t)}</span>${e.html ? e.text : esc(e.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function renderPreview() {
  const el = $('#preview'); const p = S.preview;
  if (!p) return;
  const side = S.sides[p.seat]; const f = side && findCard(side, p.uid);
  const listing = S.modal?.type === 'list' && S.modal.zone === f?.zone && S.modal.seat === p.seat;
  if (!f || f.card.hidden
    || (!online() && p.seat !== S.ctrl && f.zone === 'hand' && !S.showOppHand && !f.card.revealed)
    || (['deck', 'lifeY', 'lifeR'].includes(f.zone) && !listing)) {
    el.innerHTML = '<p class="muted">（非公開のカード）</p>'; return;
  }
  const c = f.card;
  const trig = c.trig === 'B' ? '💣 バースト' : c.trig === 'S' ? '★ ショット' : 'なし';
  const land = f.zone === 'territory' && side.territoryOpen ? ' land' : '';
  el.innerHTML = `<div class="big${land}">${cardHTML(c, p.seat, f.zone, { nodrag: true, full: true })}</div>
  <dl><dt>名前</dt><dd>${esc(c.name)}</dd><dt>種類</dt><dd>${esc(c.type || '-')}</dd><dt>色</dt><dd>${esc(c.color || '-')}</dd>
  <dt>コスト</dt><dd>${c.cost ?? '-'}</dd><dt>パワー</dt><dd>${c.power != null ? `${c.power}${c.pmod ? ` → ${c.power + c.pmod}` : ''}` : '-'}${c.dmg ? `（ダメージ${c.dmg}）` : ''}</dd>
  <dt>ヒット</dt><dd>${c.hit ?? '-'}</dd><dt>トリガー</dt><dd>${trig}</dd>
  ${c.costText ? `<dt>コスト詳細</dt><dd>${esc(c.costText)}</dd>` : ''}${c.attr ? `<dt>属性</dt><dd>${esc(c.attr)}</dd>` : ''}
  ${c.titles ? `<dt>称号</dt><dd>${esc(c.titles)}</dd>` : ''}${c.abil ? `<dt>アイコン</dt><dd>${esc(c.abil)}</dd>` : ''}
  <dt>場所</dt><dd>${esc(side.name)}の${ZONE_LABEL[f.zone]}</dd>
  ${c.memo ? `<dt>メモ</dt><dd>${esc(c.memo)}</dd>` : ''}</dl>`;
}

// ---------- モーダル ----------
function openModal(m) { S.modal = m; renderModal(); }
function closeModal() { S.modal = null; renderModal(); }
function renderModal() {
  const root = $('#modal-root'); const m = S.modal;
  if (!m) { root.innerHTML = ''; return; }
  const keepScroll = root.querySelector('.modal')?.scrollTop || 0;
  let h = '';
  const side = m.seat != null ? S.sides[m.seat] : null;
  switch (m.type) {
    case 'mulligan':
      h = `<div class="modal wide"><h2>${esc(side.name)}：最初の手札（引き直しますか？）</h2>
        <div class="cards bigcards">${side.zones.hand.map((c) => cardHTML(c, m.seat, 'hand', { nodrag: true, full: true })).join('')}</div>
        <p class="muted">カードにマウスを乗せると拡大します。引き直しは1度だけで、5枚すべてを入れ替えます（元の手札は山札に戻してシャッフル）。</p>
        <div class="acts"><button data-act="mull-redo">5枚とも引き直す</button><button class="primary" data-act="mull-keep">この手札で始める</button></div></div>`;
      break;
    case 'first':
      h = `<div class="modal narrow"><h2>先攻・後攻</h2><p>じゃんけんで決めたら選んでください。</p>
        <div class="acts" style="justify-content:flex-start">
        <button data-act="first" data-v="${S.ctrl}">${esc(seatName(S.ctrl))} が先攻</button>
        <button data-act="first" data-v="${other(S.ctrl)}">${esc(seatName(other(S.ctrl)))} が先攻</button>
        <button data-act="first" data-v="rand">ランダム</button></div>
        <div class="acts"><button data-act="close">キャンセル</button></div></div>`;
      break;
    case 'list': {
      const arr = side.zones[m.zone];
      const list = m.limit ? arr.slice(0, m.limit) : arr;
      const order = m.zone === 'drop' ? [...list].reverse() : list;
      h = `<div class="modal"><h2>${esc(side.name)}の${ZONE_LABEL[m.zone]}${m.limit ? `（上から${m.limit}枚）` : `（${arr.length}枚）`}</h2>
        ${m.zone === 'drop' ? '<p class="muted">新しい順に表示。</p>' : m.zone === 'deck' ? '<p class="muted">左が山札の上。カードをクリックすると移動できます。</p>' : ''}
        <div class="cards midcards">${order.map((c) => cardHTML(c, m.seat, m.zone, { nodrag: true, full: true })).join('') || '<span class="muted">カードがありません</span>'}</div>
        <div class="acts">${m.zone === 'deck' && canEdit(m.seat) ? '<button data-act="shuffle-close">シャッフルして閉じる</button>' : ''}<button class="primary" data-act="close">閉じる</button></div></div>`;
      break;
    }
    case 'damage': {
      const c = m.flipped ? findCard(side, m.flipped)?.card : null;
      const lifeLeft = side.zones.lifeY.length + side.zones.lifeR.length;
      const shotBtns = c && c.trig === 'S' && findCard(side, c.uid)?.zone === 'drop'
        ? `<button data-act="shot-field">ショット：フィールドに出す</button><button data-act="shot-cmd">ショット：コマンドとして使う</button>` : '';
      h = `<div class="modal narrow"><h2>${esc(side.name)}：ダメージ処理</h2>
        <div class="flip-show">${c ? cardHTML(c, m.seat, 'drop', { nodrag: true, full: true }) : ''}
          <div><p>${esc(m.note)}</p><p>残りダメージ：<b>${m.remain}</b><br>ライフ残り：${lifeLeft}（イエロー${side.zones.lifeY.length}／レッド${side.zones.lifeR.length}）</p></div></div>
        <div class="acts">${shotBtns}
          ${m.remain > 0 ? '<button data-act="dmg-cancel">残りダメージを無効にする</button><button class="primary" data-act="dmg-next">次の1点をめくる</button>' : '<button class="primary" data-act="dmg-cancel">閉じる</button>'}</div></div>`;
      break;
    }
    case 'discard': {
      const need = side.zones.hand.length - 5;
      h = `<div class="modal wide"><h2>${esc(side.name)}：手札が${side.zones.hand.length}枚です</h2>
        <p>5枚になるまで、捨てるカードをクリックしてください（あと${Math.max(0, need)}枚）。</p>
        <div class="cards midcards">${side.zones.hand.map((c) => cardHTML(c, m.seat, 'hand', { nodrag: true, full: true }).replace('class="card', 'data-discard="1" class="card')).join('')}</div>
        <div class="acts"><button class="primary" data-act="discard-done" ${need > 0 ? 'disabled' : ''}>ターンを終える</button></div></div>`;
      break;
    }
    case 'damage-ask':
      h = `<div class="modal narrow"><h2>ダメージを受ける</h2><p>受けるダメージ（攻撃ユニットのヒット数）</p>
        <div class="acts" style="justify-content:flex-start">${[1, 2, 3, 4, 5].map((n) => `<button data-act="dmg-go" data-v="${n}">${n}</button>`).join('')}</div>
        <div class="acts"><button data-act="close">キャンセル</button></div></div>`;
      break;
    case 'room': {
      const link = `${location.origin}${location.pathname}?room=${S.room}`;
      h = `<div class="modal narrow"><h2>ルーム ${esc(S.room)}</h2>
        <p>相手にこのコード、または招待リンクを送ってください。相手が入ると自動でつながります。</p>
        <p><input style="width:100%" readonly value="${esc(link)}" id="invite-link"></p>
        <div class="acts"><button data-act="copy-link">リンクをコピー</button><button class="primary" data-act="close">閉じる</button></div>
        <p class="muted">このページを閉じるとルームは消えます。</p></div>`;
      break;
    }
    case 'join':
      h = `<div class="modal narrow"><h2>ルームに入る</h2>
        <p><input id="join-code" placeholder="ルームコード（例：ABC234）" value="${esc(m.code || '')}" style="width:100%;text-transform:uppercase"></p>
        <p class="muted">今の一人回しの盤面はリセットされます（デッキはそのまま）。</p>
        <div class="acts"><button data-act="close">キャンセル</button><button class="primary" data-act="join-go">入る</button></div></div>`;
      break;
    case 'deck': h = deckModalHTML(m); break;
    case 'help': h = helpHTML(); break;
  }
  root.innerHTML = `<div class="modal-bg" data-bg="1">${h}</div>`;
  const md = root.querySelector('.modal'); if (md) md.scrollTop = keepScroll;
  if (m.type === 'deck') bindDeckModal(m);
}
// ---------- カードデータベース（公式カードリスト） ----------
const IMG_PFX = 'https://storage.googleapis.com/prd-buildivide-static-7c153c/uploads/card/';
const DB = { byVid: new Map(), groups: [], sets: [], titles: [] };
function buildDB() {
  for (const set of window.BDB_SETS || []) {
    DB.sets.push({ id: set.id, name: set.name });
    for (const c of set.cards) {
      const g = { ...c, set: set.id, setName: set.name, gi: DB.groups.length };
      DB.groups.push(g);
      for (const v of c.v) DB.byVid.set(v[0], g);
      for (const t of c.titles) if (!DB.titles.includes(t)) DB.titles.push(t);
    }
  }
}
function imgUrl(h, kind = 'image_path') { const [hash, ts] = String(h).split('?'); return `${IMG_PFX}${hash}/${kind}.png?${ts}`; }
function thumbOf(url) { return url && url.startsWith(IMG_PFX) ? url.replace('/image_path.png', '/thumb_image_path.png') : url; }
function defFromVid(vid) {
  const g = DB.byVid.get(vid); if (!g) return null;
  const v = g.v.find((x) => x[0] === vid);
  const terr = g.type === 'テリトリー';
  return {
    name: g.name, type: g.type, trig: g.trig, color: g.color, cost: g.cost, power: g.power, hit: g.hit,
    img: terr ? imgUrl(v[2], 'territory_image_path') : imgUrl(v[2]), img2: terr ? imgUrl(v[2]) : '',
    memo: '', attr: g.attr, titles: g.titles.join('/'), abil: g.abil.join('/'), costText: g.costText, rar: v[1], vid,
  };
}
const TYPE_ORDER = { テリトリー: 0, エース: 1, ユニット: 2, コマンド: 3 };

// デッキテキスト ⇔ 構造（@カードID の行だけを画面から編集。それ以外の行はそのまま残す）
function deckStruct(text) {
  const entries = []; let terr = null; const others = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^(?:T|テリトリー)\s*[:：]\s*@(\d+)/i);
    if (m) { terr = +m[1]; continue; }
    m = line.match(/^(\d+)\s*[xX×]?\s+@(\d+)/);
    if (m) { entries.push({ vid: +m[2], n: +m[1] }); continue; }
    if (line) others.push(raw);
  }
  return { entries, terr, others };
}
function deckCompose(p) {
  const out = [];
  if (p.terr != null) out.push(`T: @${p.terr} ${DB.byVid.get(p.terr)?.name || ''}`);
  const key = (e) => { const g = DB.byVid.get(e.vid) || {}; return [TYPE_ORDER[g.type] ?? 9, g.cost ?? 99, g.name || '']; };
  const ents = p.entries.filter((e) => e.n > 0).sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]), 'ja');
  });
  ents.forEach((e) => out.push(`${e.n} @${e.vid} ${DB.byVid.get(e.vid)?.name || ''}`));
  return [...out, ...p.others].join('\n');
}
function groupCount(p, g) {
  if (g.type === 'テリトリー') return p.terr != null && DB.byVid.get(p.terr) === g ? 1 : 0;
  return p.entries.filter((e) => DB.byVid.get(e.vid) === g).reduce((a, e) => a + e.n, 0);
}
function deckAdd(m, g, delta) {
  const p = deckStruct(m.text);
  const art = m.art[g.gi] ?? g.v[0][0];
  if (g.type === 'テリトリー') {
    if (delta > 0) p.terr = art; else if (p.terr != null && DB.byVid.get(p.terr) === g) p.terr = null;
  } else {
    const e = p.entries.find((x) => DB.byVid.get(x.vid) === g);
    if (e) e.n = Math.max(0, e.n + delta);
    else if (delta > 0) p.entries.push({ vid: art, n: delta });
    if (delta > 0 && groupCount(p, g) > 4) toast(`「${g.name}」が5枚以上です（通常は4枚まで）`);
  }
  m.text = deckCompose(p);
}
function deckArt(m, g) {
  const ids = g.v.map((v) => v[0]);
  const cur = m.art[g.gi] ?? ids[0];
  const next = ids[(ids.indexOf(cur) + 1) % ids.length];
  m.art[g.gi] = next;
  const p = deckStruct(m.text);
  if (g.type === 'テリトリー') { if (p.terr != null && DB.byVid.get(p.terr) === g) p.terr = next; }
  else p.entries.forEach((e) => { if (DB.byVid.get(e.vid) === g) e.vid = next; });
  m.text = deckCompose(p);
}
function filteredGroups(f) {
  const q = (f.q || '').trim();
  return DB.groups.filter((g) => (!f.set || g.set === f.set) && (!f.type || g.type === f.type)
    && (!f.color || g.color === f.color) && (!f.trig || (f.trig === 'none' ? !g.trig : g.trig === f.trig))
    && (!f.title || g.titles.includes(f.title)) && (!q || g.name.includes(q)));
}
function gridHTML(m) {
  if (!DB.groups.length) return '<p class="muted">カードデータが読み込まれていません。右下の「テキストで編集」で手入力できます。</p>';
  const p = deckStruct(m.text);
  const list = filteredGroups(m.f);
  if (!list.length) return '<p class="muted">条件に合うカードがありません</p>';
  return list.map((g) => {
    const vid = m.art[g.gi] ?? g.v[0][0];
    const v = g.v.find((x) => x[0] === vid);
    const n = groupCount(p, g);
    const terr = g.type === 'テリトリー';
    const src = terr ? imgUrl(v[2], 'territory_image_path') : imgUrl(v[2]);
    const zoom = terr ? ` data-zoom="${esc(src)}" data-zoom2="${esc(imgUrl(v[2]))}"` : ` data-zoom="${esc(src)}"`;
    const tg = g.trig === 'B' ? '<span class="gtrig b">💣</span>' : g.trig === 'S' ? '<span class="gtrig s">★</span>' : '';
    return `<div class="gitem${n ? ' has' : ''}" data-gi="${g.gi}">
      <img loading="lazy" src="${esc(src)}" alt="${esc(g.name)}" data-act="dg-add" data-g="${g.gi}"${zoom}>
      ${tg}${n ? `<span class="gcnt">${n}</span>` : ''}
      <div class="gbar"><button data-act="dg-sub" data-g="${g.gi}" ${n ? '' : 'disabled'}>−</button>
      ${g.v.length > 1 ? `<button data-act="dg-art" data-g="${g.gi}" title="絵柄を切り替え（${esc(v[1])}）">絵${g.v.indexOf(v) + 1}/${g.v.length}</button>` : '<span></span>'}
      <button data-act="dg-add" data-g="${g.gi}">＋</button></div>
      <div class="gname">${esc(g.name)}</div></div>`;
  }).join('');
}
function deckListHTML(m) {
  const p = deckStruct(m.text);
  const rows = [];
  if (p.terr != null) {
    const g = DB.byVid.get(p.terr);
    rows.push(`<div class="drow terr" data-gi="${g ? g.gi : ''}"><span class="dn">T</span><span class="dname">${esc(g ? g.name : `不明なカード @${p.terr}`)}</span>${g ? `<button data-act="dg-sub" data-g="${g.gi}">×</button>` : ''}</div>`);
  } else rows.push('<div class="drow muted">テリトリー未選択（テリトリーをクリック）</div>');
  const ents = deckStruct(deckCompose(p)).entries;
  let lastType = '';
  for (const e of ents) {
    const g = DB.byVid.get(e.vid);
    if (!g) { rows.push(`<div class="drow ng">${e.n} 不明なカード @${e.vid}</div>`); continue; }
    if (g.type !== lastType) { rows.push(`<div class="dhead">${g.type}</div>`); lastType = g.type; }
    const meta = [g.costText, g.power != null ? g.power : '', g.hit != null ? 'H' + g.hit : '', g.trig === 'B' ? '💣' : g.trig === 'S' ? '★' : ''].filter(Boolean).join(' ');
    rows.push(`<div class="drow" data-gi="${g.gi}"><button data-act="dg-sub" data-g="${g.gi}">−</button><span class="dn">${e.n}</span><button data-act="dg-add" data-g="${g.gi}">＋</button>
      <span class="dname">${esc(g.name)}<small>${esc(meta)}</small></span></div>`);
  }
  if (p.others.some((l) => !l.trim().startsWith('#'))) rows.push('<div class="dhead">手入力の行</div><div class="muted" style="font-size:12px">テキスト欄に手入力のカードがあります</div>');
  return rows.join('');
}
function checkHTML(checks, p) {
  return checks.map(([ok, t]) => `<div class="${ok ? 'ok' : 'ng'}">${ok ? '✔' : '⚠'} ${esc(t)}</div>`).join('')
    + p.warns.map((w) => `<div class="ng">⚠ ${esc(w)}</div>`).join('');
}
function hoverHTML(g, vid) {
  if (!g) return '';
  const v = g.v.find((x) => x[0] === vid) || g.v[0];
  const terr = g.type === 'テリトリー';
  const imgs = '';
  const info = [g.type, g.attr, g.costText, g.power != null ? `P${g.power}` : '', g.hit != null ? `H${g.hit}` : '',
    g.trig === 'B' ? 'バースト' : g.trig === 'S' ? 'ショット' : '', g.titles.length ? `称号:${g.titles.join('/')}` : '', g.abil.join('/')].filter(Boolean).join('　');
  return `<div class="himgs">${imgs}</div><div class="hinfo"><b>${esc(g.name)}</b><br>${esc(info)}</div>`;
}
function deckModalHTML(m) {
  const decks = loadDecks();
  const f = m.f;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  const chips = (key, items) => items.map(([v, l]) => `<button class="chip${f[key] === v ? ' on' : ''}" data-act="df" data-k="${key}" data-v="${esc(v)}">${l}</button>`).join('');
  const p = parseDeck(m.text);
  return `<div class="modal deckmodal">
  <div class="deck-top"><h2>デッキ編集（${esc(seatName(S.ctrl))}用）</h2>
    <select id="deck-sel"><option value="">― 保存済みデッキ（${decks.length}） ―</option>${decks.map((d, i) => `<option value="${i}" ${m.idx === i ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    <input id="deck-name" placeholder="デッキ名" value="${esc(m.name)}">
    <button data-act="deck-new">新規</button>
    <button data-act="deck-del" ${m.idx != null ? '' : 'disabled'} class="danger">削除</button>
    <span class="grow"></span>
    <button data-act="deck-save">保存</button>
    <button data-act="close">閉じる</button>
    <button class="primary" data-act="deck-use">保存してこのデッキを使う</button>
  </div>
  <div class="deck-body">
    <div class="deck-search">
      <div class="filters">
        <select id="df-set"><option value="">全作品</option>${DB.sets.map((s) => opt(s.id, s.name, f.set)).join('')}</select>
        <select id="df-title"><option value="">称号：すべて</option>${DB.titles.map((t) => opt(t, t, f.title)).join('')}</select>
        <input id="df-q" placeholder="カード名で検索" value="${esc(f.q)}">
      </div>
      <div class="filters">
        ${chips('type', [['', 'すべて'], ['エース', 'エース'], ['ユニット', 'ユニット'], ['コマンド', 'コマンド'], ['テリトリー', 'テリトリー']])}
        <span class="sep2"></span>
        ${chips('color', [['', '全色'], ['黒', '黒'], ['青', '青'], ['白', '白'], ['赤', '赤']])}
        <span class="sep2"></span>
        ${chips('trig', [['', '全トリガー'], ['B', '💣バースト'], ['S', '★ショット'], ['none', 'なし']])}
      </div>
      <p class="muted hint">画像クリックで1枚追加、右クリックで1枚減らす。マウスを乗せると拡大（「拡大」のチェックで切替）。「絵1/3」で絵柄を切り替え。</p>
      <div class="grid" id="deck-grid">${gridHTML(m)}</div>
    </div>
    <div class="deck-side">
      <div id="deck-hover" class="hoverprev">${m.hover != null ? hoverHTML(DB.groups[m.hover], m.art[m.hover] ?? DB.groups[m.hover]?.v[0][0]) : '<p class="muted">カードにマウスを乗せると拡大表示します</p>'}</div>
      <div class="check" id="deck-check">${checkHTML(checkDeck(p), p)}</div>
      <div id="deck-list" class="dlist">${deckListHTML(m)}</div>
      <details ${m.showText ? 'open' : ''} id="deck-text-box"><summary>テキストで編集・共有</summary>
        <textarea id="deck-text" spellcheck="false">${esc(m.text)}</textarea>
        <p class="muted" style="font-size:11px">「4 @7909 名前」の形式で共有できます。公式データにないカードは「4 カード名 / ユニット 赤 C3 P5000 H1 バースト」のように手入力も可。</p>
      </details>
    </div>
  </div></div>`;
}
function refreshDeckModal() {
  const m = S.modal; if (!m || m.type !== 'deck') return;
  const grid = $('#deck-grid'); if (!grid) return;
  const st = grid.scrollTop; grid.innerHTML = gridHTML(m); grid.scrollTop = st;
  const p = parseDeck(m.text);
  $('#deck-check').innerHTML = checkHTML(checkDeck(p), p);
  const dl = $('#deck-list'); const ds = dl.scrollTop; dl.innerHTML = deckListHTML(m); dl.scrollTop = ds;
  const ta = $('#deck-text'); if (ta && document.activeElement !== ta) ta.value = m.text;
}
function bindDeckModal(m) {
  const ta = $('#deck-text'), nm = $('#deck-name'), sel = $('#deck-sel');
  ta.addEventListener('input', () => {
    m.text = ta.value; const p = parseDeck(m.text);
    $('#deck-check').innerHTML = checkHTML(checkDeck(p), p);
    $('#deck-list').innerHTML = deckListHTML(m); $('#deck-grid').innerHTML = gridHTML(m);
  });
  $('#deck-text-box').addEventListener('toggle', (e) => { m.showText = e.target.open; });
  nm.addEventListener('input', () => { m.name = nm.value; });
  sel.addEventListener('change', () => {
    const d = loadDecks()[+sel.value];
    if (sel.value === '' || !d) { m.idx = null; return; }
    m.idx = +sel.value; m.name = d.name; m.text = d.text; renderModal();
  });
  $('#df-set').addEventListener('change', (e) => { m.f.set = e.target.value; refreshDeckModal(); });
  $('#df-title').addEventListener('change', (e) => { m.f.title = e.target.value; refreshDeckModal(); });
  $('#df-q').addEventListener('input', (e) => { m.f.q = e.target.value; refreshDeckModal(); });
  const body = $('.deckmodal');
  body.addEventListener('mouseover', (e) => {
    const it = e.target.closest('[data-gi]'); if (!it || it.dataset.gi === '') return;
    const gi = +it.dataset.gi; if (m.hover === gi && !e.target.closest('.gitem')) return;
    m.hover = gi; $('#deck-hover').innerHTML = hoverHTML(DB.groups[gi], m.art[gi] ?? DB.groups[gi].v[0][0]);
  });
  body.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('.gitem,.drow[data-gi]'); if (!it || it.dataset.gi === '') return;
    e.preventDefault(); deckAdd(m, DB.groups[+it.dataset.gi], -1); refreshDeckModal();
  });
}
function trialDeckText(setId) {
  const gs = DB.groups.filter((g) => g.set === setId);
  const p = { entries: [], terr: null, others: [] };
  const t = gs.find((g) => g.type === 'テリトリー'); if (t) p.terr = t.v[0][0];
  const add = (list, n) => { for (const g of list) { if (n <= 0) break; const k = Math.min(4, n); p.entries.push({ vid: g.v[0][0], n: k }); n -= k; } };
  add(gs.filter((g) => g.trig === 'B'), 12);
  add(gs.filter((g) => g.trig === 'S'), 8);
  add(gs.filter((g) => !g.trig && g.type === 'エース'), 12);
  add(gs.filter((g) => !g.trig && g.type !== 'テリトリー' && g.type !== 'エース'), 8);
  return deckCompose(p);
}
function saveDeckFromModal() {
  const m = S.modal; const name = (m.name || '').trim() || '無題のデッキ';
  const decks = loadDecks();
  const i = decks.findIndex((d) => d.name === name);
  const entry = { name, text: m.text };
  if (i >= 0) decks[i] = entry; else decks.push(entry);
  saveDecks(decks);
  m.name = name; m.idx = i >= 0 ? i : decks.length - 1;
  toast(`「${name}」を保存しました`);
  return entry;
}
function helpHTML() {
  return `<div class="modal"><h2>使い方</h2><div class="helpbox">
  <p><b>1. デッキ</b>：「デッキ」で公式カードリストから検索して、画像クリックで追加。保存して「このデッキを使う」。公式データにないカードはテキストで手入力もできます。</p>
  <p><b>2. ゲーム準備</b>：シャッフル→5枚ドロー→引き直し選択→ライフ10枚（イエロー5・レッド5）とエナジー2枚を自動で配置。</p>
  <p><b>3. 開始</b>：先攻・後攻を選ぶと、ターン開始時に「全てスタンド→ドロー（先攻1ターン目はなし）」を自動で行い、メインフェイズになります。</p>
  <p><b>カード操作</b>：カードをクリック → メニューから移動・レスト・ダメージ・パワー修正など。ドラッグ＆ドロップでも移動できます（山札に落とすと一番上）。
  エナジーをクリックするとすぐレスト／スタンドが切り替わります（Shift+クリックでメニュー）。</p>
  <p><b>山札・ドロップ・ライフ</b>：クリックでメニュー（ドロー、上からN枚見る、山札を探す、シャッフルなど）。</p>
  <p><b>ダメージを受ける</b>：ヒット数を選ぶと、ライフをイエローの上から1枚ずつめくってドロップへ。バーストなら追加1ダメージ、ショットならプレイするか選べます。ライフ0でダメージを受けると敗北表示。</p>
  <p><b>ターン終了</b>：エンドフェイズでダメージ・パワー修正を解除し、手札6枚以上なら5枚まで捨てる画面が出ます。</p>
  <p><b>一人回し</b>：P1・P2 両方を自分で操作します。「操作側 切替」で画面の上下が入れ替わります。</p>
  <p><b>オンライン</b>：「ルームを作る」→招待リンクを相手に送る → 相手が開くとつながります。それぞれ自分の盤面だけを操作し、相手の手札・山札・ライフの中身は送られません。
  相手のユニットを破壊するときは、相手に操作してもらってください（チャットで伝えると便利）。</p>
  <p><b>キー</b>：Esc＝閉じる、Ctrl+Z＝元に戻す、D＝1枚ドロー</p>
  <p class="muted">非公式のファンツールです。ビルディバイド -ブライト- の権利は各権利者に帰属します。カードのテキストや画像は同梱していません。</p>
  </div><div class="acts"><button class="primary" data-act="close">閉じる</button></div></div>`;
}

// ---------- メニュー ----------
function openMenu(x, y, title, items) {
  const el = $('#menu');
  el.innerHTML = `<div class="mt">${esc(title)}</div>` + items.map((it, i) => {
    if (it === '-') return '<hr>';
    if (Array.isArray(it)) return `<div class="row">${it.map((sub, j) => `<button data-mi="${i}.${j}">${esc(sub.label)}</button>`).join('')}</div>`;
    return `<button data-mi="${i}">${esc(it.label)}</button>`;
  }).join('');
  el.hidden = false;
  el._items = items;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function closeMenu() { $('#menu').hidden = true; }

function act(fn) { return () => { snapshot(); fn(); commit(); }; }

function cardMenuItems(seat, uid) {
  const side = S.sides[seat]; const f = findCard(side, uid); if (!f) return [];
  const c = f.card; const z = f.zone; const items = [];
  const mv = (to, pos) => act(() => moveCard(seat, uid, to, pos));
  if (z === 'hand') {
    items.push({ label: 'フィールドに出す', fn: mv('field') });
    items.push({ label: `エナジーセット${side.energySet ? '（今ターン済）' : ''}`, fn: act(() => { moveCard(seat, uid, 'energy'); side.energySet++; if (side.energySet > 1) toast('このターン2回目のエナジーセットです'); }) });
    items.push({ label: 'コマンドとして使う（ドロップへ）', fn: mv('drop') });
    items.push({ label: c.revealed ? '公開をやめる' : '相手に公開する', fn: act(() => { c.revealed = !c.revealed; log(`${side.name}：手札の「${c.name}」を${c.revealed ? '公開' : '非公開に'}`); }) });
  }
  if (z === 'field' || z === 'energy' || z === 'territory') {
    items.push({ label: c.rest ? 'スタンドする' : 'レストする', fn: act(() => { c.rest = !c.rest; if (z !== 'energy') log(`${side.name}：「${c.faceDown ? '裏向きカード' : c.name}」を${c.rest ? 'レスト' : 'スタンド'}`); }) });
  }
  if (z === 'field') {
    items.push([{ label: 'ダメ+1000', fn: act(() => { c.dmg += 1000; }) }, { label: 'ダメ-1000', fn: act(() => { c.dmg = Math.max(0, c.dmg - 1000); }) }]);
    items.push([{ label: 'パワー+1000', fn: act(() => { c.pmod += 1000; }) }, { label: 'パワー-1000', fn: act(() => { c.pmod -= 1000; }) }]);
    items.push({ label: '数値を入力…', fn: () => {
      const v = prompt('ダメージ,パワー修正 を入力（例：3000,2000）', `${c.dmg},${c.pmod}`);
      if (v == null) return; const [d, p] = v.split(/[,、\s]+/).map((x) => parseInt(x, 10));
      snapshot(); if (!isNaN(d)) c.dmg = Math.max(0, d); if (!isNaN(p)) c.pmod = p; commit();
    } });
    items.push({ label: '破壊（ドロップへ）', fn: act(() => { const n = c.name; moveCard(seat, uid, 'drop', 'end', true); log(`${side.name}：「${n}」が破壊されドロップへ`); }) });
  }
  if (z === 'field' || z === 'energy') {
    items.push({ label: c.faceDown ? '表向きにする' : '裏向きにする', fn: act(() => { c.faceDown = !c.faceDown; }) });
  }
  if (z === 'territory') {
    items.push({ label: side.territoryOpen ? 'テリトリーを閉じる' : 'テリトリーを開放する', fn: act(() => { side.territoryOpen = !side.territoryOpen; log(`${side.name}：テリトリー「${c.name}」を${side.territoryOpen ? '開放！' : '閉じました'}`, side.territoryOpen ? 'sys' : ''); }) });
    return items;
  }
  items.push('-');
  const dests = [['hand', '手札へ'], ['field', 'フィールドへ'], ['energy', 'エナジーへ'], ['drop', 'ドロップへ']].filter(([k]) => k !== z);
  dests.forEach(([k, l]) => items.push({ label: l, fn: mv(k) }));
  items.push([{ label: '山札の上', fn: mv('deck', 'top') }, { label: '山札の下', fn: mv('deck', 'end') }]);
  items.push([{ label: 'ライフ(黄)上', fn: mv('lifeY', 'top') }, { label: 'ライフ(赤)上', fn: mv('lifeR', 'top') }]);
  return items;
}
function pileMenuItems(seat, pile) {
  const side = S.sides[seat]; const z = side.zones; const items = [];
  const editable = canEdit(seat);
  if (pile === 'deck') {
    if (!editable) return [];
    items.push({ label: '1枚ドロー', fn: act(() => drawCards(seat, 1)) });
    items.push({ label: '上からN枚を見る…', fn: () => { const n = parseInt(prompt('何枚見ますか？', '3'), 10); if (n > 0) { log(`${side.name}：山札の上から${n}枚を見ました`); openModal({ type: 'list', seat, zone: 'deck', limit: n }); } } });
    items.push({ label: '山札を探す（全部見る）', fn: () => { log(`${side.name}：山札を確認しています`); openModal({ type: 'list', seat, zone: 'deck' }); } });
    items.push({ label: 'シャッフル', fn: act(() => { shuffle(z.deck); log(`${side.name}：山札をシャッフル`); }) });
    items.push('-');
    items.push({ label: '上から1枚ドロップ', fn: act(() => { if (z.deck[0]) moveCard(seat, z.deck[0].uid, 'drop'); }) });
    items.push({ label: '上から1枚エナジーへ', fn: act(() => { if (z.deck[0]) moveCard(seat, z.deck[0].uid, 'energy'); }) });
    items.push({ label: '上から1枚フィールドへ', fn: act(() => { if (z.deck[0]) moveCard(seat, z.deck[0].uid, 'field'); }) });
    items.push({ label: '上から1枚ライフ(黄)へ', fn: act(() => { if (z.deck[0]) moveCard(seat, z.deck[0].uid, 'lifeY', 'top'); }) });
  } else if (pile === 'drop') {
    items.push({ label: `一覧を見る（${z.drop.length}枚）`, fn: () => openModal({ type: 'list', seat, zone: 'drop' }) });
  } else if (pile === 'lifeY' || pile === 'lifeR') {
    if (!editable) return [];
    items.push({ label: 'ダメージを受ける…', fn: () => openModal({ type: 'damage-ask', seat }) });
    const top = () => z.lifeY[0] || z.lifeR[0];
    items.push({ label: 'ライフの上から1枚を手札へ', fn: act(() => { const c = top(); if (c) moveCard(seat, c.uid, 'hand'); }) });
    items.push({ label: 'ライフの上から1枚をドロップへ', fn: act(() => { const c = top(); if (c) moveCard(seat, c.uid, 'drop'); }) });
    items.push({ label: '山札の上から1枚をここに置く', fn: act(() => { if (z.deck[0]) moveCard(seat, z.deck[0].uid, pile, 'top'); }) });
  }
  return items;
}

// ---------- イベント ----------
function onBoardClick(e) {
  const t = e.target;
  // メニュー項目
  const mi = t.closest('#menu [data-mi]');
  if (mi) {
    const [a, b] = mi.dataset.mi.split('.').map(Number);
    const items = $('#menu')._items; const it = b != null && !isNaN(b) ? items[a][b] : items[a];
    closeMenu(); it?.fn?.(); return;
  }
  if (!t.closest('#menu')) closeMenu();

  const btn = t.closest('[data-act]');
  if (btn && btn.tagName !== 'INPUT') { handleAct(btn.dataset.act, btn, e); return; }

  // 捨て札選択
  const dc = t.closest('[data-discard]');
  if (dc) { const seat = +dc.dataset.seat; snapshot(); moveCard(seat, dc.dataset.uid, 'drop'); commit(); return; }

  const cardEl = t.closest('.card[data-uid]');
  if (cardEl && !cardEl.closest('.pile') && !cardEl.closest('.lifebox')) {
    const seat = +cardEl.dataset.seat; const uid = cardEl.dataset.uid; const zone = cardEl.dataset.zone;
    S.sel = { seat, uid }; S.preview = { seat, uid };
    const c = findCard(S.sides[seat], uid)?.card;
    const inModal = !!cardEl.closest('.modal');
    if (inModal && S.modal?.type !== 'list') { renderPreview(); return; }
    if (!inModal && cardEl.closest('#preview')) { renderPreview(); return; }
    if (canEdit(seat) && zone === 'energy' && !e.shiftKey && !S.modal) {
      snapshot(); c.rest = !c.rest; commit(); return;
    }
    render();
    if (canEdit(seat)) {
      const items = cardMenuItems(seat, uid);
      const title = c && !c.hidden ? c.name : `${ZONE_LABEL[zone]}のカード`;
      if (items.length) openMenu(e.clientX + 4, e.clientY + 4, title, items);
    }
    return;
  }
  const pile = t.closest('[data-pile]');
  if (pile) {
    const seat = +pile.dataset.seat; const p = pile.dataset.pile;
    if (p === 'drop') { const d = S.sides[seat].zones.drop; if (d.length) S.preview = { seat, uid: d[d.length - 1].uid }; renderPreview(); }
    const items = pileMenuItems(seat, p);
    if (items.length) openMenu(e.clientX + 4, e.clientY + 4, `${S.sides[seat].name}の${ZONE_LABEL[p]}`, items);
    return;
  }
  if (t.dataset.bg && S.modal && !['mulligan', 'damage', 'discard', 'deck'].includes(S.modal.type)) { closeModal(); return; }
  if (!t.closest('.modal')) { S.sel = null; }
}
function handleAct(a, el) {
  const seat = S.ctrl;
  switch (a) {
    case 'deck': {
      const decks = loadDecks(); const cur = decks.findIndex((d) => d.name === S.sides[seat].deckName);
      const d = cur >= 0 ? decks[cur] : decks[0];
      const def = defaultDeck();
      openModal({ type: 'deck', idx: d ? decks.indexOf(d) : null, name: d ? d.name : def.name, text: d ? d.text : def.text,
        f: { set: '', type: '', color: '', trig: '', title: '', q: '' }, art: {}, hover: null, showText: !DB.groups.length });
      break;
    }
    case 'deck-new': Object.assign(S.modal, { idx: null, name: '新しいデッキ', text: '' }); renderModal(); break;
    case 'df': S.modal.f[el.dataset.k] = el.dataset.v; renderModal(); break;
    case 'dg-add': deckAdd(S.modal, DB.groups[+el.dataset.g], 1); refreshDeckModal(); break;
    case 'dg-sub': deckAdd(S.modal, DB.groups[+el.dataset.g], -1); refreshDeckModal(); break;
    case 'dg-art': deckArt(S.modal, DB.groups[+el.dataset.g]); S.modal.hover = +el.dataset.g;
      $('#deck-hover').innerHTML = hoverHTML(DB.groups[+el.dataset.g], S.modal.art[+el.dataset.g]); refreshDeckModal(); break;
    case 'deck-save': saveDeckFromModal(); renderModal(); break;
    case 'deck-del': {
      const decks = loadDecks(); if (S.modal.idx == null) break;
      decks.splice(S.modal.idx, 1); saveDecks(decks); S.modal.idx = null; toast('削除しました'); renderModal(); break;
    }
    case 'deck-use': { const d = saveDeckFromModal(); closeModal(); useDeck(seat, d); break; }
    case 'prepare':
      if (S.game.started) return toast('対戦中です');
      prepare(seat); break;
    case 'mull-redo': finishMulligan(S.modal.seat, true); break;
    case 'mull-keep': finishMulligan(S.modal.seat, false); break;
    case 'start': openModal({ type: 'first' }); break;
    case 'first': {
      let v = el.dataset.v; v = v === 'rand' ? (Math.random() < 0.5 ? 0 : 1) : +v;
      if (el.dataset.v === 'rand') log(`ランダムで先攻は ${seatName(v)} に決まりました`, 'sys');
      startGame(v); break;
    }
    case 'phase-attack': setPhase('attack'); break;
    case 'phase-end': setPhase('end'); break;
    case 'discard-done': passTurn(); break;
    case 'draw': act(() => drawCards(seat, 1))(); break;
    case 'damage': openModal({ type: 'damage-ask', seat }); break;
    case 'dmg-go': { const s = S.modal.seat; closeModal(); startDamage(s, +el.dataset.v); break; }
    case 'dmg-next': stepDamage(); break;
    case 'dmg-cancel': {
      const m = S.modal; const sd = S.sides[m.seat];
      if (m.remain > 0) log(`${sd.name}：残り${m.remain}ダメージは無効になりました`);
      else if (!sd.lost) log(`${sd.name}：ダメージ処理終了（ライフ残り${sd.zones.lifeY.length + sd.zones.lifeR.length}）`);
      closeModal(); commit(); break;
    }
    case 'shot-field': { const m = S.modal; moveCard(m.seat, m.flipped, 'field', 'end', true); log(`${S.sides[m.seat].name}：ショットで「${findCard(S.sides[m.seat], m.flipped)?.card.name}」をフィールドに登場`); m.note = 'ショットでプレイしました。'; commit(); break; }
    case 'shot-cmd': { const m = S.modal; const c = findCard(S.sides[m.seat], m.flipped)?.card; log(`${S.sides[m.seat].name}：ショットで「${c?.name}」をプレイ（コマンド）`); m.note = 'ショットでプレイしました。効果を処理してください。'; c && (c._shot = true); m.flipped = null; commit(); break; }
    case 'standall': act(() => { const sd = S.sides[seat]; ['field', 'energy'].forEach((z) => sd.zones[z].forEach((c) => (c.rest = false))); log(`${sd.name}：全てスタンド`); })(); break;
    case 'undo': undo(); break;
    case 'dice': log(`${seatName(seat)}：🎲 サイコロ → ${1 + Math.floor(Math.random() * 6)}`, 'sys'); break;
    case 'coin': log(`${seatName(seat)}：🪙 コイン → ${Math.random() < 0.5 ? '表' : '裏'}`, 'sys'); break;
    case 'switch': S.ctrl = other(S.ctrl); S.sel = null; render(); break;
    case 'reset':
      if (!confirm('対戦をリセットしますか？（デッキはそのまま）')) return;
      snapshot();
      if (online()) { resetZones(S.sides[S.mySeat]); S.game = { firstSeat: null, turnPlayer: null, turn: 0, phase: null, started: false }; sendGame(); }
      else { S.sides.forEach(resetZones); S.game = { firstSeat: null, turnPlayer: null, turn: 0, phase: null, started: false }; }
      S.lastStarted = 0;
      [0, 1].forEach((s) => { const sd = S.sides[s]; if (canEdit(s) && sd.deckDef) { sd.zones.deck = sd.deckDef.cards.map(makeCard); if (sd.deckDef.territory) sd.zones.territory = [makeCard(sd.deckDef.territory)]; } });
      log('対戦をリセットしました', 'sys'); commit(); break;
    case 'close': closeModal(); break;
    case 'shuffle-close': snapshot(); shuffle(S.sides[S.modal.seat].zones.deck); log(`${S.sides[S.modal.seat].name}：山札をシャッフル`); closeModal(); commit(); break;
    case 'host': hostRoom(); break;
    case 'join': openModal({ type: 'join', code: '' }); break;
    case 'join-go': { const code = $('#join-code').value; closeModal(); joinRoom(code); break; }
    case 'room': openModal({ type: 'room' }); break;
    case 'copy-link': { const i = $('#invite-link'); i.select(); navigator.clipboard?.writeText(i.value).then(() => toast('コピーしました'), () => document.execCommand('copy')); break; }
    case 'leave': if (confirm('ルームから退出して一人回しに戻りますか？')) leaveRoom(false); break;
    case 'help': openModal({ type: 'help' }); break;
  }
}

// ドラッグ＆ドロップ
let dragInfo = null;
function onDragStart(e) {
  const el = e.target.closest('[draggable="true"]'); if (!el) return;
  const pile = el.closest('[data-pile="deck"]');
  dragInfo = { seat: +el.dataset.seat, uid: el.dataset.uid, fromPile: !!pile };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', el.dataset.uid); } catch { /* noop */ }
  closeMenu();
}
function onDragOver(e) {
  const z = e.target.closest('[data-dropzone]'); if (!z || !dragInfo) return;
  if (+z.dataset.seat !== dragInfo.seat) return;
  e.preventDefault();
  document.querySelectorAll('.drag-over').forEach((x) => x !== z && x.classList.remove('drag-over'));
  z.classList.add('drag-over');
}
function onDrop(e) {
  const z = e.target.closest('[data-dropzone]');
  document.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (!z || !dragInfo || +z.dataset.seat !== dragInfo.seat) return;
  e.preventDefault();
  let to = z.dataset.dropzone;
  const f = findCard(S.sides[dragInfo.seat], dragInfo.uid);
  if (!f) return;
  if (to === 'lifeY') { const box = e.target.closest('.lifebox'); if (box) to = box.dataset.pile; }
  if (f.zone === to) {
    // 同じゾーン内：フィールド/エナジー/手札は並べ替え
    const tgt = e.target.closest('.card[data-uid]');
    if (tgt && tgt.dataset.uid !== dragInfo.uid && ['field', 'energy', 'hand'].includes(to)) {
      snapshot(); const arr = S.sides[dragInfo.seat].zones[to]; const [c] = arr.splice(f.idx, 1);
      const ti = arr.findIndex((x) => x.uid === tgt.dataset.uid); arr.splice(ti, 0, c); commit();
    }
    dragInfo = null; return;
  }
  snapshot();
  const pos = ['deck', 'lifeY', 'lifeR'].includes(to) ? 'top' : 'end';
  moveCard(dragInfo.seat, dragInfo.uid, to, pos);
  if (to === 'energy' && f.zone === 'hand') { const sd = S.sides[dragInfo.seat]; sd.energySet++; if (sd.energySet > 1) toast('このターン2回目のエナジーセットです'); }
  dragInfo = null; commit();
}

function defaultDeck() {
  if (DB.sets.length) return { name: `おためし（${DB.sets[0].name}）`, text: trialDeckText(DB.sets[0].id) };
  return { name: 'サンプルデッキ', text: SAMPLE_DECK };
}
// ---------- 拡大表示 ----------
let zoomTimer = null, zoomFor = null;
function showZoom(el, x) {
  const z = $('#zoom'); const a = el.dataset.zoom, b = el.dataset.zoom2;
  if (!a) return;
  z.innerHTML = `<img src="${esc(a)}">${b ? `<img class="land" src="${esc(b)}">` : ''}`;
  z.classList.toggle('left', x > innerWidth / 2);
  z.hidden = false;
}
function hideZoom() { clearTimeout(zoomTimer); zoomFor = null; const z = $('#zoom'); if (z) z.hidden = true; }
function onZoomOver(e) {
  if (!S.zoomOn || dragInfo) return;
  const el = e.target.closest('[data-zoom]');
  if (el === zoomFor) return;
  hideZoom();
  if (!el || !$('#menu').hidden) return;
  zoomFor = el;
  const x = e.clientX;
  zoomTimer = setTimeout(() => { if (zoomFor === el) showZoom(el, x); }, 220);
}
function init() {
  try { S.zoomOn = localStorage.getItem('bdbt_zoom') !== '0'; } catch { /* noop */ }
  document.addEventListener('mouseover', onZoomOver);
  document.addEventListener('mousedown', hideZoom);
  document.addEventListener('dragstart', hideZoom);
  buildDB();
  document.addEventListener('click', onBoardClick);
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragend', () => { dragInfo = null; document.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over')); });
  document.addEventListener('change', (e) => {
    const a = e.target.dataset?.act;
    if (a === 'showopp') { S.showOppHand = e.target.checked; render(); }
    if (a === 'autoswitch') { S.autoSwitch = e.target.checked; }
    if (a === 'zoomtoggle') { S.zoomOn = e.target.checked; try { localStorage.setItem('bdbt_zoom', S.zoomOn ? '1' : '0'); } catch { /* noop */ } hideZoom(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'name-input') {
      try { localStorage.setItem(LS_NAME, e.target.value); } catch { /* noop */ }
    }
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.id === 'name-input') {
      if (online()) { S.sides[S.mySeat].name = myName(); commit(); }
      else if (S.ctrl === 0) { S.sides[0].name = myName(); render(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,select')) { if (e.key === 'Enter' && e.target.id === 'join-code') handleAct('join-go'); return; }
    if (e.key === 'Escape') { closeMenu(); if (S.modal && !['mulligan', 'damage', 'discard', 'deck'].includes(S.modal.type)) closeModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'd' && !S.modal) { act(() => drawCards(S.ctrl, 1))(); }
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault(); const i = $('#chat-input'); const text = i.value.trim(); if (!text) return;
    addLog({ t: now(), text: `${esc(myName())}: ${esc(text)}`, kind: 'chat', html: true });
    send({ t: 'chat', from: myName(), text }); i.value = '';
  });
  window.addEventListener('beforeunload', (e) => { if (online() && S.connected) { e.preventDefault(); e.returnValue = ''; } });

  S.sides[0].name = myName();
  // 初回はサンプルデッキを両側にセット
  const decks = loadDecks();
  const d = decks[0] || defaultDeck();
  [0, 1].forEach((s) => {
    const p = parseDeck(d.text); const sd = S.sides[s];
    sd.deckDef = { cards: p.cards, territory: p.territory }; sd.deckName = d.name;
    sd.zones.deck = p.cards.map(makeCard); if (p.territory) sd.zones.territory = [makeCard(p.territory)];
  });
  addLog({ t: now(), text: 'ようこそ。「デッキ」でデッキを登録し、「ゲーム準備」から始めましょう。', kind: 'sys' });
  render();
  const room = new URLSearchParams(location.search).get('room');
  if (room) openModal({ type: 'join', code: room });
}
init();
