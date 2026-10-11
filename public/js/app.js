'use strict';
/* global io */

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
let I18N = {};

function t(path, vars) {
  const parts = path.split('.');
  let node = I18N;
  for (const p of parts) {
    if (node == null) break;
    node = node[p];
  }
  let str = typeof node === 'string' ? node : path;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v);
  }
  return str;
}

function applyStaticI18n() {
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.getAttribute('data-t')); });
  document.querySelectorAll('[data-t-placeholder]').forEach((el) => { el.placeholder = t(el.getAttribute('data-t-placeholder')); });
}

const money = (n) => `${(n || 0).toLocaleString('cs-CZ')} £`;

// ---------------------------------------------------------------------------
// Identity / reconnection (localStorage)
// ---------------------------------------------------------------------------
const ID_KEY = 'gp_identity';
function saveIdentity(id) { localStorage.setItem(ID_KEY, JSON.stringify(id)); }
function loadIdentity() { try { return JSON.parse(localStorage.getItem(ID_KEY)); } catch { return null; } }
function clearIdentity() { localStorage.removeItem(ID_KEY); }

// Personal notebook ("osobní zápisník") — purely client-local per the brief:
// per-room notes about which character a player might be. Never sent to server.
function notesKey(code) { return `gp_notes_${code}`; }
function loadNotes(code) { try { return JSON.parse(localStorage.getItem(notesKey(code))) || {}; } catch { return {}; } }
function saveNote(code, playerId, text) {
  const notes = loadNotes(code);
  notes[playerId] = text;
  localStorage.setItem(notesKey(code), JSON.stringify(notes));
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const socket = io();
let IDENTITY = null; // {code, playerId, token, nick}
let STATE = null; // latest viewFor(...) payload
let LOBBY = null;
let selection = null; // active target-selection flow, see startSelection()
let selectedCardId = null;

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, (ack) => resolve(ack || { ok: true })));
}

// socket.io transparently reconnects its own transport after a network
// blip (flaky WiFi/mobile data), but that gives the server a brand-new
// socket.id — it has no idea which player that new socket belongs to
// until we tell it again. Re-run the identity handshake on every
// reconnect, not just on first page load, so a dropped connection
// recovers without the player having to reload the page.
socket.on('connect', async () => {
  if (!IDENTITY) return; // initial connect, before boot() has even run
  const ack = await emit('room:reconnect', { code: IDENTITY.code, token: IDENTITY.token });
  if (ack.ok) {
    IDENTITY.playerId = ack.playerId;
    IDENTITY.token = ack.token;
    saveIdentity(IDENTITY);
  }
});

function showScreen(id) {
  // screen-intro / screen-lobby / screen-gameover are shown/hidden via the
  // shared `.hidden` class; screen-game has no `.screen` class and uses its
  // own `.active` toggle instead (see style.css) because it's a flex column
  // layout, not the centered single-card layout the others share.
  for (const s of ['screen-intro', 'screen-lobby', 'screen-gameover']) {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  }
  document.getElementById('screen-game').classList.toggle('active', id === 'screen-game');
}

function toast(msg) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const res = await fetch('/locales/cs.json');
  I18N = await res.json();
  applyStaticI18n();
  wireIntroScreen();
  wireLobbyScreen();
  wireGameScreen();
  setInterval(tickTimers, 500);

  const url = new URL(location.href);
  const roomParam = (url.searchParams.get('room') || '').toUpperCase();
  const stored = loadIdentity();

  if (stored && (!roomParam || roomParam === stored.code)) {
    const ack = await emit('room:reconnect', { code: stored.code, token: stored.token });
    if (ack.ok) {
      IDENTITY = { code: ack.code, playerId: ack.playerId, token: ack.token, nick: stored.nick };
      saveIdentity(IDENTITY);
      showScreen(ack.started ? 'screen-game' : 'screen-lobby');
      return;
    }
    clearIdentity();
  }
  if (roomParam) {
    document.getElementById('tab-join').click();
    document.getElementById('join-code').value = roomParam;
  }
  showScreen('screen-intro');
}

// ---------------------------------------------------------------------------
// Intro screen
// ---------------------------------------------------------------------------
function wireIntroScreen() {
  document.getElementById('tab-create').onclick = () => {
    document.getElementById('tab-create').classList.add('active');
    document.getElementById('tab-join').classList.remove('active');
    document.getElementById('pane-create').classList.remove('hidden');
    document.getElementById('pane-join').classList.add('hidden');
  };
  document.getElementById('tab-join').onclick = () => {
    document.getElementById('tab-join').classList.add('active');
    document.getElementById('tab-create').classList.remove('active');
    document.getElementById('pane-join').classList.remove('hidden');
    document.getElementById('pane-create').classList.add('hidden');
  };

  document.getElementById('btn-create').onclick = async () => {
    const nick = document.getElementById('create-nick').value.trim();
    const targetPlayers = Number(document.getElementById('create-player-count').value);
    const ack = await emit('room:create', { nick, targetPlayers });
    if (!ack.ok) return showIntroError(ack.error);
    IDENTITY = { code: ack.code, playerId: ack.playerId, token: ack.token, nick };
    saveIdentity(IDENTITY);
    showScreen('screen-lobby');
  };

  document.getElementById('btn-join').onclick = async () => {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const nick = document.getElementById('join-nick').value.trim();
    const ack = await emit('room:join', { code, nick });
    if (!ack.ok) return showIntroError(ack.error);
    IDENTITY = { code: ack.code, playerId: ack.playerId, token: ack.token, nick };
    saveIdentity(IDENTITY);
    showScreen('screen-lobby');
  };
}

function showIntroError(code) {
  const map = {
    ROOM_NOT_FOUND: 'Místnost s tímto kódem neexistuje.',
    GAME_ALREADY_STARTED: 'Hra v této místnosti už běží.',
    ROOM_FULL: t('lobby.roomFullNotStarted'),
  };
  document.getElementById('intro-error').textContent = map[code] || code || 'Něco se nepovedlo.';
}

// ---------------------------------------------------------------------------
// Lobby screen
// ---------------------------------------------------------------------------
function wireLobbyScreen() {
  document.getElementById('btn-copy-link').onclick = () => {
    const link = `${location.origin}/?room=${IDENTITY.code}`;
    navigator.clipboard?.writeText(link).catch(() => {});
    document.getElementById('btn-copy-link').textContent = t('lobby.copied');
    setTimeout(() => { document.getElementById('btn-copy-link').textContent = t('lobby.copyLink'); }, 1500);
  };
  document.getElementById('btn-start').onclick = () => emit('room:start');
}

socket.on('room:update', (payload) => {
  LOBBY = payload;
  if (!IDENTITY) return;
  document.getElementById('lobby-code').textContent = payload.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  payload.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'player-chip';
    row.innerHTML = `<span>${escapeHtml(p.nick)}</span>${p.id === payload.you ? ' <span class="dim">(ty)</span>' : ''}${!p.connected ? ' <span class="dim">(odpojen)</span>' : ''}`;
    list.appendChild(row);
  });
  document.querySelector('[data-t="lobby.players"]').textContent = `${t('lobby.players')} (${payload.players.length}/${payload.targetPlayers})`;
  const startBtn = document.getElementById('btn-start');
  startBtn.disabled = !(payload.isHost && payload.canStart);
  document.getElementById('lobby-status').textContent = payload.canStart
    ? (payload.isHost ? '' : t('lobby.readyToStart'))
    : t('lobby.waitingFor', { joined: payload.players.length, target: payload.targetPlayers });
  if (payload.started) showScreen('screen-game');
  else showScreen('screen-lobby');
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Game state stream
// ---------------------------------------------------------------------------
socket.on('game:state', (view) => {
  STATE = view;
  if (view.phase === 'GAME_OVER') {
    renderGameOver(view);
    showScreen('screen-gameover');
    return;
  }
  showScreen('screen-game');
  render();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function me() { return STATE.players.find((p) => p.id === IDENTITY.playerId); }
function playerById(id) { return STATE.players.find((p) => p.id === id); }
function estateById(id) { return STATE.estates.find((e) => e.id === id); }

function render() {
  renderTopbar();
  renderMap();
  renderPlayers();
  renderMyPanel();
  renderHand();
  renderActions();
  renderOffers();
  renderLog();
  renderModals();
}

function renderTopbar() {
  document.getElementById('top-round').textContent = STATE.round;
  document.getElementById('top-phase').textContent = t('phases.' + STATE.phase);
  const active = playerById(STATE.activePlayer);
  document.getElementById('top-turn').textContent = active
    ? (active.id === IDENTITY.playerId ? t('top.yourTurn') : `${t('top.turnOf')} ${active.nick}`)
    : '';
  document.getElementById('top-event').textContent = STATE.currentEvent ? t('events.' + STATE.currentEvent + '.name') : t('top.noEvent');
  document.getElementById('inv-value').textContent = STATE.investigation;
  document.getElementById('inv-fill').style.width = `${Math.min(100, (STATE.investigation / 36) * 100)}%`;
  document.getElementById('inv-mark-auto').style.left = `${(STATE.autoRaidThreshold / 36) * 100}%`;
  const th = STATE.goals.TH;
  document.getElementById('inv-mark-th').style.left = `${(th / 36) * 100}%`;
}

function remainingSec(deadline) {
  if (!deadline) return null;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function tickTimers() {
  if (!STATE) return;
  const timerEl = document.getElementById('top-timer');
  let deadline = null;
  if (STATE.phase === 'NEGOTIATION') deadline = STATE.deadlines.negotiation;
  else if (STATE.phase === 'TURNS' && !STATE.pendingReaction && !STATE.pendingAuction) deadline = STATE.deadlines.turn;
  if (deadline) {
    const s = remainingSec(deadline);
    timerEl.textContent = `${s}s`;
    timerEl.classList.toggle('urgent', s <= 10);
  } else {
    timerEl.textContent = '—';
    timerEl.classList.remove('urgent');
  }
  const modalCountdown = document.getElementById('modal-countdown');
  if (modalCountdown && modalCountdown.dataset.deadline) {
    const s = remainingSec(Number(modalCountdown.dataset.deadline));
    modalCountdown.textContent = `${s}s`;
  }
}

// ---- Map ----
function renderMap() {
  const svg = document.getElementById('map-svg');
  svg.innerHTML = '';
  const selectableIds = selection && selection.kind === 'estate' ? STATE.estates.filter(selection.filter).map((e) => e.id) : [];
  for (const e of STATE.estates) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', e.x);
    circle.setAttribute('cy', e.y);
    circle.setAttribute('r', 20);
    const owner = e.owner ? playerById(e.owner) : null;
    circle.setAttribute('fill', owner ? owner.color : 'rgba(255,255,255,0.12)');
    circle.classList.add('territory');
    if (selectableIds.includes(e.id)) circle.classList.add('selectable');
    if (selection && selection.collected.includes(e.id)) circle.classList.add('selected');
    circle.addEventListener('click', () => onTerritoryClick(e));
    g.appendChild(circle);

    if (e.grow === true) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', e.x);
      dot.setAttribute('cy', e.y - 26);
      dot.setAttribute('r', 5);
      dot.setAttribute('fill', '#2fae4e');
      dot.classList.add('territory-grow-icon');
      g.appendChild(dot);
    } else if (e.grow === false) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', e.x);
      dot.setAttribute('cy', e.y - 26);
      dot.setAttribute('r', 4);
      dot.setAttribute('fill', 'none');
      dot.setAttribute('stroke', 'rgba(255,255,255,0.5)');
      dot.classList.add('territory-grow-icon');
      g.appendChild(dot);
    }

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', e.x);
    label.setAttribute('y', e.y + 4);
    label.textContent = e.id;
    label.classList.add('territory-label');
    g.appendChild(label);

    g.addEventListener('mouseenter', () => showTerritoryTooltip(e));
    svg.appendChild(g);
  }
}

function showTerritoryTooltip(e) {
  const owner = e.owner ? playerById(e.owner) : null;
  const ownerText = owner ? owner.nick : t('map.neutral');
  let growText = t('map.unknown');
  if (e.grow === true) growText = t('map.grow');
  else if (e.grow === false) growText = t('map.empty');
  let stale = e.stale ? ` (${t('map.stale', { round: e.knownRound })})` : '';
  document.getElementById('map-tooltip').textContent = `${e.name} — ${t('map.owner')}: ${ownerText} — ${growText}${stale}`;
}

function onTerritoryClick(e) {
  if (!selection || selection.kind !== 'estate') return;
  if (!selection.filter(e)) return;
  if (selection.collected.includes(e.id)) {
    selection.collected = selection.collected.filter((id) => id !== e.id);
  } else {
    if (selection.collected.length >= selection.need) selection.collected.shift();
    selection.collected.push(e.id);
  }
  if (selection.collected.length === selection.need) {
    const ids = selection.collected.slice();
    const fn = selection.onComplete;
    selection = null;
    fn(ids);
  }
  render();
}

// ---- Players ----
function renderPlayers() {
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  const notes = loadNotes(STATE.id);
  for (const p of STATE.players) {
    const row = document.createElement('div');
    row.className = 'player-row' + (p.id === STATE.activePlayer ? ' active-turn' : '') + (!p.connected ? ' disconnected' : '');
    const selectable = selection && selection.kind === 'player' && selection.filter(p);
    row.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <span class="nick">${escapeHtml(p.nick)}${p.id === IDENTITY.playerId ? ` <span class="dim">${t('players.you')}</span>` : ''}</span>
      <span class="stat">🏠${p.estateCount} 🌿${p.growCount} 🂠${p.cardCount}</span>
    `;
    if (selectable) {
      row.style.cursor = 'pointer';
      row.style.outline = '2px solid var(--gold-bright)';
      row.addEventListener('click', () => {
        const fn = selection.onComplete;
        selection = null;
        fn([p.id]);
      });
    }
    if (p.id !== IDENTITY.playerId) {
      const noteInput = document.createElement('input');
      noteInput.className = 'note-input';
      noteInput.placeholder = t('panel.characterGuessLabel');
      noteInput.value = notes[p.id] || '';
      noteInput.title = t('panel.notesHint');
      noteInput.addEventListener('change', () => saveNote(STATE.id, p.id, noteInput.value));
      row.appendChild(noteInput);
    }
    list.appendChild(row);
  }

  const box = document.getElementById('negotiation-box');
  if (STATE.phase === 'NEGOTIATION') {
    box.classList.remove('hidden');
    document.getElementById('negotiation-status').textContent = '';
  } else {
    box.classList.add('hidden');
  }
}

// ---- My panel ----
function renderMyPanel() {
  const self = me();
  const info = STATE.myCharacterInfo;
  const el = document.getElementById('my-character');
  if (info) {
    el.innerHTML = `
      <p class="serif" style="font-size:1.1em; margin-bottom:2px;">${escapeHtml(info.name)}
        <span class="badge-side badge-${self.side}">${t('sides.' + self.side)}</span></p>
      <p class="dim"><b>${t('panel.ability')}:</b> ${escapeHtml(info.ability)}</p>
      <p class="dim"><b>${t('panel.weakness')}:</b> ${escapeHtml(info.weakness)}</p>
    `;
  }
  const g = STATE.myGoalProgress;
  let text = '', pct = 0;
  if (g) {
    if (g.grows && g.estates) {
      text = `${t('panel.grows')} ${g.grows[0]}/${g.grows[1]}, ${t('panel.estates')} ${g.estates[0]}/${g.estates[1]}`;
      pct = Math.min(100, ((g.grows[0] / g.grows[1]) + (g.estates[0] / g.estates[1])) / 2 * 100);
    } else if (g.investigation) {
      text = `${t('top.investigation')} ${g.investigation[0]}/${g.investigation[1]}, ${t('panel.grows')} ${g.grows[0]}/${g.grows[1]}`;
      pct = Math.min(100, ((g.investigation[0] / g.investigation[1]) + (g.grows[0] / g.grows[1])) / 2 * 100);
    }
  }
  document.getElementById('my-goal-text').textContent = text;
  document.getElementById('my-goal-fill').style.width = `${pct}%`;
  document.getElementById('my-money').textContent = money(self.money);
}

// ---- Hand ----
const PLAYABLE_TURN_CARDS = ['informator', 'razie', 'nabidka', 'cerny', 'kompro', 'presun', 'dedicke'];

function renderHand() {
  const self = me();
  const hand = document.getElementById('my-hand');
  hand.innerHTML = '';
  (self.hand || []).forEach((cardId, idx) => {
    const def = I18N.cards[cardId] || { name: cardId, desc: '' };
    const div = document.createElement('div');
    div.className = 'action-card' + (selectedCardId === cardId ? ' selected' : '');
    div.innerHTML = `<div class="card-name">${escapeHtml(def.name)}</div><div class="card-desc">${escapeHtml(def.desc)}</div>`;
    if (PLAYABLE_TURN_CARDS.includes(cardId)) {
      div.addEventListener('click', () => startPlayCard(cardId));
    } else {
      div.style.opacity = '0.65';
      div.title = 'Hraje se jen jako reakce.';
    }
    hand.appendChild(div);
  });
}

function canAct() {
  return STATE.phase === 'TURNS' && STATE.activePlayer === IDENTITY.playerId &&
    !STATE.pendingReaction && !STATE.pendingAuction && !STATE.pendingLordPurchase && STATE.actionsLeft > 0;
}

function startSelection(kind, need, filter, onComplete) {
  selection = { kind, need, filter, collected: [], onComplete };
  render();
}

function cancelSelection() {
  selection = null;
  selectedCardId = null;
  render();
}

async function sendTurnAction(subtype, payload) {
  const ack = await emit('game:action', { type: 'turn_action', subtype, payload: payload || {} });
  if (!ack.ok) toast(`Akce se nepovedla: ${ack.error}`);
}

function startPlayCard(cardId) {
  if (!canAct()) return toast('Nejsi na tahu nebo nemáš akci k dispozici.');
  selectedCardId = cardId;
  const self = me();
  const othersEstateFilter = (e) => e.owner && e.owner !== IDENTITY.playerId;
  const ownEstateFilter = (e) => e.owner === IDENTITY.playerId;
  const ownGrowFilter = (e) => e.owner === IDENTITY.playerId && e.grow === true;

  switch (cardId) {
    case 'informator': {
      const n = me().character === 'hrabe' ? 3 : 2;
      startSelection('estate', n, () => true, (ids) => { sendPlayCard(cardId, { estateIds: ids }); });
      return;
    }
    case 'razie':
      startSelection('estate', 1, () => true, (ids) => sendPlayCard(cardId, { estateId: ids[0] }));
      return;
    case 'nabidka':
    case 'dedicke':
      startSelection('estate', 1, othersEstateFilter, (ids) => sendPlayCard(cardId, { estateId: ids[0] }));
      return;
    case 'cerny':
      startSelection('estate', 1, ownGrowFilter, (ids) => sendPlayCard(cardId, { estateId: ids[0] }));
      return;
    case 'presun':
      startSelection('estate', 2, ownEstateFilter, (ids) => sendPlayCard(cardId, { estateIds: ids }));
      return;
    case 'kompro':
      startSelection('player', 1, (p) => p.id !== IDENTITY.playerId, (ids) => sendPlayCard(cardId, { targetPlayerId: ids[0] }));
      return;
    default:
      selectedCardId = null;
  }
}

async function sendPlayCard(cardId, payload) {
  selectedCardId = null;
  const ack = await emit('game:action', { type: 'turn_action', subtype: 'play_card', payload: { cardId, ...payload } });
  if (!ack.ok) toast(`Karta se nepovedla: ${ack.error}`);
}

// ---- Turn actions ----
function renderActions() {
  const grid = document.getElementById('actions-grid');
  grid.innerHTML = '';
  const hint = document.getElementById('action-hint');
  if (selection) {
    hint.textContent = `${t('actions.pickUpToN', { n: selection.need })} (${selection.collected.length}/${selection.need})`;
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = t('actions.cancel');
    cancel.onclick = cancelSelection;
    grid.appendChild(cancel);
    return;
  }
  hint.textContent = canAct() ? `${t('top.actionsLeft')}: ${STATE.actionsLeft}` : '';
  if (!canAct()) return;

  const self = me();
  const buttons = [
    { subtype: 'draw_card', cost: 0, enabled: true },
    { subtype: 'buy_cards', cost: 200000, enabled: self.money >= 200000 },
    { subtype: 'buy_estate', cost: 500000, enabled: STATE.estates.some((e) => e.owner === null) },
    { subtype: 'sow', cost: 500000, enabled: STATE.estates.some((e) => e.owner === IDENTITY.playerId && e.grow === false) },
    { subtype: 'check', cost: 200000, enabled: true },
    { subtype: 'denounce', cost: 200000, enabled: STATE.estates.some((e) => e.owner && e.owner !== IDENTITY.playerId) },
  ];
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = `${t('actions.' + b.subtype)}`;
    btn.disabled = !b.enabled;
    btn.onclick = () => triggerTurnAction(b.subtype);
    grid.appendChild(btn);
  }
}

function triggerTurnAction(subtype) {
  switch (subtype) {
    case 'draw_card':
    case 'buy_cards':
      return sendTurnAction(subtype, {});
    case 'buy_estate':
      return startSelection('estate', 1, (e) => e.owner === null, (ids) => sendTurnAction('buy_estate', { estateId: ids[0] }));
    case 'sow':
      return startSelection('estate', 1, (e) => e.owner === IDENTITY.playerId && e.grow === false, (ids) => sendTurnAction('sow', { estateId: ids[0] }));
    case 'check':
      return startSelection('estate', 1, () => true, (ids) => sendTurnAction('check', { estateId: ids[0] }));
    case 'denounce':
      return startSelection('estate', 1, (e) => e.owner && e.owner !== IDENTITY.playerId, (ids) => sendTurnAction('denounce', { estateId: ids[0] }));
  }
}

// ---------------------------------------------------------------------------
// Negotiation ready button
// ---------------------------------------------------------------------------
function wireGameScreen() {
  document.getElementById('btn-ready').onclick = async () => {
    await emit('game:action', { type: 'negotiation_ready' });
    document.getElementById('negotiation-status').textContent = t('top.readyWaiting');
  };
  document.getElementById('btn-new-offer').onclick = openNewOfferModal;
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------
function renderOffers() {
  const list = document.getElementById('offers-list');
  list.innerHTML = '';
  for (const o of STATE.offers) {
    if (o.status !== 'open' && Date.now() - (o.deadline || 0) > 15000) continue;
    const div = document.createElement('div');
    div.className = 'offer-card';
    const fromP = playerById(o.from);
    const toP = playerById(o.to);
    if (o.hidden) {
      div.textContent = t('offers.hiddenOffer', { from: fromP?.nick, to: toP?.nick });
    } else {
      div.innerHTML = `
        <div>${escapeHtml(fromP?.nick)} → ${escapeHtml(toP?.nick)} <span class="status">[${t('offers.status_' + o.status)}]</span></div>
        <div class="dim">${t('offers.give')}: ${describeItems(o.give)}</div>
        <div class="dim">${t('offers.want')}: ${describeItems(o.want)}</div>
        ${o.message ? `<div class="dim">“${escapeHtml(o.message)}”</div>` : ''}
      `;
      if (o.status === 'open' && o.to === IDENTITY.playerId) {
        const row = document.createElement('div');
        row.className = 'row';
        row.style.marginTop = '6px';
        const accept = mkBtn(t('offers.accept'), () => respondOffer(o.id, 'accept'));
        const reject = mkBtn(t('offers.reject'), () => respondOffer(o.id, 'reject'), 'secondary');
        row.appendChild(accept);
        row.appendChild(reject);
        div.appendChild(row);
      }
    }
    list.appendChild(div);
  }
}

function mkBtn(text, onClick, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onClick;
  return b;
}

function describeItems(items) {
  const parts = [];
  if (items.money) parts.push(money(items.money));
  if (items.cards && items.cards.length) parts.push(`${items.cards.length}× ${t('offers.cards')}`);
  if (items.estates && items.estates.length) parts.push(`${t('offers.estates')} #${items.estates.join(', #')}`);
  if (items.reveal != null) parts.push(`${t('offers.reveal')} #${items.reveal}`);
  return parts.length ? parts.join(', ') : '—';
}

async function respondOffer(offerId, action) {
  const ack = await emit('game:action', { type: 'offer_respond', payload: { offerId, action } });
  if (!ack.ok) toast(`Obchod: ${ack.error}`);
}

function openNewOfferModal() {
  const others = STATE.players.filter((p) => p.id !== IDENTITY.playerId);
  const self = me();
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${t('offers.new')}</h2>
        <div class="field">
          <label>${t('offers.to')}</label>
          <select id="offer-to">${others.map((p) => `<option value="${p.id}">${escapeHtml(p.nick)}</option>`).join('')}</select>
        </div>
        <h3>${t('offers.give')}</h3>
        <div class="field"><label>${t('offers.money')}</label><input id="give-money" type="number" step="100000" min="0" max="${self.money}" value="0" /></div>
        <div class="field"><label>${t('offers.cards')} (ID oddělené čárkou z ruky: ${(self.hand||[]).join(', ')})</label><input id="give-cards" placeholder="např. razie,informator" /></div>
        <div class="field"><label>${t('offers.estates')} (čísla panství oddělená čárkou)</label><input id="give-estates" placeholder="např. 12,7" /></div>
        <div class="field"><label>${t('offers.reveal')} (číslo panství, nebo prázdné)</label><input id="give-reveal" placeholder="např. 9" /></div>
        <h3>${t('offers.want')}</h3>
        <div class="field"><label>${t('offers.money')}</label><input id="want-money" type="number" step="100000" min="0" value="0" /></div>
        <div class="field"><label>${t('offers.cards')} (typ karty oddělené čárkou, musí je mít v ruce)</label><input id="want-cards" placeholder="např. razie,informator" /></div>
        <div class="field"><label>${t('offers.estates')} (čísla panství oddělená čárkou)</label><input id="want-estates" placeholder="např. 3" /></div>
        <div class="field"><label>${t('offers.message')}</label><input id="offer-message" maxlength="140" /></div>
        <div class="choices">
          <button id="offer-send">${t('offers.send')}</button>
          <button class="secondary" id="offer-cancel">${t('common.close')}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('offer-cancel').onclick = () => { root.innerHTML = ''; };
  document.getElementById('offer-send').onclick = async () => {
    const to = document.getElementById('offer-to').value;
    const giveRevealRaw = document.getElementById('give-reveal').value.trim();
    const give = {
      money: Number(document.getElementById('give-money').value || 0),
      cards: splitList(document.getElementById('give-cards').value),
      estates: splitList(document.getElementById('give-estates').value).map(Number),
      reveal: giveRevealRaw ? Number(giveRevealRaw) : null,
    };
    const want = {
      money: Number(document.getElementById('want-money').value || 0),
      cards: splitList(document.getElementById('want-cards').value),
      estates: splitList(document.getElementById('want-estates').value).map(Number),
    };
    const message = document.getElementById('offer-message').value;
    const ack = await emit('game:action', { type: 'offer_create', payload: { to, give, want, message } });
    root.innerHTML = '';
    if (!ack.ok) toast(`Nabídka: ${ack.error}`);
  };
}

function splitList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
function renderLog() {
  const list = document.getElementById('log-list');
  list.innerHTML = '';
  const entries = STATE.log.slice(-60).reverse();
  for (const e of entries) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `<span class="round-tag">K${e.round}</span>${escapeHtml(e.text)}`;
    list.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Modals: reaction / auction / lord purchase / discard / debt
// ---------------------------------------------------------------------------
function renderModals() {
  const root = document.getElementById('modal-root');
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && root.contains(document.activeElement)) {
    return; // don't yank focus away from an open "new offer" form while typing
  }

  if (STATE.pendingReaction) return renderReactionModal(STATE.pendingReaction);
  if (STATE.pendingAuction) return renderAuctionModal(STATE.pendingAuction);
  if (STATE.pendingLordPurchase && STATE.pendingLordPurchase.playerId === IDENTITY.playerId) {
    return renderLordPurchaseModal(STATE.pendingLordPurchase);
  }
  if (STATE.myPendingDiscard) return renderDiscardModal(STATE.myPendingDiscard);
  if (STATE.myPendingDebt) return renderDebtModal(STATE.myPendingDebt);
  if (root.dataset.kind && !['offer'].includes(root.dataset.kind)) root.innerHTML = '';
}

function modalShell(title, bodyHtml, kind) {
  const root = document.getElementById('modal-root');
  root.dataset.kind = kind;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><h2>${title}</h2>${bodyHtml}</div></div>`;
}

function renderReactionModal(r) {
  const estate = r.estateId != null ? estateById(r.estateId) : null;
  const isMine = r.awaiting === IDENTITY.playerId;
  const countdown = `<div class="countdown" id="modal-countdown" data-deadline="${r.deadline}">${remainingSec(r.deadline)}s</div>`;

  if (r.type === 'raid') {
    const waitingNick = playerById(r.awaiting)?.nick;
    let choices = '';
    if (isMine) {
      choices = `<div class="choices">
        ${r.canBribe ? `<button id="rx-bribe">${t('reaction.bribe')}</button>` : ''}
        ${r.canFalseLead ? `<button id="rx-false">${t('reaction.falseLead')}</button>` : ''}
        <button class="secondary" id="rx-pass">${t('reaction.pass')}</button>
      </div>`;
    } else {
      choices = `<p class="dim">Čeká se na ${escapeHtml(waitingNick || '')}…</p>`;
    }
    modalShell(t('reaction.raidTitle'), `${countdown}<p>${t('reaction.raidOn', { name: estate ? escapeHtml(estate.name) : r.estateId })}</p>${choices}`, 'reaction');
    if (isMine) {
      document.getElementById('rx-pass').onclick = () => sendReaction({ choice: 'pass' });
      if (r.canBribe) document.getElementById('rx-bribe').onclick = () => sendReaction({ choice: 'bribe' });
      if (r.canFalseLead) document.getElementById('rx-false').onclick = () => openFalseLeadPicker(r);
    }
    return;
  }

  if (r.type === 'hostile_offer') {
    const attackerNick = playerById(r.attacker)?.nick;
    let choices = '<p class="dim">Čeká se na rozhodnutí…</p>';
    if (isMine) {
      choices = `<div class="choices">
        <button id="rx-accept">${t('reaction.accept')}</button>
        ${r.canRefuse ? `<button id="rx-refuse">${t('reaction.refuse')}</button>` : ''}
        ${r.canLawyer ? `<button class="secondary" id="rx-lawyer">${t('reaction.lawyer')}</button>` : ''}
      </div>`;
    }
    modalShell(t('reaction.hostileTitle'), `${countdown}<p>${t('reaction.hostileOn', { attacker: escapeHtml(attackerNick || ''), estate: estate ? escapeHtml(estate.name) : r.estateId })}</p>${choices}`, 'reaction');
    if (isMine) {
      document.getElementById('rx-accept').onclick = () => sendReaction({ choice: 'accept' });
      if (r.canRefuse) document.getElementById('rx-refuse').onclick = () => sendReaction({ choice: 'refuse' });
      if (r.canLawyer) document.getElementById('rx-lawyer').onclick = () => sendReaction({ choice: 'lawyer' });
    }
    return;
  }

  if (r.type === 'kompro') {
    const attackerNick = playerById(r.attacker)?.nick;
    const myHandCount = me().hand.length;
    let choices = '<p class="dim">Čeká se na rozhodnutí…</p>';
    if (isMine) {
      choices = `<div class="choices">
        <button id="rx-money">${t('reaction.payMoney')}</button>
        ${myHandCount >= 1 ? `<button id="rx-cards">${t('reaction.giveCards')}</button>` : ''}
        ${r.canLawyer ? `<button class="secondary" id="rx-lawyer">${t('reaction.lawyer')}</button>` : ''}
      </div>`;
    }
    modalShell(t('reaction.komproTitle'), `${countdown}<p>${t('reaction.komproOn', { attacker: escapeHtml(attackerNick || '') })}</p>${choices}`, 'reaction');
    if (isMine) {
      document.getElementById('rx-money').onclick = () => sendReaction({ choice: 'money' });
      if (myHandCount >= 1) document.getElementById('rx-cards').onclick = () => sendReaction({ choice: 'cards' });
      if (r.canLawyer) document.getElementById('rx-lawyer').onclick = () => sendReaction({ choice: 'lawyer' });
    }
    return;
  }

  if (r.type === 'dedicke') {
    const attackerNick = playerById(r.attacker)?.nick;
    let choices = '<p class="dim">Čeká se na rozhodnutí…</p>';
    if (isMine) {
      choices = `<div class="choices">
        <button id="rx-proceed">${t('reaction.proceedToAuction')}</button>
        ${r.canLawyer ? `<button class="secondary" id="rx-lawyer">${t('reaction.lawyer')}</button>` : ''}
      </div>`;
    }
    modalShell(t('reaction.dedickeTitle'), `${countdown}<p>${t('reaction.dedickeOn', { attacker: escapeHtml(attackerNick || ''), estate: estate ? escapeHtml(estate.name) : r.estateId })}</p>${choices}`, 'reaction');
    if (isMine) {
      document.getElementById('rx-proceed').onclick = () => sendReaction({ choice: 'pass' });
      if (r.canLawyer) document.getElementById('rx-lawyer').onclick = () => sendReaction({ choice: 'lawyer' });
    }
  }
}

function openFalseLeadPicker(r) {
  const candidates = STATE.estates.filter((e) => e.owner && e.owner !== r.awaiting && !r.history.includes(e.id));
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">
    <h2>${t('reaction.falseLead')}</h2>
    <p>${t('actions.pickOtherEstate')}</p>
    <select id="fl-select">${candidates.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (#${e.id})</option>`).join('')}</select>
    <div class="choices"><button id="fl-go">${t('actions.confirm')}</button></div>
  </div></div>`;
  document.getElementById('fl-go').onclick = () => sendReaction({ choice: 'false_lead', estateId: Number(document.getElementById('fl-select').value) });
}

async function sendReaction(payload) {
  const ack = await emit('game:action', { type: 'reaction_choice', payload });
  if (!ack.ok) toast(`Reakce: ${ack.error}`);
}

function renderAuctionModal(a) {
  const isParticipant = a.participants.includes(IDENTITY.playerId);
  const estate = estateById(a.estateId);
  const title = a.kind === 'seizure' ? t('auction.seizureTitle') : t('auction.successionTitle');
  const countdown = `<div class="countdown" id="modal-countdown" data-deadline="${a.deadline}">${remainingSec(a.deadline)}s</div>`;
  const myBid = a.bids[IDENTITY.playerId];
  const submittedMine = myBid !== null && myBid !== undefined;
  let body = `${countdown}<p>${estate ? escapeHtml(estate.name) : ''}</p>`;
  if (!isParticipant) {
    body += `<p class="dim">${t('auction.waitingOthers')}</p>`;
  } else if (a.revealed) {
    body += `<p><b>${t('auction.revealed')}:</b></p><ul>${a.participants.map((pid) => `<li>${escapeHtml(playerById(pid)?.nick)}: ${money(a.bids[pid])}</li>`).join('')}</ul>`;
  } else if (submittedMine) {
    body += `<p class="dim">${t('auction.submitted')}</p>`;
  } else {
    body += `<div class="field"><label>${t('auction.bidLabel')}</label><input id="bid-amount" type="number" step="100000" min="0" max="${me().money}" value="0" /></div>
      <p class="dim">${t('auction.celnikMin')}</p>
      <div class="choices"><button id="bid-submit">${t('auction.submit')}</button></div>`;
  }
  modalShell(title, body, 'auction');
  if (isParticipant && !submittedMine && !a.revealed) {
    document.getElementById('bid-submit').onclick = async () => {
      const amount = Number(document.getElementById('bid-amount').value || 0);
      const ack = await emit('game:action', { type: 'auction_bid', payload: { amount } });
      if (!ack.ok) toast(`Dražba: ${ack.error}`);
    };
  }
}

function renderLordPurchaseModal(lp) {
  const estate = estateById(lp.estateId);
  const body = `
    <p>${t('lordPurchase.drew')} <b>${escapeHtml(t('lords.' + lp.lordType))}</b></p>
    <p>${t('lordPurchase.price')}: <b>${money(lp.price)}</b></p>
    <p>${estate ? escapeHtml(estate.name) : ''}</p>
    <div class="choices">
      <button id="lp-buy" ${me().money < lp.price ? 'disabled' : ''}>${t('lordPurchase.buy')}</button>
      <button class="secondary" id="lp-decline">${t('lordPurchase.decline')}</button>
    </div>`;
  modalShell(t('lordPurchase.title'), body, 'lord');
  document.getElementById('lp-buy').onclick = () => emit('game:action', { type: 'confirm_lord_purchase', payload: { accept: true } });
  document.getElementById('lp-decline').onclick = () => emit('game:action', { type: 'confirm_lord_purchase', payload: { accept: false } });
}

function renderDiscardModal(pending) {
  const self = me();
  const body = `
    <p>${t('discard.pick', { need: pending.need })}</p>
    <div id="discard-choices">${self.hand.map((c, i) => `<label style="display:block;"><input type="checkbox" value="${c}" data-idx="${i}" /> ${escapeHtml((I18N.cards[c] || {}).name || c)}</label>`).join('')}</div>
    <div class="choices"><button id="discard-go">${t('actions.confirm')}</button></div>`;
  modalShell(t('discard.title'), body, 'discard');
  document.getElementById('discard-go').onclick = () => {
    const boxes = Array.from(document.querySelectorAll('#discard-choices input:checked'));
    if (boxes.length !== pending.need) return toast(`Vyber přesně ${pending.need} karet.`);
    const cardIds = boxes.map((b) => b.value);
    emit('game:action', { type: 'resolve_discard', payload: { cardIds } });
  };
}

function renderDebtModal(pending) {
  const options = pending.candidates.map((id) => estateById(id)).filter(Boolean);
  const body = `
    <p>${t('debt.cantPay')}</p>
    <select id="debt-select">${options.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (#${e.id})</option>`).join('')}</select>
    <div class="choices"><button id="debt-go">${t('debt.return')}</button></div>`;
  modalShell(t('debt.title'), body, 'debt');
  document.getElementById('debt-go').onclick = () => {
    const estateId = Number(document.getElementById('debt-select').value);
    emit('game:action', { type: 'resolve_debt', payload: { estateId } });
  };
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function renderGameOver(view) {
  const winnerP = view.players.find((p) => p.id === (view.winner && view.winner.playerId));
  document.getElementById('gameover-winner').textContent = view.winner
    ? t('gameOver.winnerIs', { nick: winnerP?.nick, character: (I18N.characters[winnerP?.character] || {}).name, side: t('sides.' + view.winner.side) })
    : 'Hra skončila bez vítěze (pojistka na počet kol).';
  const reveal = document.getElementById('gameover-reveal');
  reveal.innerHTML = view.players.map((p) => `
    <div class="player-chip"><span class="swatch" style="background:${p.color}"></span>
    <b>${escapeHtml(p.nick)}</b> — ${escapeHtml((I18N.characters[p.character] || {}).name || p.character)}
    <span class="badge-side badge-${p.side}">${t('sides.' + p.side)}</span>
    <span class="dim">${money(p.money)}, ${p.estateCount} panství, ${p.growCount} pěstíren</span></div>
  `).join('');
  const setAside = document.getElementById('gameover-setaside');
  setAside.innerHTML = (view.setAside || []).map((c) => `<span class="badge-side">${escapeHtml((I18N.characters[c] || {}).name || c)}</span>`).join(' ') || '—';
}

boot();
