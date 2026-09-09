/* ===========================================================================
 * CyberPulse: Shadow Net — online client
 * ---------------------------------------------------------------------------
 * This file replaces the offline IIFE that used to live inside index.html.
 * The markup, styling and render logic are unchanged; only the data layer
 * moved. Nothing authoritative is computed or stored here:
 *
 *   • credits, vault, bank, energy, stealth, xp, inventory, properties,
 *     contracts and roles all live in Postgres and are mutated exclusively
 *     through SECURITY DEFINER functions (RPCs) behind row level security.
 *   • localStorage holds only the theme preference and the Supabase session
 *     token issued by the auth service.
 *   • every timer is measured against the server clock, so changing the
 *     device clock does nothing.
 *
 * Sections mirror the original build so the two versions stay comparable.
 * ========================================================================= */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

/* ==========================================================================
 * 0. CLIENT BOOTSTRAP
 * ======================================================================== */
const CONFIG = window.CYBERPULSE_CONFIG || {};
const CONFIGURED =
  typeof CONFIG.SUPABASE_URL === 'string' &&
  /^https?:\/\/[a-z0-9.\-]+(:\d+)?/i.test(CONFIG.SUPABASE_URL) &&
  typeof CONFIG.SUPABASE_ANON_KEY === 'string' &&
  CONFIG.SUPABASE_ANON_KEY.length > 20;

const sb = CONFIGURED
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

const THEME_KEY = 'cyberpulse.theme';

/* Theme preference only — never game state. */
const Storage = (function () {
  let persistent = true;
  const memory = Object.create(null);
  try {
    window.localStorage.setItem('__cp_probe__', '1');
    window.localStorage.removeItem('__cp_probe__');
  } catch (e) { persistent = false; }
  return {
    isPersistent: () => persistent,
    get(key) {
      try { return persistent ? window.localStorage.getItem(key) : (memory[key] ?? null); }
      catch (e) { return memory[key] ?? null; }
    },
    set(key, value) {
      try { if (persistent) { window.localStorage.setItem(key, value); return; } } catch (e) { persistent = false; }
      memory[key] = value;
    }
  };
})();

/* ==========================================================================
 * 1. UTILITIES
 * ======================================================================== */
const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const num   = (v) => Number(v) || 0;

function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}

function stamp(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function dateLong(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** Compact duration for contract timers: 2h 04m, 4m 09s, 12s. */
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(sec).padStart(2, '0') + 's';
  return sec + 's';
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ==========================================================================
 * 2. TOAST + MODAL SYSTEM  (unchanged from the offline build)
 * ======================================================================== */
const TOAST_STYLES = {
  success: { i: 'fa-circle-check',          c: 'text-pulse',      b: 'border-pulse/30' },
  error:   { i: 'fa-triangle-exclamation',  c: 'text-rose-500',   b: 'border-rose-500/30' },
  warn:    { i: 'fa-bolt',                  c: 'text-amberflux',  b: 'border-amberflux/30' },
  info:    { i: 'fa-circle-info',           c: 'text-sky-500',    b: 'border-sky-500/30' }
};

function toast(message, kind) {
  const s = TOAST_STYLES[kind] || TOAST_STYLES.info;
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = 'animate-fadeUp rounded-xl border ' + s.b +
    ' bg-white dark:bg-obsidian-900 shadow-panel px-4 py-3 flex items-start gap-3 text-[12px] leading-snug';
  el.innerHTML = '<i class="fa-solid ' + s.i + ' ' + s.c + ' mt-0.5"></i>' +
                 '<span class="flex-1 text-slate-700 dark:text-slate-300">' + esc(message) + '</span>';
  host.appendChild(el);
  while (host.children.length > 4) host.removeChild(host.firstElementChild);
  setTimeout(function () {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(function () { el.remove(); }, 260);
  }, 3400);
}

function modal(opts) {
  return new Promise(function (resolve) {
    const host = $('#modalHost');
    $('#modalTitle').textContent = opts.title || 'Confirm';
    $('#modalBody').textContent  = opts.body  || '';
    $('#modalOk').textContent    = opts.okText || 'Confirm';
    $('#modalCancel').textContent = opts.cancelText || 'Cancel';
    $('#modalCancel').hidden = !!opts.alert;

    $('#modalOk').className = 'px-3.5 py-2 rounded-lg text-xs font-bold mono-caps transition ' +
      (opts.danger ? 'bg-rose-500 text-white hover:bg-rose-600' : 'bg-pulse text-obsidian-950 hover:bg-pulse-soft');
    $('#modalIcon').className = 'h-10 w-10 shrink-0 rounded-xl grid place-items-center ' +
      (opts.danger ? 'bg-rose-500/10 text-rose-500' : 'bg-pulse/10 text-pulse');
    $('#modalIcon').innerHTML = '<i class="fa-solid ' + (opts.icon || (opts.danger ? 'fa-triangle-exclamation' : 'fa-shield-halved')) + '"></i>';

    const wrap = $('#modalInputWrap');
    const input = $('#modalInput');
    wrap.hidden = !opts.input;
    if (opts.input) {
      input.type = opts.inputType || 'text';
      input.value = opts.inputValue || '';
      input.placeholder = opts.placeholder || '';
    }

    host.hidden = false;
    setTimeout(function () { (opts.input ? input : $('#modalOk')).focus(); }, 30);

    function cleanup(result) {
      host.hidden = true;
      $('#modalOk').removeEventListener('click', onOk);
      $('#modalCancel').removeEventListener('click', onCancel);
      $('#modalBackdrop').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(opts.input ? input.value.trim() : true); }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && opts.input) { e.preventDefault(); onOk(); }
    }
    $('#modalOk').addEventListener('click', onOk);
    $('#modalCancel').addEventListener('click', onCancel);
    $('#modalBackdrop').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

const alertBox = (title, body, icon) => modal({ title, body, alert: true, okText: 'Understood', icon });

/* ==========================================================================
 * 3. THEME ENGINE — the one thing still kept in localStorage
 * ======================================================================== */
const Theme = {
  current: 'dark',
  init() {
    const saved = Storage.get(THEME_KEY);
    this.apply(saved === 'light' || saved === 'dark' ? saved : 'dark', true);
    $$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => Theme.toggle()));
  },
  apply(mode, silent) {
    this.current = mode;
    document.documentElement.classList.toggle('dark', mode === 'dark');
    $$('[data-theme-icon]').forEach((i) => { i.className = 'fa-solid ' + (mode === 'dark' ? 'fa-moon' : 'fa-sun'); });
    Storage.set(THEME_KEY, mode);
    if (!silent) toast(mode === 'dark' ? 'Dark interface engaged' : 'Light interface engaged', 'info');
  },
  toggle() { this.apply(this.current === 'dark' ? 'light' : 'dark'); }
};

/* ==========================================================================
 * 4. API LAYER — every state change is a database function call
 * ======================================================================== */

/**
 * Server error codes are raised as bare identifiers so the client owns the
 * wording. Anything unmapped falls back to a neutral, non-technical line.
 */
const ERROR_COPY = {
  NOT_AUTHENTICATED:    'Session expired. Please log in again.',
  NOT_ENOUGH_ENERGY:    'Not enough energy for that run.',
  INSUFFICIENT_FUNDS:   'Unable to complete transaction. Your balance has not been changed.',
  INSUFFICIENT_VAULT:   'Vault balance is too low. Your balance has not been changed.',
  INSUFFICIENT_BANK:    'Bank gateway balance is too low. Your balance has not been changed.',
  INVALID_AMOUNT:       'Enter an amount above zero.',
  INVALID_BET:          'Enter a wager above zero.',
  INVALID_MODE:         'That wager mode is not available.',
  INVALID_FACE:         'Pick a face between 1 and 6.',
  INVALID_DIRECTION:    'That transfer direction is not available.',
  UNKNOWN_OPERATION:    'That exploit is no longer available.',
  UNKNOWN_TARGET:       'That node has dropped off the subnet. Run a new scan.',
  UNKNOWN_ITEM:         'That listing is no longer available.',
  UNKNOWN_PROPERTY:     'That listing is no longer available.',
  UNKNOWN_MISSION:      'That contract is no longer available.',
  UNKNOWN_RUN:          'That contract is no longer available.',
  UNKNOWN_PLAYER:       'That operative no longer exists.',
  OUT_OF_STOCK:         'That listing is no longer available.',
  OWNERSHIP_LIMIT:      'You already hold the maximum number of that property.',
  NO_PROPERTIES:        'You do not hold any properties yet.',
  NOTHING_TO_COLLECT:   'Nothing has accrued yet. Check back shortly.',
  MISSION_IN_PROGRESS:  'Mission is still in progress.',
  ALREADY_RESOLVED:     'That contract has already been settled.',
  CLEARANCE_TOO_LOW:    'Your clearance tier is too low for that contract.',
  MISSING_EQUIPMENT:    'You are missing the equipment this contract requires.',
  MISSION_COOLDOWN:     'That contract is still cooling down. Try another one.',
  ENERGY_FULL:          'Energy already at maximum.',
  FORBIDDEN:            'You do not have clearance for that action.',
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role.',
  CANNOT_PURGE_SELF:    'You cannot purge your own account.',
  PROFILE_MISSING:      'Session expired. Please log in again.',

  /* --- Phase 5: shadow exchange ------------------------------------- */
  INVALID_QUANTITY:     'Enter a quantity of at least one.',
  INVALID_PRICE:        'Enter a price above zero.',
  LISTING_LIMIT:        'You already have the maximum number of live listings. Withdraw one first.',
  PRICE_OUT_OF_BAND:    'That price is outside the range the exchange allows for this item.',
  NOT_ENOUGH_STOCK:     'You do not hold that many units.',
  UNKNOWN_LISTING:      'That listing is no longer available.',
  NOT_YOUR_LISTING:     'That listing does not belong to you.',
  LISTING_CLOSED:       'That listing is no longer available.',
  CANNOT_BUY_OWN:       'You cannot buy your own listing.',
  CANNOT_BID_OWN:       'You cannot bid on your own listing.',
  PRICE_CHANGED:        'The price changed before your order landed. Your balance has not been changed.',
  OFFER_TOO_LOW:        'That offer is below the minimum the exchange accepts for this listing.',
  OFFER_ABOVE_ASK:      'That offer is above the asking price. Buy it outright instead.',
  OFFER_EXISTS:         'You already have an open offer on that listing.',
  UNKNOWN_OFFER:        'That offer is no longer available.',
  NOT_YOUR_OFFER:       'That offer does not belong to you.'
};

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Extract the bare code the database raised out of a PostgREST error. */
function toApiError(error) {
  const raw = String((error && (error.message || error.hint || error.details)) || '');
  const code = Object.keys(ERROR_COPY).find((k) => raw.includes(k));
  if (code) return new ApiError(code, ERROR_COPY[code]);
  if (/Failed to fetch|NetworkError|network/i.test(raw)) {
    return new ApiError('NETWORK', 'The shadow net is unreachable. Check your connection and try again.');
  }
  if (/JWT|token is expired|invalid claim/i.test(raw)) {
    return new ApiError('NOT_AUTHENTICATED', ERROR_COPY.NOT_AUTHENTICATED);
  }
  console.warn('[CyberPulse] Unmapped server error:', raw);
  return new ApiError('UNKNOWN', 'Something went wrong on the shadow net. Nothing was changed.');
}

async function rpc(fn, args) {
  if (!sb) throw new ApiError('NOT_CONFIGURED', 'This deployment is missing its server configuration.');
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) {
    const api = toApiError(error);
    if (api.code === 'NOT_AUTHENTICATED') handleSessionLoss();
    throw api;
  }
  return data;
}

/**
 * Double-click guard + inline loading state. Every mutating control is wrapped
 * in this, so a second click while a request is in flight is impossible.
 */
const busyKeys = new Set();
async function withBusy(el, key, task) {
  if (busyKeys.has(key)) return;
  busyKeys.add(key);
  let restore = null;
  if (el) {
    restore = { html: el.innerHTML, disabled: el.disabled };
    el.disabled = true;
    el.classList.add('opacity-60', 'cursor-wait');
    el.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
  }
  try {
    return await task();
  } catch (err) {
    if (!(err instanceof ApiError)) console.error('[CyberPulse] Unexpected client error:', err);
    toast(err instanceof ApiError ? err.message : 'Something went wrong. Nothing was changed.', 'error');
    return null;
  } finally {
    busyKeys.delete(key);
    if (el && document.body.contains(el)) {
      el.innerHTML = restore.html;
      el.disabled = restore.disabled;
      el.classList.remove('opacity-60', 'cursor-wait');
    }
  }
}

/* ==========================================================================
 * 5. GAME CONTENT — now data, fetched once per session from the catalogue
 * ======================================================================== */
const Content = {
  operations: [], items: [], item_categories: [], property_types: [], missions: [],
  settings: {},
  setting(key, fallback) {
    const v = this.settings[key];
    return v === undefined || v === null ? fallback : v;
  },
  diceModes() {
    return this.setting('dice_modes', { low: { label: 'Low 1-3', mult: 1.92 }, high: { label: 'High 4-6', mult: 1.92 }, exact: { label: 'Exact face', mult: 5.6 } });
  },
  operation(id) { return this.operations.find((o) => o.id === id) || null; },
  mission(id)   { return this.missions.find((m) => m.id === id) || null; }
};

/* ==========================================================================
 * 6. VOLATILE UI STATE + SERVER-BACKED SESSION STATE
 * ======================================================================== */
const UI = {
  tab: 'ops',
  authTab: 'login',
  logFilter: 'all',
  diceMode: 'low',
  exactFace: 6,
  selectedTarget: null,
  adminQuery: '',
  adminPage: 0,
  logLimit: 60,
  gearCategory: 'all',
  recovery: false
};

/**
 * Shadow exchange view state. Only filters, paging and the last page the
 * server sent — never a local mirror of the market. Every action re-reads.
 */
const Market = {
  query: '', category: 'all', rarity: 'all', sort: 'recent',
  page: 0, pageSize: 24,
  rows: [], total: 0, stats: null, desk: null
};

/** The server's answer to "what is true right now". Never written to by hand. */
const State = {
  profile: null,
  bonuses: { stealth_bonus: 0, payout_bonus: 0 },
  targets: [],
  inventory: [],
  properties: [],
  mission_run: null,
  logs: [],
  missionHistory: [],
  admin: { stats: null, rows: [], total: 0 },
  clockSkewMs: 0        // serverTime - deviceTime, measured on every fetch
};

/** Server "now" as a millisecond timestamp, immune to device clock changes. */
function serverNow() { return Date.now() + State.clockSkewMs; }

function applyState(payload) {
  if (!payload) return;
  if (payload.server_time) State.clockSkewMs = new Date(payload.server_time).getTime() - Date.now();
  if (payload.profile) {
    State.profile = payload.profile;
    if (payload.profile.server_time) {
      State.clockSkewMs = new Date(payload.profile.server_time).getTime() - Date.now();
    }
  }
  if (payload.bonuses)    State.bonuses    = payload.bonuses;
  if (payload.targets)    State.targets    = payload.targets;
  if (payload.inventory)  State.inventory  = payload.inventory;
  if (payload.properties) State.properties = payload.properties;
  if ('mission_run' in payload) State.mission_run = payload.mission_run || null;
}

/** Full refresh — one round trip, small payload, never the whole database. */
async function loadState() {
  applyState(await rpc('get_state'));
}

/* ==========================================================================
 * 7. LOG STYLING
 * ======================================================================== */
const LOG_STYLE = {
  hack:    { i: 'fa-crosshairs',           c: 'text-pulse' },
  fail:    { i: 'fa-triangle-exclamation', c: 'text-rose-500' },
  finance: { i: 'fa-building-columns',     c: 'text-sky-500' },
  bet:     { i: 'fa-dice',                 c: 'text-amberflux' },
  mission: { i: 'fa-file-contract',        c: 'text-sky-500' },
  system:  { i: 'fa-circle-info',          c: 'text-slate-400' },
  admin:   { i: 'fa-user-shield',          c: 'text-amberflux' }
};

/* ==========================================================================
 * 8. DERIVED PLAYER VALUES
 * --------------------------------------------------------------------------
 * A thin view-model maps the database column names onto the property names
 * the original render functions already used, so the UI code below is the
 * same code that shipped in the offline build.
 * ======================================================================== */
function vm() {
  const p = State.profile;
  if (!p) return null;
  return {
    id: p.id,
    username: p.alias,
    email: p.email || '',
    role: p.role,
    isAdmin: p.role === 'admin' || p.role === 'super_admin',
    isStaff: p.role !== 'player',
    cash: num(p.cash),
    vault: num(p.vault),
    bank: num(p.bank),
    energy: projectedEnergy(p),
    maxEnergy: num(p.energy_max),
    stealth: num(p.stealth),
    xp: num(p.xp),
    runs: num(p.runs),
    successes: num(p.successes),
    earned: num(p.earned),
    rolls: num(p.rolls),
    diceNet: num(p.dice_net),
    createdAt: p.created_at,
    lastLogin: p.last_login_at,
    targets: State.targets
  };
}

/**
 * Energy shown between refreshes. The database is still the only place that
 * grants energy — this is a read-only projection of the same formula against
 * the server clock, so the bar ticks smoothly without lying about the total.
 */
function projectedEnergy(p) {
  const max = num(p.energy_max);
  const tick = Math.max(1, num(Content.setting('energy_tick_seconds', 12)));
  const elapsed = (serverNow() - new Date(p.last_energy_at).getTime()) / 1000;
  const gained = Math.floor(Math.max(0, elapsed) / tick);
  return clamp(num(p.energy) + gained, 0, max);
}

function clearanceTier(user) { return clamp(1 + Math.floor(user.xp / 1200), 1, 10); }
function clearanceLabel(user) {
  const t = clearanceTier(user);
  const names = ['Initiate', 'Standard', 'Elevated', 'Shadow', 'Cipher', 'Phantom', 'Wraith', 'Architect', 'Overseer', 'Singularity'];
  return 'Tier ' + t + ' · ' + names[t - 1];
}
function stealthLabel(s) {
  if (s >= 90) return 'Untraceable';
  if (s >= 75) return 'Phantom signal';
  if (s >= 60) return 'Low emission';
  if (s >= 45) return 'Ghost-in-training';
  if (s >= 25) return 'Noisy footprint';
  return 'Flagged by ICE';
}
const ROLE_LABEL = {
  player: 'Field Operative',
  moderator: 'Moderator',
  admin: 'Administrator',
  super_admin: 'Root Administrator'
};

/* ==========================================================================
 * 9. AUTHENTICATION (Supabase Auth — no passwords touch our tables)
 * ======================================================================== */
function showAuthError(form, message) {
  const el = $('[data-auth-error]', form);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

/** Called whenever the server tells us the session is gone. */
let sessionLossHandled = false;
function handleSessionLoss() {
  if (sessionLossHandled) return;
  sessionLossHandled = true;
  State.profile = null;
  showLanding();
  toast(ERROR_COPY.NOT_AUTHENTICATED, 'error');
  setTimeout(() => { sessionLossHandled = false; }, 1500);
}

async function doRegister(fields) {
  const username = String(fields.username || '').trim();
  const email    = String(fields.email || '').trim();
  const password = String(fields.password || '');
  const confirm  = String(fields.confirm || '');

  if (username.length < 3)                 return { ok: false, error: 'Handle must be at least 3 characters.' };
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return { ok: false, error: 'Handle may only contain letters, numbers, _ . and -' };
  if (!EMAIL_RE.test(email))               return { ok: false, error: 'Enter a valid email address.' };
  if (password.length < 6)                 return { ok: false, error: 'Passphrase must be at least 6 characters.' };
  if (password !== confirm)                return { ok: false, error: 'Passphrases do not match.' };

  // Handles are unique in the database; check first so the operator gets a
  // clean message instead of a failed signup.
  const free = await rpc('alias_available', { p_alias: username });
  if (free === false) return { ok: false, error: 'That handle is already registered.' };

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { alias: username }, emailRedirectTo: window.location.origin + window.location.pathname }
  });
  if (error) {
    const msg = /already registered|already been registered/i.test(error.message)
      ? 'That email is already registered.'
      : error.message;
    return { ok: false, error: msg };
  }
  return { ok: true, session: data.session, username };
}

async function doLogin(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: String(email || '').trim(), password });
  if (error) {
    const msg = /Email not confirmed/i.test(error.message)
      ? 'Confirm your email address first — check your inbox for the activation link.'
      : 'Credentials rejected. Access denied.';
    return { ok: false, error: msg };
  }
  return { ok: true, session: data.session };
}

async function doLogout() {
  await sb.auth.signOut();
  State.profile = null;
  UI.selectedTarget = null;
  showLanding();
  toast('Session terminated. Stay dark.', 'info');
}

/* ==========================================================================
 * 10. RENDERING — HEADER + SHELL
 * ======================================================================== */
function renderHeader(user) {
  $('#hdrAlias').textContent = user.username;
  $('#hdrAdminBadge').hidden = !user.isAdmin;
  $('#hdrClearance').textContent = clearanceLabel(user);
  $('#hdrCash').textContent  = money(user.cash);
  $('#hdrVault').textContent = money(user.vault);
  $('#hdrCashMobile').textContent  = money(user.cash);
  $('#hdrVaultMobile').textContent = money(user.vault);
  $('#hdrEnergyText').textContent = Math.floor(user.energy) + '/' + user.maxEnergy;
  $('#hdrEnergyBar').style.width = (user.energy / user.maxEnergy * 100) + '%';
  $('#tabAdminBtn').hidden = !user.isAdmin;
}

function setTab(tab) {
  const user = vm();
  if (tab === 'admin' && (!user || !user.isAdmin)) tab = 'ops';  // hard guard; the server checks again
  UI.tab = tab;
  const TAB_BASE = 'px-3 sm:px-4 py-3 text-[11px] font-bold mono-caps whitespace-nowrap border-b-2 transition ';
  $$('#tabBar button').forEach(function (b) {
    const active = b.dataset.tab === tab;
    b.className = TAB_BASE + (active
      ? 'border-pulse ' + (b.dataset.tab === 'admin' ? 'text-amberflux' : 'text-pulse')
      : 'border-transparent ' + (b.dataset.tab === 'admin' ? 'text-amberflux/70 hover:text-amberflux' : 'text-slate-500 dark:text-slate-400 hover:text-pulse'));
  });
  $$('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== tab; });

  // Tabs that own paginated data fetch it on entry, not on every render.
  if (tab === 'logs')      loadLogs(true);
  if (tab === 'contracts') loadMissionHistory();
  if (tab === 'admin')     loadAdmin();
  if (tab === 'market')    loadMarket({ resetPage: false }).then(renderMarket).catch(function () {});
  // Holdings accrue against the server clock, so re-sync on entry rather than
  // projecting from a snapshot that may be minutes old.
  if (tab === 'assets')    loadState().then(renderAll).catch(function () {});
  renderAll();
}

/* ==========================================================================
 * 11. OPERATIONS TAB
 * ======================================================================== */
function selectedTarget() {
  if (!UI.selectedTarget) return null;
  return State.targets.find((t) => t.id === UI.selectedTarget) || null;
}

/** Preview of the server's formula — the server recomputes it authoritatively. */
function successChance(user, op) {
  const t = selectedTarget();
  const sec = t ? t.security : 5;
  return clamp(Math.round(num(op.base_chance) + ((user.stealth + num(State.bonuses.stealth_bonus)) - 50) * 0.35 - sec * 3.2), 5, 95);
}

function renderTargets(user) {
  const host = $('#targetList');
  if (!State.targets.length) {
    host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-8 text-center">' +
      '<i class="fa-solid fa-radar text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">No nodes mapped. Run a scan to expose live targets.</p></div>';
    return;
  }
  host.innerHTML = State.targets.map(function (t) {
    const active = UI.selectedTarget === t.id;
    const bars = Array.from({ length: 10 }, function (_, i) {
      return '<span class="h-3 w-1 rounded-sm ' + (i < t.security ? (t.security > 7 ? 'bg-rose-500' : t.security > 4 ? 'bg-amberflux' : 'bg-pulse') : 'bg-slate-200 dark:bg-white/10') + '"></span>';
    }).join('');
    return '<button data-target="' + t.id + '" class="w-full text-left rounded-xl border p-3 transition ' +
      (active ? 'border-pulse bg-pulse/[.07]' : 'border-slate-200 dark:border-white/10 hover:border-pulse/50') + '">' +
      '<div class="flex items-center justify-between gap-3">' +
        '<div class="min-w-0"><p class="text-[13px] font-bold text-slate-900 dark:text-white truncate">' + esc(t.name) + '</p>' +
        '<p class="text-[10px] text-slate-400 mono-caps truncate">' + esc(t.code) + ' · ' + esc(t.ip) + '</p></div>' +
        '<span class="shrink-0 text-[10px] font-bold mono-caps ' + (active ? 'text-pulse' : 'text-slate-400') + '">' + (active ? 'Locked' : num(t.payout) + '×') + '</span>' +
      '</div>' +
      '<div class="mt-2 flex items-center gap-2"><span class="text-[9px] mono-caps text-slate-400">ICE</span><div class="flex gap-0.5">' + bars + '</div></div>' +
    '</button>';
  }).join('');
}

function renderOps(user) {
  const t = selectedTarget();
  const payoutBonus = num(State.bonuses.payout_bonus);
  $('#opsGrid').innerHTML = Content.operations.map(function (op) {
    const chance = successChance(user, op);
    const affordable = user.energy >= op.energy_cost;
    const chanceColor = chance >= 65 ? 'text-pulse' : chance >= 40 ? 'text-amberflux' : 'text-rose-500';
    const mult = (t ? num(t.payout) : 1) + payoutBonus;
    const reward = Math.round(num(op.min_payout) * mult) + ' – ' + Math.round(num(op.max_payout) * mult);
    return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-3.5 flex flex-col ' + (affordable ? '' : 'opacity-60') + '">' +
      '<div class="flex items-start gap-3">' +
        '<div class="h-9 w-9 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(op.icon) + '"></i></div>' +
        '<div class="min-w-0 flex-1"><p class="text-[12px] font-bold text-slate-900 dark:text-white leading-tight">' + esc(op.name) + '</p>' +
        '<p class="mt-1 text-[10px] leading-snug text-slate-400">' + esc(op.blurb) + '</p></div>' +
      '</div>' +
      '<div class="mt-3 flex items-center justify-between text-[10px] mono-caps">' +
        '<span class="text-amberflux"><i class="fa-solid fa-bolt mr-1"></i>' + op.energy_cost + '</span>' +
        '<span class="text-slate-400">$' + reward + '</span>' +
        '<span class="' + chanceColor + '">' + chance + '%</span>' +
      '</div>' +
      '<button data-op="' + esc(op.id) + '" ' + (affordable ? '' : 'disabled') +
        ' class="mt-3 w-full py-2 rounded-lg text-[10px] font-bold mono-caps transition ' +
        (affordable ? 'bg-slate-900 dark:bg-white text-white dark:text-obsidian-950 hover:bg-pulse hover:text-obsidian-950 dark:hover:bg-pulse' : 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed') + '">' +
        (affordable ? 'Execute' : 'Low energy') + '</button>' +
    '</div>';
  }).join('');
}

async function runExploit(btn, opId) {
  await withBusy(btn, 'exploit', async function () {
    const res = await rpc('run_exploit', { p_operation_id: opId, p_target_id: UI.selectedTarget });
    applyState(res);
    await loadState();          // targets harden server-side after a burn
    renderAll();
    if (res.success) toast(res.operation + ' succeeded · +' + money(res.amount), 'success');
    else toast(res.operation + ' failed' + (res.amount ? ' · cleanup cost ' + money(Math.abs(res.amount)) : ''), 'error');
  });
}

async function scanTargets(btn) {
  await withBusy(btn, 'scan', async function () {
    State.targets = await rpc('scan_targets');
    UI.selectedTarget = null;
    renderAll();
    toast('Sweep complete · 5 live nodes exposed', 'info');
  });
}

async function rechargeEnergy(btn) {
  await withBusy(btn, 'stim', async function () {
    const res = await rpc('buy_stim');
    applyState(res);
    renderAll();
    toast('Stim injected · +' + Math.round(res.gained) + ' energy', 'warn');
  });
}

/* ==========================================================================
 * 12. DICE MODULE  (the roll itself is generated by the database)
 * ======================================================================== */
const DICE_ICONS = ['fa-dice-one', 'fa-dice-two', 'fa-dice-three', 'fa-dice-four', 'fa-dice-five', 'fa-dice-six'];

function renderDice(user) {
  const modes = Content.diceModes();
  const mode = modes[UI.diceMode] || modes.low;
  $('#diceMultiplier').textContent = Number(mode.mult).toFixed(2) + '×';
  $$('[data-dice-mode]').forEach(function (b) {
    const active = b.dataset.diceMode === UI.diceMode;
    b.className = 'py-2.5 rounded-lg border text-[11px] font-bold mono-caps transition ' +
      (active ? 'border-amberflux bg-amberflux/10 text-amberflux' : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:border-amberflux/50');
  });
  $('#exactPickWrap').hidden = UI.diceMode !== 'exact';
  $('#exactPick').innerHTML = [1, 2, 3, 4, 5, 6].map(function (n) {
    const active = UI.exactFace === n;
    return '<button data-face="' + n + '" class="py-2 rounded-lg border text-[12px] font-bold transition ' +
      (active ? 'border-amberflux bg-amberflux/10 text-amberflux' : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:border-amberflux/50') +
      '">' + n + '</button>';
  }).join('');
  $('#diceRollsStat').textContent = user.rolls;
  const net = $('#diceNetStat');
  net.textContent = money(user.diceNet);
  net.className = 'text-sm font-bold ' + (user.diceNet > 0 ? 'text-pulse' : user.diceNet < 0 ? 'text-rose-500' : 'text-slate-900 dark:text-white');
}

async function rollDice(btn) {
  const bet = Math.floor(Number($('#diceBet').value) || 0);
  if (bet <= 0) { toast('Enter a wager above zero.', 'warn'); return; }

  await withBusy(btn, 'dice', async function () {
    const res = await rpc('roll_dice', {
      p_bet: bet,
      p_mode: UI.diceMode,
      p_face: UI.diceMode === 'exact' ? UI.exactFace : null
    });
    applyState(res);

    const faceEl = $('#diceFace');
    faceEl.innerHTML = '<i class="fa-solid ' + DICE_ICONS[res.face - 1] + '"></i>';
    faceEl.classList.add('stat-flash');
    setTimeout(function () { faceEl.classList.remove('stat-flash'); }, 320);

    if (res.won) {
      $('#diceOutcome').innerHTML = '<span class="text-pulse font-bold">WIN · +' + money(res.delta) + '</span>';
      toast('Roll ' + res.face + ' · won ' + money(res.delta), 'success');
    } else {
      $('#diceOutcome').innerHTML = '<span class="text-rose-500 font-bold">LOSS · -' + money(Math.abs(res.delta)) + '</span>';
      toast('Roll ' + res.face + ' · lost ' + money(Math.abs(res.delta)), 'error');
    }
    renderAll();
  });
}

/* ==========================================================================
 * 13. VAULT + BANK
 * ======================================================================== */
function renderVault(user) {
  $('#vaultCash').textContent  = money(user.cash);
  $('#vaultVault').textContent = money(user.vault);
  $('#vaultBank').textContent  = money(user.bank);
}

async function vaultMove(btn, direction) {
  const field = $('#vaultAmount');
  const amount = Math.floor(Number(field.value) || 0);
  if (amount <= 0) { toast('Enter an amount above zero.', 'warn'); return; }

  await withBusy(btn, 'vault', async function () {
    const res = await rpc('vault_move', { p_amount: amount, p_direction: direction });
    applyState(res);
    field.value = '';
    renderAll();
    toast(direction === 'deposit'
      ? money(amount) + ' secured in the vault'
      : money(amount) + ' released to hot wallet', direction === 'deposit' ? 'success' : 'info');
  });
}

async function bankTransfer(btn, direction) {
  const field = $('#bankAmount');
  const amount = Math.floor(Number(field.value) || 0);
  const ref = String($('#bankRef').value || '').trim();
  if (amount <= 0) { toast('Enter an amount above zero.', 'warn'); return; }

  await withBusy(btn, 'bank', async function () {
    const res = await rpc('bank_transfer', { p_amount: amount, p_direction: direction, p_ref: ref || null });
    applyState(res);
    field.value = '';
    renderAll();
    toast(direction === 'out'
      ? 'Wired ' + money(amount - num(res.fee)) + ' out · fee ' + money(res.fee)
      : 'Pulled ' + money(amount) + ' into hot wallet', 'success');
  });
}

/* ==========================================================================
 * 14. LOG FEED  (paginated — the browser never downloads the whole table)
 * ======================================================================== */
async function loadLogs(reset) {
  if (reset) UI.logLimit = 60;
  try {
    State.logs = await rpc('get_logs', { p_filter: UI.logFilter, p_limit: UI.logLimit, p_offset: 0 });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderLogs();
}

function renderLogs() {
  $$('#logFilters button').forEach(function (b) {
    const active = b.dataset.logFilter === UI.logFilter;
    b.className = 'px-2.5 py-1.5 rounded-md text-[10px] font-bold mono-caps transition ' +
      (active ? 'bg-white dark:bg-obsidian-900 text-pulse shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-pulse');
  });

  const feed = $('#logFeed');
  const rows = State.logs || [];
  $('#btnMoreLogs').hidden = rows.length < UI.logLimit;

  if (!rows.length) {
    feed.innerHTML = '<div class="p-12 text-center"><i class="fa-solid fa-inbox text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">No entries in this channel yet.</p></div>';
    return;
  }
  feed.innerHTML = rows.map(function (l) {
    const s = LOG_STYLE[l.type] || LOG_STYLE.system;
    const amt = l.amount == null ? '' :
      '<span class="shrink-0 font-bold ' + (l.amount >= 0 ? 'text-pulse' : 'text-rose-500') + '">' + (l.amount >= 0 ? '+' : '') + money(l.amount) + '</span>';
    return '<div class="log-row px-5 py-2.5 flex items-center gap-3 transition-colors">' +
      '<i class="fa-solid ' + s.i + ' ' + s.c + ' w-4 text-center shrink-0"></i>' +
      '<span class="shrink-0 text-slate-400 tabular-nums text-[11px] hidden sm:inline">' + stamp(l.created_at) + '</span>' +
      '<span class="flex-1 min-w-0 text-slate-700 dark:text-slate-300 truncate">' + esc(l.message) + '</span>' + amt +
    '</div>';
  }).join('');
}

/* ==========================================================================
 * 15. PROFILE
 * ======================================================================== */
function renderProfile(user) {
  $('#profileAvatar').textContent = user.username.slice(0, 2).toUpperCase();
  $('#profileName').textContent = user.username;
  $('#profileEmail').textContent = user.email;
  $('#profileClearance').textContent = clearanceLabel(user);
  $('#profileRole').innerHTML = user.isStaff
    ? '<span class="text-amberflux">' + esc(ROLE_LABEL[user.role] || user.role) + '</span>'
    : 'Field Operative';
  $('#profileId').textContent = user.id;
  $('#profileCreated').textContent = dateLong(user.createdAt);
  $('#profileLastLogin').textContent = dateLong(user.lastLogin);

  const s = Math.round(user.stealth);
  $('#profileStealthVal').textContent = s;
  $('#profileStealthLabel').textContent = stealthLabel(s);
  $('#profileStealthBar').style.width = s + '%';
  $('#profileStealthBar').className = 'h-full transition-all duration-500 ' +
    (s >= 60 ? 'bg-pulse' : s >= 35 ? 'bg-amberflux' : 'bg-rose-500');

  $('#statRuns').textContent = user.runs;
  $('#statSuccess').textContent = user.successes;
  $('#statRate').textContent = user.runs ? Math.round(user.successes / user.runs * 100) + '%' : '—';
  $('#statEarned').textContent = money(user.earned);
}

async function changePassphrase(btn) {
  const user = vm();
  const cur = $('#pwCurrent').value, next = $('#pwNew').value;
  if (!cur) { toast('Enter your current passphrase.', 'warn'); return; }
  if (next.length < 6) { toast('New passphrase must be at least 6 characters.', 'warn'); return; }

  await withBusy(btn, 'password', async function () {
    // Re-authenticate first so a walked-away-from session cannot rotate the key.
    const check = await sb.auth.signInWithPassword({ email: user.email, password: cur });
    if (check.error) { toast('Current passphrase is incorrect.', 'error'); return; }
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) { toast(error.message, 'error'); return; }
    $('#pwCurrent').value = ''; $('#pwNew').value = '';
    toast('Credentials updated.', 'success');
  });
}

/* ==========================================================================
 * 16. ADMIN DESK — every action is re-authorised inside the database
 * ======================================================================== */
async function loadAdmin() {
  const user = vm();
  if (!user || !user.isAdmin) return;
  try {
    const [stats, list] = await Promise.all([
      rpc('admin_stats'),
      rpc('admin_list_players', { p_query: UI.adminQuery, p_limit: 25, p_offset: UI.adminPage * 25 })
    ]);
    State.admin = { stats, rows: list.rows || [], total: num(list.total) };
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderAdmin(user);
}

function renderAdmin(user) {
  if (!user.isAdmin) return;
  const s = State.admin.stats;
  if (s) {
    $('#admStatUsers').textContent = s.players;
    $('#admStatCash').textContent  = money(s.cash);
    $('#admStatVault').textContent = money(s.reserves);
    $('#admStatRuns').textContent  = s.runs;
  }

  const body = $('#adminTableBody');
  const rows = State.admin.rows;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="px-5 py-12 text-center text-[12px] text-slate-400">No operatives match that filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(function (u) {
    const self = u.id === user.id;
    const staff = u.role !== 'player';
    return '<tr class="hover:bg-slate-50 dark:hover:bg-white/[.03] transition-colors">' +
      '<td class="px-5 py-3"><p class="font-bold text-slate-900 dark:text-white">' + esc(u.alias) + (self ? ' <span class="text-[9px] text-slate-400 mono-caps">(you)</span>' : '') + '</p>' +
        '<p class="text-[11px] text-slate-400">' + esc(u.email || '') + '</p></td>' +
      '<td class="px-3 py-3">' + (staff
        ? '<span class="px-2 py-0.5 rounded-md bg-amberflux/15 text-amberflux text-[9px] font-extrabold mono-caps border border-amberflux/30">' + esc(u.role.replace('_', ' ')) + '</span>'
        : '<span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/5 text-slate-500 text-[9px] font-extrabold mono-caps border border-slate-200 dark:border-white/10">Operative</span>') + '</td>' +
      '<td class="px-3 py-3 text-right font-bold text-pulse tabular-nums">' + money(u.cash) + '</td>' +
      '<td class="px-3 py-3 text-right font-bold text-slate-900 dark:text-white tabular-nums">' + money(u.vault) + '</td>' +
      '<td class="px-3 py-3 text-right text-slate-500 tabular-nums">' + Math.floor(num(u.energy)) + '/' + u.energy_max + '</td>' +
      '<td class="px-5 py-3"><div class="flex justify-end gap-1.5">' +
        '<button data-adm-grant="' + u.id + '" title="Grant bonus funds" class="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 dark:border-white/10 text-pulse hover:bg-pulse/10 transition"><i class="fa-solid fa-sack-dollar text-[11px]"></i></button>' +
        '<button data-adm-refill="' + u.id + '" title="Refill energy" class="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 dark:border-white/10 text-amberflux hover:bg-amberflux/10 transition"><i class="fa-solid fa-bolt text-[11px]"></i></button>' +
        '<button data-adm-role="' + u.id + '" title="Change role" ' + (self ? 'disabled' : '') + ' class="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 dark:border-white/10 ' + (self ? 'text-slate-300 dark:text-slate-700 cursor-not-allowed' : 'text-sky-500 hover:bg-sky-500/10') + ' transition"><i class="fa-solid fa-user-shield text-[11px]"></i></button>' +
        '<button data-adm-purge="' + u.id + '" title="Purge account" ' + (self ? 'disabled' : '') + ' class="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 dark:border-white/10 ' + (self ? 'text-slate-300 dark:text-slate-700 cursor-not-allowed' : 'text-rose-500 hover:bg-rose-500/10') + ' transition"><i class="fa-solid fa-trash text-[11px]"></i></button>' +
      '</div></td></tr>';
  }).join('');
}

function adminRow(id) { return State.admin.rows.find((r) => r.id === id) || null; }

async function adminGrant(btn, targetId) {
  const target = adminRow(targetId);
  if (!target) return;
  const value = await modal({
    title: 'Grant bonus funds',
    body: 'Credit the hot wallet of ' + target.alias + '. Use a negative number to deduct.',
    input: true, inputType: 'number', inputValue: '1000', placeholder: 'Amount',
    okText: 'Credit', icon: 'fa-sack-dollar'
  });
  if (value === false) return;
  const amount = Math.round(Number(value) || 0);
  if (!amount) { toast('No amount entered.', 'warn'); return; }

  await withBusy(btn, 'adm-grant-' + targetId, async function () {
    await rpc('admin_grant', { p_player_id: targetId, p_amount: amount });
    await loadAdmin();
    await refreshSelf();
    toast(money(amount) + ' applied to ' + target.alias, 'success');
  });
}

async function adminRefill(btn, targetId) {
  const target = adminRow(targetId);
  if (!target) return;
  await withBusy(btn, 'adm-refill-' + targetId, async function () {
    await rpc('admin_refill_energy', { p_player_id: targetId });
    await loadAdmin();
    toast('Energy restored for ' + target.alias, 'warn');
  });
}

const ROLE_ORDER = ['player', 'moderator', 'admin', 'super_admin'];

async function adminSetRole(btn, targetId) {
  const target = adminRow(targetId);
  if (!target) return;
  const value = await modal({
    title: 'Change clearance',
    body: 'Set the role for ' + target.alias + '. Valid roles: player, moderator, admin, super_admin. Currently ' + target.role + '.',
    input: true, inputValue: target.role === 'player' ? 'moderator' : 'player',
    placeholder: 'player', okText: 'Apply', icon: 'fa-user-shield'
  });
  if (value === false) return;
  const role = String(value || '').trim().toLowerCase();
  if (!ROLE_ORDER.includes(role)) { toast('Unknown role. Use player, moderator, admin or super_admin.', 'warn'); return; }

  await withBusy(btn, 'adm-role-' + targetId, async function () {
    await rpc('admin_set_role', { p_player_id: targetId, p_role: role });
    await loadAdmin();
    toast(target.alias + ' is now ' + role.replace('_', ' ') + '.', 'info');
  });
}

async function adminPurge(btn, targetId) {
  const target = adminRow(targetId);
  if (!target) return;
  const ok = await modal({
    title: 'Purge operative',
    body: 'Permanently delete ' + target.alias + ' along with all balances, logs and session data. This cannot be undone.',
    okText: 'Purge', danger: true, icon: 'fa-trash'
  });
  if (!ok) return;
  await withBusy(btn, 'adm-purge-' + targetId, async function () {
    await rpc('admin_purge_player', { p_player_id: targetId });
    await loadAdmin();
    toast(target.alias + ' purged from the database.', 'error');
  });
}

/* ==========================================================================
 * 17. CONTRACTS — Phase 4 missions with server-authoritative timers
 * ======================================================================== */
async function loadMissionHistory() {
  try { State.missionHistory = await rpc('get_mission_history', { p_limit: 20 }); }
  catch (err) { toast(err.message, 'error'); return; }
  renderMissionHistory();
}

function renderActiveContract() {
  const host = $('#activeContract');
  const run = State.mission_run;
  if (!run) {
    host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-8 text-center">' +
      '<i class="fa-solid fa-satellite-dish text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">No contract running. Accept one from the board below.</p></div>';
    return;
  }
  const mission = Content.mission(run.mission_id) || {};
  const total = Math.max(1, num(mission.duration_seconds));
  const remaining = (new Date(run.completes_at).getTime() - serverNow()) / 1000;
  const ready = remaining <= 0;
  const pct = clamp((1 - remaining / total) * 100, 0, 100);

  host.innerHTML =
    '<div class="rounded-xl border ' + (ready ? 'border-pulse/50 bg-pulse/[.06]' : 'border-slate-200 dark:border-white/10') + ' p-4">' +
      '<div class="flex items-start gap-3">' +
        '<div class="h-10 w-10 shrink-0 rounded-xl bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(run.icon || mission.icon || 'fa-file-contract') + '"></i></div>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="text-[13px] font-bold text-slate-900 dark:text-white">' + esc(run.mission_name || mission.name || 'Contract') + '</p>' +
          '<p class="text-[11px] text-slate-400 mono-caps">Started ' + stamp(run.started_at) + '</p>' +
        '</div>' +
        '<span class="shrink-0 text-[11px] font-bold mono-caps ' + (ready ? 'text-pulse' : 'text-amberflux') + '" data-countdown>' +
          (ready ? 'Ready to extract' : duration(remaining)) + '</span>' +
      '</div>' +
      '<div class="mt-3 h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">' +
        '<div class="h-full ' + (ready ? 'bg-pulse' : 'bg-amberflux') + ' transition-all duration-1000" data-progress style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="mt-3 grid grid-cols-2 gap-2">' +
        '<button id="btnClaimContract" ' + (ready ? '' : 'disabled') + ' class="py-2.5 rounded-lg text-[11px] font-bold mono-caps transition ' +
          (ready ? 'bg-pulse text-obsidian-950 hover:bg-pulse-soft' : 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed') + '">' +
          '<i class="fa-solid fa-flag-checkered mr-1.5"></i>' + (ready ? 'Extract payout' : 'In progress') + '</button>' +
        '<button id="btnAbortContract" class="py-2.5 rounded-lg border border-slate-200 dark:border-white/10 text-[11px] font-bold mono-caps text-slate-500 hover:text-rose-500 hover:border-rose-500/50 transition">' +
          '<i class="fa-solid fa-ban mr-1.5"></i>Abort</button>' +
      '</div>' +
    '</div>';
}

function renderMissionBoard(user) {
  const busy = !!State.mission_run;
  $('#missionGrid').innerHTML = Content.missions.map(function (m) {
    const locked = user.xp < num(m.required_xp);
    const lowEnergy = user.energy < num(m.energy_cost);
    const disabled = busy || locked || lowEnergy;
    const label = busy ? 'Contract running' : locked ? 'Needs ' + num(m.required_xp).toLocaleString('en-US') + ' XP' : lowEnergy ? 'Low energy' : 'Accept contract';
    return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-4 flex flex-col ' + (disabled ? 'opacity-60' : '') + '">' +
      '<div class="flex items-start gap-3">' +
        '<div class="h-9 w-9 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(m.icon) + '"></i></div>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="text-[12px] font-bold text-slate-900 dark:text-white leading-tight">' + esc(m.name) + '</p>' +
          '<p class="mt-1 text-[10px] leading-snug text-slate-400">' + esc(m.description) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="mt-3 grid grid-cols-2 gap-1.5 text-[10px] mono-caps">' +
        '<span class="text-amberflux"><i class="fa-solid fa-bolt mr-1"></i>' + m.energy_cost + ' energy</span>' +
        '<span class="text-slate-400 text-right"><i class="fa-regular fa-clock mr-1"></i>' + duration(num(m.duration_seconds)) + '</span>' +
        '<span class="text-pulse">' + money(m.min_reward) + ' – ' + money(m.max_reward) + '</span>' +
        '<span class="text-slate-400 text-right">' + m.success_chance + '% · ' + m.xp_reward + ' XP</span>' +
      '</div>' +
      '<button data-mission="' + esc(m.id) + '" ' + (disabled ? 'disabled' : '') +
        ' class="mt-3 w-full py-2 rounded-lg text-[10px] font-bold mono-caps transition ' +
        (disabled ? 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed' : 'bg-slate-900 dark:bg-white text-white dark:text-obsidian-950 hover:bg-pulse hover:text-obsidian-950 dark:hover:bg-pulse') + '">' +
        esc(label) + '</button>' +
    '</div>';
  }).join('');
}

function renderMissionHistory() {
  const host = $('#missionHistory');
  const rows = State.missionHistory || [];
  if (!rows.length) {
    host.innerHTML = '<div class="p-10 text-center"><i class="fa-solid fa-inbox text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">No settled contracts yet.</p></div>';
    return;
  }
  host.innerHTML = rows.map(function (r) {
    const good = r.status === 'completed';
    const tone = good ? 'text-pulse' : r.status === 'aborted' ? 'text-slate-400' : 'text-rose-500';
    return '<div class="px-5 py-3 flex items-center gap-3">' +
      '<i class="fa-solid ' + esc(r.icon || 'fa-file-contract') + ' ' + tone + ' w-4 text-center shrink-0"></i>' +
      '<span class="shrink-0 text-slate-400 tabular-nums text-[11px] hidden sm:inline">' + stamp(r.started_at) + '</span>' +
      '<span class="flex-1 min-w-0 text-slate-700 dark:text-slate-300 truncate">' + esc(r.name) + '</span>' +
      '<span class="shrink-0 text-[10px] font-bold mono-caps ' + tone + '">' + esc(r.status) + '</span>' +
      '<span class="shrink-0 font-bold ' + (num(r.reward) > 0 ? 'text-pulse' : 'text-slate-400') + ' tabular-nums w-20 text-right">' +
        (num(r.reward) > 0 ? '+' + money(r.reward) : '—') + '</span>' +
    '</div>';
  }).join('');
}

async function startMission(btn, missionId) {
  await withBusy(btn, 'mission-start', async function () {
    const res = await rpc('start_mission', { p_mission_id: missionId });
    applyState(res);
    State.mission_run = res.run;
    renderAll();
    toast('Contract accepted · ' + (res.run.mission_name || '') , 'info');
  });
}

async function claimMission(btn) {
  const run = State.mission_run;
  if (!run) return;
  await withBusy(btn, 'mission-claim', async function () {
    const res = await rpc('claim_mission', { p_run_id: run.id });
    applyState(res);
    State.mission_run = null;
    await loadMissionHistory();
    renderAll();
    if (res.success) toast(res.mission + ' complete · +' + money(res.reward), 'success');
    else toast(res.mission + ' failed. The handler burned the trail.', 'error');
  });
}

async function abortMission(btn) {
  const run = State.mission_run;
  if (!run) return;
  const ok = await modal({
    title: 'Abort contract',
    body: 'Walk away from this contract? The energy you spent is not refunded.',
    okText: 'Abort', danger: true, icon: 'fa-ban'
  });
  if (!ok) return;
  await withBusy(btn, 'mission-abort', async function () {
    const res = await rpc('abort_mission', { p_run_id: run.id });
    applyState(res);
    State.mission_run = null;
    await loadMissionHistory();
    renderAll();
    toast('Contract aborted.', 'info');
  });
}

/* ==========================================================================
 * 18. GEAR + PROPERTIES — Phase 3
 * ======================================================================== */
const RARITY_TONE = {
  common:    'text-slate-400 border-slate-200 dark:border-white/10',
  rare:      'text-sky-500 border-sky-500/30',
  elite:     'text-amberflux border-amberflux/30',
  blackline: 'text-rose-500 border-rose-500/30'
};

function renderGearFilters() {
  const cats = [{ id: 'all', name: 'All' }].concat(Content.item_categories);
  $('#gearFilters').innerHTML = cats.map(function (c) {
    const active = UI.gearCategory === c.id;
    return '<button data-gear-cat="' + esc(c.id) + '" class="px-2.5 py-1.5 rounded-md text-[10px] font-bold mono-caps transition ' +
      (active ? 'bg-white dark:bg-obsidian-900 text-pulse shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-pulse') + '">' + esc(c.name) + '</button>';
  }).join('');
}

function renderGear(user) {
  const items = Content.items.filter((i) => UI.gearCategory === 'all' || i.category_id === UI.gearCategory);
  $('#gearGrid').innerHTML = items.map(function (i) {
    const owned = State.inventory.find((inv) => inv.item_id === i.id);
    const affordable = user.cash >= num(i.price);
    const tone = RARITY_TONE[i.rarity] || RARITY_TONE.common;
    const perks = [
      num(i.stealth_bonus) ? '+' + i.stealth_bonus + ' stealth' : null,
      num(i.energy_bonus) ? '+' + i.energy_bonus + ' max energy' : null,
      num(i.payout_bonus) ? '+' + Math.round(num(i.payout_bonus) * 100) + '% payout' : null
    ].filter(Boolean).join(' · ') || 'No passive bonus';
    return '<div class="rounded-xl border ' + tone.split(' ').slice(1).join(' ') + ' p-3.5 flex flex-col">' +
      '<div class="flex items-start gap-3">' +
        '<div class="h-9 w-9 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(i.icon) + '"></i></div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center gap-2"><p class="text-[12px] font-bold text-slate-900 dark:text-white leading-tight truncate">' + esc(i.name) + '</p>' +
          '<span class="shrink-0 text-[9px] font-extrabold mono-caps ' + tone.split(' ')[0] + '">' + esc(i.rarity) + '</span></div>' +
          '<p class="mt-1 text-[10px] leading-snug text-slate-400">' + esc(i.description) + '</p>' +
        '</div>' +
      '</div>' +
      '<p class="mt-3 text-[10px] mono-caps text-pulse">' + esc(perks) + '</p>' +
      '<div class="mt-3 flex items-center justify-between gap-2">' +
        '<span class="text-[12px] font-bold text-slate-900 dark:text-white tabular-nums">' + money(i.price) + '</span>' +
        '<button data-buy-item="' + esc(i.id) + '" ' + (affordable ? '' : 'disabled') +
          ' class="px-3 py-2 rounded-lg text-[10px] font-bold mono-caps transition ' +
          (affordable ? 'bg-slate-900 dark:bg-white text-white dark:text-obsidian-950 hover:bg-pulse hover:text-obsidian-950 dark:hover:bg-pulse' : 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed') + '">' +
          (owned ? 'Buy another' : 'Acquire') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderInventory() {
  const host = $('#inventoryList');
  if (!State.inventory.length) {
    host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-8 text-center">' +
      '<i class="fa-solid fa-box-open text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">Loadout empty. Acquire gear from the rack.</p></div>';
    return;
  }
  host.innerHTML = State.inventory.map(function (i) {
    return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-3 flex items-center gap-3">' +
      '<div class="h-8 w-8 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(i.icon) + '"></i></div>' +
      '<div class="min-w-0 flex-1"><p class="text-[12px] font-bold text-slate-900 dark:text-white truncate">' + esc(i.name) + '</p>' +
      '<p class="text-[10px] text-slate-400 mono-caps">Acquired ' + stamp(i.acquired_at) + '</p></div>' +
      '<span class="shrink-0 text-[11px] font-bold text-pulse mono-caps">×' + i.quantity + '</span>' +
    '</div>';
  }).join('');
}

/** Pending income projected against the server clock, matching the RPC. */
function pendingIncome() {
  return State.properties.reduce(function (sum, p) {
    const rate = (num(p.income_per_hour) - num(p.upkeep_per_hour)) / 3600;
    const secs = Math.max(0, (serverNow() - new Date(p.last_collected_at).getTime()) / 1000);
    return sum + Math.floor(secs * rate);
  }, 0);
}

function renderProperties(user) {
  /* #pendingIncome lives inside the collect button, which is temporarily
   * replaced by a spinner while a request is in flight — so it can legitimately
   * be absent during a render. The 2s display ticker repaints it afterwards. */
  const pending = $('#pendingIncome');
  if (pending) pending.textContent = money(pendingIncome());
  $('#btnCollectIncome').disabled = !State.properties.length;
  $('#btnCollectIncome').classList.toggle('opacity-50', !State.properties.length);

  const holdings = $('#holdingsList');
  if (!State.properties.length) {
    holdings.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-6 text-center">' +
      '<p class="text-[12px] text-slate-400">No holdings yet. Buy a property below to start earning passive income.</p></div>';
  } else {
    holdings.innerHTML = State.properties.map(function (p) {
      const net = num(p.income_per_hour) - num(p.upkeep_per_hour);
      return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-3 flex items-center gap-3">' +
        '<div class="h-8 w-8 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(p.icon) + '"></i></div>' +
        '<div class="min-w-0 flex-1"><p class="text-[12px] font-bold text-slate-900 dark:text-white truncate">' + esc(p.name) + '</p>' +
        '<p class="text-[10px] text-slate-400 mono-caps">Net ' + money(net) + ' / hour · last swept ' + stamp(p.last_collected_at) + '</p></div>' +
        '<span class="shrink-0 text-[11px] font-bold text-pulse tabular-nums">' + money(num(p.pending)) + '</span>' +
      '</div>';
    }).join('');
  }

  $('#propertyGrid').innerHTML = Content.property_types.map(function (t) {
    const owned = State.properties.filter((p) => p.type_id === t.id).length;
    const maxed = owned >= num(t.max_owned);
    const affordable = user.cash >= num(t.price);
    const disabled = maxed || !affordable;
    return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-4 flex flex-col ' + (disabled ? 'opacity-60' : '') + '">' +
      '<div class="flex items-start gap-3">' +
        '<div class="h-9 w-9 shrink-0 rounded-lg bg-amberflux/10 text-amberflux grid place-items-center"><i class="fa-solid ' + esc(t.icon) + '"></i></div>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="text-[12px] font-bold text-slate-900 dark:text-white leading-tight">' + esc(t.name) + '</p>' +
          '<p class="mt-1 text-[10px] leading-snug text-slate-400">' + esc(t.description) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="mt-3 flex items-center justify-between text-[10px] mono-caps">' +
        '<span class="text-pulse">+' + money(num(t.income_per_hour) - num(t.upkeep_per_hour)) + '/hr</span>' +
        '<span class="text-slate-400">Owned ' + owned + '/' + t.max_owned + '</span>' +
      '</div>' +
      '<div class="mt-3 flex items-center justify-between gap-2">' +
        '<span class="text-[12px] font-bold text-slate-900 dark:text-white tabular-nums">' + money(t.price) + '</span>' +
        '<button data-buy-property="' + esc(t.id) + '" ' + (disabled ? 'disabled' : '') +
          ' class="px-3 py-2 rounded-lg text-[10px] font-bold mono-caps transition ' +
          (disabled ? 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed' : 'bg-slate-900 dark:bg-white text-white dark:text-obsidian-950 hover:bg-pulse hover:text-obsidian-950 dark:hover:bg-pulse') + '">' +
          (maxed ? 'Limit reached' : 'Purchase') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function buyItem(btn, itemId) {
  await withBusy(btn, 'buy-item-' + itemId, async function () {
    const res = await rpc('buy_item', { p_item_id: itemId, p_quantity: 1 });
    applyState(res);
    await loadState();
    renderAll();
    toast(res.item + ' acquired · -' + money(res.total), 'success');
  });
}

async function buyProperty(btn, typeId) {
  await withBusy(btn, 'buy-prop-' + typeId, async function () {
    const res = await rpc('buy_property', { p_type_id: typeId });
    applyState(res);
    await loadState();
    renderAll();
    toast(res.property + ' secured.', 'success');
  });
}

async function collectIncome(btn) {
  await withBusy(btn, 'collect', async function () {
    const res = await rpc('collect_property_income');
    applyState(res);
    await loadState();
    renderAll();
    toast('Swept ' + money(res.amount) + ' from ' + res.holdings + ' holding' + (res.holdings === 1 ? '' : 's'), 'success');
  });
}

/* ==========================================================================
 * 18b. SHADOW EXCHANGE — Phase 5 marketplace
 *
 * Nothing here decides a price, a fee or an ownership change. The client
 * renders what market_browse() returned and calls an RPC to act; the database
 * re-validates ownership, funds, price band and escrow on every call. The
 * expected total is echoed back to the server on purchase so a listing that
 * changed underneath the player aborts instead of charging a surprise number.
 * ======================================================================== */

/** Time left before a listing ages out, measured on the server clock. */
function untilExpiry(iso) {
  return Math.max(0, (new Date(iso).getTime() - serverNow()) / 1000);
}

/** Listings live for days, so hours alone would read as "168h". */
function expiryLabel(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return d + 'd' + (h ? ' ' + h + 'h' : '');
  }
  return duration(s);
}

/** Fetch a page of listings plus the ticker and the caller's own desk. */
async function loadMarket(opts) {
  const o = opts || {};
  if (o.resetPage) Market.page = 0;
  const [stats, browse, desk] = await Promise.all([
    rpc('market_stats'),
    rpc('market_browse', {
      p_query:    Market.query,
      p_category: Market.category,
      p_rarity:   Market.rarity,
      p_sort:     Market.sort,
      p_limit:    Market.pageSize,
      p_offset:   Market.page * Market.pageSize
    }),
    rpc('market_my_desk', { p_limit: 20 })
  ]);
  Market.stats = stats;
  Market.rows  = browse.rows || [];
  Market.total = num(browse.total);
  Market.desk  = desk;
  if (browse.server_time) State.clockSkewMs = new Date(browse.server_time).getTime() - Date.now();
}

function renderMarketStats() {
  const s = Market.stats;
  if (!s) return;
  $('#mkStatActive').textContent  = num(s.active).toLocaleString('en-US');
  $('#mkStatVolume').textContent  = money(s.volume_24h);
  $('#mkStatMine').textContent    = num(s.my_active) + ' / ' + num(s.max_listings);
  $('#mkStatHolds').textContent   = money(s.my_holds);
  $('#mkFeeNote').textContent     = 'Exchange cut ' + Math.round(num(s.fee) * 100) + '% · paid by the seller';
}

/** Category filter is populated from the same catalogue the gear rack uses. */
function renderMarketFilters() {
  const sel = $('#mkCategory');
  if (sel.dataset.filled === '1') return;
  sel.innerHTML = '<option value="all">All categories</option>' +
    Content.item_categories.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('');
  sel.dataset.filled = '1';
}

function marketCard(l) {
  const tone   = RARITY_TONE[l.rarity] || RARITY_TONE.common;
  const total  = num(l.total);
  const base   = num(l.base_price) * num(l.quantity);
  const delta  = base ? Math.round(((total - base) / base) * 100) : 0;
  const deltaC = delta > 0 ? 'text-rose-500' : (delta < 0 ? 'text-pulse' : 'text-slate-400');
  const user   = vm();
  const afford = user && user.cash >= total;
  const secs   = untilExpiry(l.expires_at);

  const perks = [
    num(l.stealth_bonus) ? '+' + l.stealth_bonus + ' stealth' : null,
    num(l.energy_bonus)  ? '+' + l.energy_bonus + ' max energy' : null,
    num(l.payout_bonus)  ? '+' + Math.round(num(l.payout_bonus) * 100) + '% payout' : null
  ].filter(Boolean).join(' · ') || 'No passive bonus';

  const actions = l.is_mine
    ? '<button data-mk-cancel="' + esc(l.id) + '" class="px-3 py-2 rounded-lg text-[10px] font-bold mono-caps border border-rose-500/40 text-rose-500 hover:bg-rose-500/10 transition">Withdraw</button>'
    : '<button data-mk-offer="' + esc(l.id) + '" class="px-3 py-2 rounded-lg text-[10px] font-bold mono-caps border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-pulse/50 hover:text-pulse transition">Offer</button>' +
      '<button data-mk-buy="' + esc(l.id) + '" data-mk-total="' + total + '" ' + (afford ? '' : 'disabled') +
        ' class="px-3 py-2 rounded-lg text-[10px] font-bold mono-caps transition ' +
        (afford ? 'bg-slate-900 dark:bg-white text-white dark:text-obsidian-950 hover:bg-pulse hover:text-obsidian-950 dark:hover:bg-pulse'
                : 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed') + '">Buy</button>';

  return '<div class="rounded-xl border ' + tone.split(' ').slice(1).join(' ') + ' p-3.5 flex flex-col">' +
    '<div class="flex items-start gap-3">' +
      '<div class="h-9 w-9 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(l.icon) + '"></i></div>' +
      '<div class="min-w-0 flex-1">' +
        '<div class="flex items-center gap-2"><p class="text-[12px] font-bold text-slate-900 dark:text-white leading-tight truncate">' + esc(l.name) +
          (num(l.quantity) > 1 ? ' <span class="text-pulse">×' + num(l.quantity) + '</span>' : '') + '</p>' +
          '<span class="shrink-0 text-[9px] font-extrabold mono-caps ' + tone.split(' ')[0] + '">' + esc(l.rarity) + '</span></div>' +
        '<p class="mt-0.5 text-[10px] mono-caps text-slate-400">Seller ' +
          (l.is_mine ? '<span class="text-pulse">you</span>' : esc(l.seller)) +
          ' · ' + (secs > 0 ? expiryLabel(secs) + ' left' : 'expiring') + '</p>' +
      '</div>' +
    '</div>' +
    (l.note ? '<p class="mt-2 text-[10px] leading-snug text-slate-400 italic">“' + esc(l.note) + '”</p>' : '') +
    '<p class="mt-2 text-[10px] mono-caps text-pulse">' + esc(perks) + '</p>' +
    '<div class="mt-3 flex items-end justify-between gap-2 flex-wrap">' +
      '<div>' +
        '<p class="text-[13px] font-bold text-slate-900 dark:text-white tabular-nums leading-none">' + money(total) + '</p>' +
        '<p class="mt-1 text-[9px] mono-caps ' + deltaC + '">' +
          (delta === 0 ? 'at rack price' : (delta > 0 ? '+' + delta + '% over rack' : delta + '% under rack')) + '</p>' +
      '</div>' +
      '<div class="flex gap-2">' + actions + '</div>' +
    '</div>' +
    (num(l.offer_count) ? '<p class="mt-2 text-[9px] mono-caps text-amberflux">' + num(l.offer_count) + ' open offer' + (num(l.offer_count) === 1 ? '' : 's') + '</p>' : '') +
  '</div>';
}

function renderMarketGrid() {
  const host = $('#mkGrid');
  if (!Market.rows.length) {
    host.innerHTML = '<div class="sm:col-span-2 rounded-xl border border-dashed border-slate-300 dark:border-white/10 p-10 text-center">' +
      '<i class="fa-solid fa-store-slash text-2xl text-slate-300 dark:text-slate-700"></i>' +
      '<p class="mt-3 text-[12px] text-slate-400">' +
      (Market.query || Market.category !== 'all' || Market.rarity !== 'all'
        ? 'Nothing on the exchange matches that filter.'
        : 'The exchange is quiet. Be the first to post a listing.') + '</p></div>';
  } else {
    host.innerHTML = Market.rows.map(marketCard).join('');
  }

  const from = Market.total ? Market.page * Market.pageSize + 1 : 0;
  const to   = Math.min(Market.total, (Market.page + 1) * Market.pageSize);
  $('#mkPageInfo').textContent = Market.total
    ? 'Showing ' + from + '–' + to + ' of ' + Market.total.toLocaleString('en-US')
    : 'No listings';
  $('#mkPrev').disabled = Market.page === 0;
  $('#mkNext').disabled = to >= Market.total;
}

/** The "post a listing" form is driven by what the player actually holds. */
function renderMarketForm() {
  const sel  = $('#mkListItem');
  const prev = sel.value;
  if (!State.inventory.length) {
    sel.innerHTML = '<option value="">Nothing in your rack to sell</option>';
    sel.disabled = true;
    $('#mkBtnList').disabled = true;
    $('#mkBtnList').classList.add('opacity-50', 'cursor-not-allowed');
    $('#mkPriceHint').textContent = 'Acquire gear from the black rack before listing.';
    return;
  }
  sel.disabled = false;
  $('#mkBtnList').disabled = false;
  $('#mkBtnList').classList.remove('opacity-50', 'cursor-not-allowed');
  sel.innerHTML = State.inventory.map(function (i) {
    return '<option value="' + esc(i.item_id) + '">' + esc(i.name) + ' (×' + i.quantity + ')</option>';
  }).join('');
  if (prev && State.inventory.some((i) => i.item_id === prev)) sel.value = prev;
  renderPriceHint();
}

/** Shows the server's price band so a rejection is never a surprise. */
function renderPriceHint() {
  const id = $('#mkListItem').value;
  const item = Content.items.find((i) => i.id === id);
  const s = Market.stats;
  if (!item || !s) { $('#mkPriceHint').textContent = ''; return; }
  const lo = Math.max(1, Math.floor(num(item.price) * 0.25));
  const hi = Math.max(lo, Math.floor(num(item.price) * 4));
  $('#mkPriceHint').textContent =
    'Allowed ' + money(lo) + ' – ' + money(hi) + ' each · rack price ' + money(item.price);
}

function renderMarketDesk() {
  const d = Market.desk || { listings: [], my_offers: [], incoming: [], purchases: [] };

  // --- offers waiting on my answer ---
  const inc = $('#mkIncoming');
  inc.innerHTML = (d.incoming || []).length
    ? d.incoming.map(function (o) {
        return '<div class="rounded-xl border border-amberflux/30 p-3">' +
          '<div class="flex items-center gap-2">' +
            '<i class="fa-solid ' + esc(o.icon) + ' text-amberflux"></i>' +
            '<p class="text-[12px] font-bold text-slate-900 dark:text-white truncate flex-1">' + esc(o.item) + '</p>' +
          '</div>' +
          '<p class="mt-1 text-[10px] mono-caps text-slate-400">' + esc(o.buyer) + ' offers <b class="text-pulse">' + money(o.offer_total) + '</b> · asking ' + money(o.ask) + '</p>' +
          (o.message ? '<p class="mt-1 text-[10px] text-slate-400 italic">“' + esc(o.message) + '”</p>' : '') +
          '<div class="mt-2 flex gap-2">' +
            '<button data-mk-accept="' + esc(o.id) + '" class="flex-1 px-2 py-1.5 rounded-lg bg-pulse text-obsidian-950 text-[10px] font-bold mono-caps hover:bg-pulse-soft transition">Accept</button>' +
            '<button data-mk-decline="' + esc(o.id) + '" class="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 text-[10px] font-bold mono-caps hover:text-rose-500 hover:border-rose-500/40 transition">Decline</button>' +
          '</div></div>';
      }).join('')
    : '<p class="text-[11px] text-slate-400">No open offers on your listings.</p>';

  // --- my listings ---
  const mine = $('#mkMine');
  mine.innerHTML = (d.listings || []).length
    ? d.listings.map(function (l) {
        const active = l.status === 'active';
        const badge = {
          active:    'text-pulse',      sold: 'text-slate-400',
          cancelled: 'text-slate-400',  expired: 'text-slate-400',
          delisted:  'text-rose-500'
        }[l.status] || 'text-slate-400';
        return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-3 flex items-center gap-3">' +
          '<div class="h-8 w-8 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(l.icon) + '"></i></div>' +
          '<div class="min-w-0 flex-1">' +
            '<p class="text-[12px] font-bold text-slate-900 dark:text-white truncate">' + esc(l.name) + (num(l.quantity) > 1 ? ' ×' + num(l.quantity) : '') + '</p>' +
            '<p class="text-[10px] mono-caps ' + badge + '">' + esc(l.status) +
              (l.status === 'sold' ? ' · ' + money(l.sale_total) + ' · fee ' + money(l.fee_paid) : ' · ' + money(l.total)) + '</p>' +
          '</div>' +
          (active
            ? '<button data-mk-cancel="' + esc(l.id) + '" class="shrink-0 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-[10px] font-bold mono-caps text-slate-500 hover:text-rose-500 hover:border-rose-500/40 transition">Withdraw</button>'
            : '<span class="shrink-0 text-[10px] mono-caps text-slate-400">' + stamp(l.resolved_at || l.created_at) + '</span>') +
        '</div>';
      }).join('')
    : '<p class="text-[11px] text-slate-400">You have not posted anything yet.</p>';

  // --- my offers ---
  const my = $('#mkMyOffers');
  my.innerHTML = (d.my_offers || []).length
    ? d.my_offers.map(function (o) {
        const pending = o.status === 'pending';
        const tone = { pending: 'text-amberflux', accepted: 'text-pulse', declined: 'text-rose-500' }[o.status] || 'text-slate-400';
        return '<div class="rounded-xl border border-slate-200 dark:border-white/10 p-3 flex items-center gap-3">' +
          '<div class="h-8 w-8 shrink-0 rounded-lg bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(o.icon) + '"></i></div>' +
          '<div class="min-w-0 flex-1">' +
            '<p class="text-[12px] font-bold text-slate-900 dark:text-white truncate">' + esc(o.item) + '</p>' +
            '<p class="text-[10px] mono-caps ' + tone + '">' + money(o.offer_total) + ' · ' + esc(o.status) + ' · ' + esc(o.seller) + '</p>' +
          '</div>' +
          (pending
            ? '<button data-mk-withdraw="' + esc(o.id) + '" class="shrink-0 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-[10px] font-bold mono-caps text-slate-500 hover:text-rose-500 hover:border-rose-500/40 transition">Pull</button>'
            : '<span class="shrink-0 text-[10px] mono-caps text-slate-400">' + stamp(o.created_at) + '</span>') +
        '</div>';
      }).join('')
    : '<p class="text-[11px] text-slate-400">No offers placed.</p>';
}

function renderMarket() {
  renderMarketFilters();
  renderMarketStats();
  renderMarketGrid();
  renderMarketForm();
  renderMarketDesk();
}

/** Every mutating path refreshes profile + exchange together, then repaints. */
async function marketRefresh() {
  await Promise.all([loadState(), loadMarket()]);
  renderAll();
}

async function marketBuy(btn, id, expected) {
  await withBusy(btn, 'mk-buy-' + id, async function () {
    const res = await rpc('market_buy_listing', { p_listing_id: id, p_expected_total: expected });
    applyState({ profile: res.profile });
    await marketRefresh();
    toast('Acquired ' + res.item + (num(res.quantity) > 1 ? ' ×' + res.quantity : '') + ' for ' + money(res.total) + '.', 'success');
  });
}

async function marketOffer(btn, id) {
  const listing = Market.rows.find((r) => r.id === id);
  if (!listing) return;
  const ask = num(listing.total);
  const floor = Math.max(1, Math.floor(ask * 0.4));
  const raw = await modal({
    title: 'Make an offer',
    body: 'Asking ' + money(ask) + ' for ' + listing.name + '. Offers between ' + money(floor) + ' and ' +
          money(ask) + ' are accepted. Your credits are held in escrow until the seller answers.',
    okText: 'Send offer', icon: 'fa-hand-holding-dollar',
    input: true, inputType: 'number', placeholder: String(Math.floor(ask * 0.8))
  });
  if (raw === false) return;
  const amount = Math.floor(Number(raw));
  if (!amount || amount < 1) { toast('Enter an amount above zero.', 'warn'); return; }

  await withBusy(btn, 'mk-offer-' + id, async function () {
    const res = await rpc('market_make_offer', { p_listing_id: id, p_offer_total: amount, p_message: null });
    applyState({ profile: res.profile });
    await marketRefresh();
    toast('Offer sent. ' + money(amount) + ' held in escrow.', 'success');
  });
}

async function marketCancel(btn, id) {
  const ok = await modal({
    title: 'Withdraw listing',
    body: 'Pull this listing off the exchange? The goods return to your rack and any open offers are released.',
    okText: 'Withdraw', danger: true, icon: 'fa-arrow-rotate-left'
  });
  if (!ok) return;
  await withBusy(btn, 'mk-cancel-' + id, async function () {
    await rpc('market_cancel_listing', { p_listing_id: id });
    await marketRefresh();
    toast('Listing withdrawn. Goods returned to your rack.', 'info');
  });
}

async function marketRespond(btn, id, accept) {
  await withBusy(btn, 'mk-respond-' + id, async function () {
    const res = await rpc('market_respond_offer', { p_offer_id: id, p_accept: accept });
    await marketRefresh();
    toast(res.accepted
      ? 'Offer accepted · ' + money(res.net) + ' cleared after a ' + money(res.fee) + ' fee.'
      : 'Offer declined. The bidder has been refunded.', res.accepted ? 'success' : 'info');
  });
}

async function marketWithdrawOffer(btn, id) {
  await withBusy(btn, 'mk-withdraw-' + id, async function () {
    await rpc('market_withdraw_offer', { p_offer_id: id });
    await marketRefresh();
    toast('Offer pulled. Held credits returned.', 'info');
  });
}

async function marketPost(btn) {
  const itemId = $('#mkListItem').value;
  const qty    = Math.floor(Number($('#mkListQty').value));
  const price  = Math.floor(Number($('#mkListPrice').value));
  const note   = $('#mkListNote').value.trim();

  if (!itemId) { toast('Nothing selected to sell.', 'warn'); return; }
  if (!qty || qty < 1) { toast('Enter a quantity of at least one.', 'warn'); return; }
  if (!price || price < 1) { toast('Enter a price above zero.', 'warn'); return; }

  await withBusy(btn, 'mk-post', async function () {
    await rpc('market_list_item', {
      p_item_id: itemId, p_quantity: qty, p_unit_price: price, p_note: note || null
    });
    $('#mkListQty').value = '1';
    $('#mkListPrice').value = '';
    $('#mkListNote').value = '';
    Market.page = 0;
    await marketRefresh();
    toast('Listing posted. Goods held in escrow until it clears.', 'success');
  });
}

/* ==========================================================================
 * 18c. ABOUT / SYSTEM DIAGNOSTICS
 *
 * A console overlay that states who built this and then proves the client is
 * wired to a live, server-authoritative backend. Every figure it prints is
 * measured at the moment you open it — nothing is hard-coded except the
 * credits and the licence notice.
 * ======================================================================== */

const CREDITS = {
  title:    'CyberPluse.net (shadow net)',
  creator:  'Joseph Tamunoiyana Francis',
  alias:    'Hacker_001',
  year:     '2026',
  discord:  'https://discord.gg/dzwS6bewJY',
  email:    'Tamunoiyana2006@gmail.com',
  notice:   '\u00A9 2026 Joseph Tamunoiyana Francis (Hacker_001). All rights reserved. ' +
            'Unauthorized cloning, data-scraping, or replication of this network matrix is strictly prohibited.',
  build:    'v2.1 · online build · phases 1–5'
};

const Diag = { lines: [], running: false, token: 0 };

/** Is localStorage actually writable? Private modes and sandboxes say no. */
function storageAvailable() {
  try {
    const k = '__cp_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch (e) { return false; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return 'unset'; }
}

/** Never print the key. A length and a shape are enough to diagnose config. */
function keyFingerprint(key) {
  if (typeof key !== 'string' || !key.length) return 'absent';
  return key.length + ' chars · public anon token';
}

/**
 * Round-trip an authenticated RPC (or the public stats endpoint when signed
 * out) to measure real latency and read the server's own clock.
 */
async function probeBackend() {
  const started = performance.now();
  try {
    const payload = State.profile ? await rpc('market_stats') : await rpc('public_stats');
    const ms = Math.round(performance.now() - started);
    const skew = payload && payload.server_time
      ? new Date(payload.server_time).getTime() - Date.now()
      : null;
    return { ok: true, ms, skew, serverTime: payload ? payload.server_time : null };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: err.message };
  }
}

/** Build the report as structured lines so it can be typed and copied. */
async function buildDiagnostics() {
  const user  = vm();
  const probe = CONFIGURED ? await probeBackend() : { ok: false, error: 'No backend configured' };
  const skew  = probe.skew == null ? null : Math.abs(probe.skew);

  const L = [];
  L.push({ k: 'head', t: 'CyberPulse :: about & system diagnostics' });
  L.push({ k: 'cmd',  t: 'cat /etc/shadownet/identity' });
  L.push({ k: 'kv', label: 'Network matrix',   value: CREDITS.title });
  L.push({ k: 'kv', label: 'Lead developer',   value: CREDITS.creator });
  L.push({ k: 'kv', label: 'Operator alias',   value: CREDITS.alias, tone: 'accent' });
  L.push({ k: 'kv', label: 'Operational year', value: CREDITS.year });
  L.push({ k: 'kv', label: 'Build',            value: CREDITS.build });

  L.push({ k: 'cmd', t: 'uplink --list' });
  L.push({ k: 'link', label: 'Discord uplink', value: CREDITS.discord, href: CREDITS.discord, external: true });
  L.push({ k: 'link', label: 'Secure comms',   value: CREDITS.email,   href: 'mailto:' + CREDITS.email });

  L.push({ k: 'cmd', t: 'diagnostics --run --verbose' });
  L.push({ k: 'kv', label: 'Backend endpoint', value: hostOf(CONFIG.SUPABASE_URL), tone: CONFIGURED ? 'ok' : 'bad' });
  L.push({ k: 'kv', label: 'Public key',       value: keyFingerprint(CONFIG.SUPABASE_ANON_KEY) });
  L.push({ k: 'kv', label: 'Handshake',        value: probe.ok ? probe.ms + ' ms · response verified' : 'FAILED · ' + esc(probe.error || 'unreachable'), tone: probe.ok ? 'ok' : 'bad' });
  L.push({ k: 'kv', label: 'Server clock',     value: probe.serverTime ? new Date(probe.serverTime).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'unavailable' });
  L.push({ k: 'kv', label: 'Clock drift',      value: skew == null ? 'not measured' : skew + ' ms · timers follow the server', tone: skew == null ? '' : 'ok' });
  L.push({ k: 'kv', label: 'Session',          value: user ? 'authenticated · ' + user.username : 'anonymous · landing node', tone: user ? 'ok' : '' });
  L.push({ k: 'kv', label: 'Clearance',        value: user ? clearanceLabel(user) : '—' });
  L.push({ k: 'kv', label: 'Role',             value: user ? String(user.role).replace('_', ' ') : '—', tone: user && user.isAdmin ? 'accent' : '' });
  L.push({ k: 'kv', label: 'State authority',  value: 'server · postgres row level security', tone: 'ok' });
  L.push({ k: 'kv', label: 'Local storage',    value: storageAvailable() ? 'available · theme + session token only' : 'blocked · running in memory', tone: storageAvailable() ? 'ok' : 'warn' });
  L.push({ k: 'kv', label: 'Viewport',         value: window.innerWidth + '×' + window.innerHeight + ' · ' + (Theme.current === 'dark' ? 'dark' : 'light') + ' theme' });
  L.push({ k: 'kv', label: 'Locale',           value: (navigator.language || 'en') + ' · ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown') });

  L.push({ k: 'cmd', t: 'cat NOTICE' });
  L.push({ k: 'notice', t: CREDITS.notice });
  L.push({ k: 'warn', t: 'Fictional simulation. No real currency, systems or wagers are involved. ' +
                         'Credits, gear and contracts exist only inside this matrix.' });
  L.push({ k: 'done', t: 'diagnostics complete — ' + (probe.ok ? 'all systems nominal' : 'backend unreachable') });
  return L;
}

const DIAG_TONE = { ok: 'text-pulse', bad: 'text-rose-400', warn: 'text-amberflux', accent: 'text-amberflux' };

function diagLineHtml(l) {
  switch (l.k) {
    case 'head':
      return '<p class="text-pulse font-bold">' + esc(l.t) + '</p>' +
             '<p class="text-slate-600">' + '─'.repeat(46) + '</p>';
    case 'cmd':
      return '<p class="mt-4 text-slate-500"><span class="text-pulse">shadownet@root</span>:<span class="text-sky-400">~</span>$ ' + esc(l.t) + '</p>';
    case 'kv':
      return '<p class="flex flex-col sm:flex-row sm:gap-3"><span class="sm:w-[132px] sm:shrink-0 text-slate-500">' + esc(l.label) + '</span>' +
             '<span class="' + (DIAG_TONE[l.tone] || 'text-slate-200') + ' break-all">' + esc(l.value) + '</span></p>';
    case 'link':
      return '<p class="flex flex-col sm:flex-row sm:gap-3"><span class="sm:w-[132px] sm:shrink-0 text-slate-500">' + esc(l.label) + '</span>' +
             '<a href="' + esc(l.href) + '"' + (l.external ? ' target="_blank" rel="noopener noreferrer"' : '') +
             ' class="text-sky-400 underline decoration-dotted underline-offset-2 hover:text-pulse transition break-all">' +
             esc(l.value) + (l.external ? ' <i class="fa-solid fa-arrow-up-right-from-square text-[9px]"></i>' : '') + '</a></p>';
    case 'notice':
      return '<p class="mt-1 rounded-lg border border-amberflux/30 bg-amberflux/5 px-3 py-2 text-amberflux leading-relaxed">' + esc(l.t) + '</p>';
    case 'warn':
      return '<p class="mt-2 text-slate-500 leading-relaxed">' + esc(l.t) + '</p>';
    case 'done':
      return '<p class="mt-4 text-pulse">' + '─'.repeat(46) + '</p>' +
             '<p class="text-pulse font-bold">' + esc(l.t) + '<span class="ml-1 animate-pulse">▍</span></p>';
    default:
      return '';
  }
}

/** Plain-text version for the clipboard, so a bug report can be pasted. */
function diagPlainText(lines) {
  return lines.map(function (l) {
    if (l.k === 'kv' || l.k === 'link') return l.label.padEnd(18) + ' ' + l.value;
    if (l.k === 'cmd') return '\n$ ' + l.t;
    return l.t || '';
  }).join('\n').trim();
}

async function runDiagnostics() {
  const host = $('#diagStream');
  const token = ++Diag.token;
  Diag.running = true;
  host.innerHTML = '<p class="text-slate-500">initialising probe…</p>';

  const lines = await buildDiagnostics();
  if (token !== Diag.token) return;          // a newer run superseded this one
  Diag.lines = lines;
  host.innerHTML = '';

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    host.innerHTML = lines.map(diagLineHtml).join('');
    Diag.running = false;
    return;
  }

  // Typed reveal, one line at a time. Cheap, and it reads like a console.
  for (let i = 0; i < lines.length; i++) {
    if (token !== Diag.token) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = diagLineHtml(lines[i]);
    wrap.style.opacity = '0';
    wrap.style.transition = 'opacity .18s ease';
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.style.opacity = '1'; });
    host.scrollTop = host.scrollHeight;
    await new Promise(function (r) { setTimeout(r, lines[i].k === 'cmd' ? 90 : 42); });
  }
  Diag.running = false;
}

function openDiagnostics() {
  $('#diagHost').hidden = false;
  document.body.style.overflow = 'hidden';
  runDiagnostics();
}

function closeDiagnostics() {
  Diag.token++;                               // stop any in-flight typing
  $('#diagHost').hidden = true;
  document.body.style.overflow = '';
}

async function copyDiagnostics(btn) {
  const text = diagPlainText(Diag.lines.length ? Diag.lines : await buildDiagnostics());
  try {
    await navigator.clipboard.writeText(text);
    toast('Diagnostics report copied.', 'success');
  } catch (e) {
    // Clipboard is blocked in sandboxed frames; fall back to a selectable modal.
    await modal({
      title: 'Diagnostics report', body: text, alert: true,
      okText: 'Close', icon: 'fa-clipboard'
    });
  }
}

/* ==========================================================================
 * 19. MASTER RENDER
 * ======================================================================== */
function renderAll() {
  const user = vm();
  if (!user) return;
  renderHeader(user);
  if (UI.tab === 'ops')       { renderTargets(user); renderOps(user); renderDice(user); }
  if (UI.tab === 'contracts') { renderActiveContract(); renderMissionBoard(user); renderMissionHistory(); }
  if (UI.tab === 'assets')    { renderGearFilters(); renderGear(user); renderInventory(); renderProperties(user); }
  if (UI.tab === 'market')    { renderMarket(); }
  if (UI.tab === 'vault')     { renderVault(user); }
  if (UI.tab === 'logs')      { renderLogs(); }
  if (UI.tab === 'profile')   { renderProfile(user); }
  if (UI.tab === 'admin' && user.isAdmin) { renderAdmin(user); }
}

/** Cheap background refresh of the profile only. */
async function refreshSelf() {
  try { await loadState(); renderAll(); } catch (e) { /* handled inside rpc */ }
}

async function showApp(greeting) {
  try {
    if (!Content.operations.length) {
      const cat = await rpc('get_catalog');
      Object.assign(Content, cat);
      renderLandingExploits();
    }
    await loadState();
    if (!State.targets.length) State.targets = await rpc('scan_targets');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  $('#viewLanding').hidden = true;
  $('#viewApp').hidden = false;
  window.scrollTo(0, 0);
  const user = vm();
  setTab(user.isAdmin && UI.tab === 'admin' ? 'admin' : (UI.tab === 'admin' ? 'ops' : UI.tab));
  if (greeting) toast(greeting, 'success');
}

function showLanding() {
  $('#viewApp').hidden = true;
  $('#viewLanding').hidden = false;
  renderRootStatus();
  window.scrollTo(0, 0);
}

/** Landing-page status line — aggregate counts only, no operative details. */
async function renderRootStatus() {
  const line = $('#rootStatusLine');
  if (!line) return;
  if (!CONFIGURED) {
    line.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-rose-500 mr-1"></i>Server configuration missing — set SUPABASE_URL and SUPABASE_ANON_KEY.';
    return;
  }
  try {
    const s = await rpc('public_stats');
    const n = num(s.players);
    line.innerHTML = '<i class="fa-solid fa-lock text-slate-400 mr-1"></i>' + n + ' operative' + (n === 1 ? '' : 's') +
      ' registered · ' + num(s.runs).toLocaleString('en-US') + ' runs executed · ' +
      num(s.contracts).toLocaleString('en-US') + ' contracts settled.';
  } catch (e) {
    line.innerHTML = '<i class="fa-solid fa-circle-dot text-pulse mr-1"></i>Shadow net online.';
  }
}

/* ==========================================================================
 * 20. AUTH UI WIRING
 * ======================================================================== */
function setAuthTab(tab) {
  UI.authTab = tab;
  $$('[data-auth-tab]').forEach(function (b) {
    const active = b.dataset.authTab === tab;
    b.className = 'flex-1 py-2 rounded-lg text-[11px] font-bold mono-caps transition ' +
      (active ? 'bg-white dark:bg-obsidian-900 text-pulse shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-pulse');
  });
  $$('[data-auth-panel]').forEach(function (p) {
    p.hidden = p.dataset.authPanel !== tab;
    showAuthError(p, '');
  });
}

function renderLandingExploits() {
  const grid = $('#landingExploitGrid');
  if (!grid || !Content.operations.length) return;
  grid.innerHTML = Content.operations.map(function (op) {
    return '<article class="rounded-2xl border border-slate-200 dark:border-white/10 p-5 hover:border-pulse/50 transition">' +
      '<div class="h-10 w-10 rounded-xl bg-pulse/10 text-pulse grid place-items-center"><i class="fa-solid ' + esc(op.icon) + '"></i></div>' +
      '<h3 class="mt-4 text-[13px] font-bold text-slate-900 dark:text-white">' + esc(op.name) + '</h3>' +
      '<p class="mt-2 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">' + esc(op.blurb) + '</p>' +
      '<div class="mt-4 flex items-center gap-3 text-[10px] font-bold mono-caps">' +
        '<span class="text-amberflux"><i class="fa-solid fa-bolt mr-1"></i>' + op.energy_cost + ' energy</span>' +
        '<span class="text-slate-400">Base ' + op.base_chance + '%</span>' +
      '</div></article>';
  }).join('');
}

/** Opened from a recovery email link: let the operative set a new passphrase. */
async function promptPasswordReset() {
  const value = await modal({
    title: 'Set a new passphrase',
    body: 'Your recovery link is valid. Choose a new passphrase of at least 6 characters.',
    input: true, inputType: 'password', placeholder: 'New passphrase',
    okText: 'Update', cancelText: 'Later', icon: 'fa-key'
  });
  if (value === false) return;
  if (String(value).length < 6) { toast('Passphrase must be at least 6 characters.', 'warn'); return promptPasswordReset(); }
  const { error } = await sb.auth.updateUser({ password: String(value) });
  if (error) { toast(error.message, 'error'); return; }
  toast('Passphrase updated. You are signed in.', 'success');
}

/* ==========================================================================
 * 21. EVENT BINDING
 * ======================================================================== */
function bindEvents() {
  $$('[data-auth-tab]').forEach(function (b) {
    b.addEventListener('click', function () { setAuthTab(b.dataset.authTab); });
  });

  $$('[data-reveal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = '<i class="fa-solid ' + (show ? 'fa-eye-slash' : 'fa-eye') + ' text-xs"></i>';
    });
  });

  // ---- login ------------------------------------------------------------
  $('#formLogin').addEventListener('submit', function (e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    withBusy(btn, 'login', async function () {
      const email = f.identifier.value.trim();
      if (!EMAIL_RE.test(email)) { showAuthError(f, 'Enter the email address tied to your handle.'); return; }
      const res = await doLogin(email, f.password.value);
      if (!res.ok) { showAuthError(f, res.error); return; }
      showAuthError(f, '');
      f.reset();
      await rpc('touch_login').catch(() => {});
      await showApp();
      const user = vm();
      toast('Welcome back, ' + (user ? user.username : 'operative') + '.', 'success');
    });
  });

  // ---- register ---------------------------------------------------------
  $('#formRegister').addEventListener('submit', function (e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    withBusy(btn, 'register', async function () {
      const res = await doRegister({
        username: f.username.value, email: f.email.value,
        password: f.password.value, confirm: f.confirm.value
      });
      if (!res.ok) { showAuthError(f, res.error); return; }
      showAuthError(f, '');
      f.reset();
      if (!res.session) {
        // The project requires email confirmation before the first session.
        await alertBox('Confirm your email',
          'Operative ' + res.username + ' has been provisioned. Open the activation link we just sent to your inbox, then return here and authenticate.',
          'fa-envelope-circle-check');
        setAuthTab('login');
        return;
      }
      await showApp('Operative ' + res.username + ' provisioned.');
    });
  });

  // ---- recovery ---------------------------------------------------------
  $('#formRecover').addEventListener('submit', function (e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    withBusy(btn, 'recover', async function () {
      const email = f.email.value.trim();
      if (!EMAIL_RE.test(email)) { showAuthError(f, 'Enter a valid email address.'); return; }
      showAuthError(f, '');
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (error) { showAuthError(f, error.message); return; }
      // Deliberately identical whether or not the address exists.
      $('#recoveryHint').textContent =
        'If ' + email + ' is registered, a signed recovery link is on its way. Open it on this device to set a new passphrase.';
      $('#recoveryResult').hidden = false;
      toast('Recovery link dispatched.', 'info');
    });
  });

  // ---- shell ------------------------------------------------------------
  $('#btnLogout').addEventListener('click', function (e) { withBusy(e.currentTarget, 'logout', doLogout); });
  $$('#tabBar button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.dataset.tab); });
  });

  // ---- operations -------------------------------------------------------
  $('#btnScan').addEventListener('click', function (e) { scanTargets(e.currentTarget); });
  $('#targetList').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-target]');
    if (!btn) return;
    UI.selectedTarget = UI.selectedTarget === btn.dataset.target ? null : btn.dataset.target;
    renderAll();
  });
  $('#opsGrid').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-op]');
    if (btn && !btn.disabled) runExploit(btn, btn.dataset.op);
  });
  $('#btnRecharge').addEventListener('click', function (e) { rechargeEnergy(e.currentTarget); });

  // ---- dice --------------------------------------------------------------
  $$('[data-dice-mode]').forEach(function (b) {
    b.addEventListener('click', function () { UI.diceMode = b.dataset.diceMode; renderAll(); });
  });
  $('#exactPick').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-face]');
    if (!btn) return;
    UI.exactFace = Number(btn.dataset.face);
    renderAll();
  });
  $$('[data-bet-mod]').forEach(function (b) {
    b.addEventListener('click', function () {
      const user = vm();
      if (!user) return;
      const field = $('#diceBet');
      const cur = Math.floor(Number(field.value) || 0);
      const mod = b.dataset.betMod;
      const next = mod === 'half' ? Math.floor(cur / 2) : mod === 'double' ? cur * 2 : Math.floor(user.cash);
      field.value = clamp(next, 0, Math.floor(user.cash));
    });
  });
  $('#btnRoll').addEventListener('click', function (e) { rollDice(e.currentTarget); });

  // ---- vault + bank -------------------------------------------------------
  $('#btnVaultDeposit').addEventListener('click', function (e) { vaultMove(e.currentTarget, 'deposit'); });
  $('#btnVaultWithdraw').addEventListener('click', function (e) { vaultMove(e.currentTarget, 'withdraw'); });
  $$('[data-vault-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      const user = vm();
      if (!user) return;
      $('#vaultAmount').value = Math.floor(user.cash * (Number(b.dataset.vaultQuick) / 100));
    });
  });
  $('#btnBankOut').addEventListener('click', function (e) { bankTransfer(e.currentTarget, 'out'); });
  $('#btnBankIn').addEventListener('click', function (e) { bankTransfer(e.currentTarget, 'in'); });

  // ---- contracts ----------------------------------------------------------
  $('#missionGrid').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-mission]');
    if (btn && !btn.disabled) startMission(btn, btn.dataset.mission);
  });
  $('#activeContract').addEventListener('click', function (e) {
    const claim = e.target.closest('#btnClaimContract');
    const abort = e.target.closest('#btnAbortContract');
    if (claim && !claim.disabled) claimMission(claim);
    if (abort) abortMission(abort);
  });

  // ---- gear + properties ---------------------------------------------------
  $('#gearFilters').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-gear-cat]');
    if (!btn) return;
    UI.gearCategory = btn.dataset.gearCat;
    renderGearFilters();
    renderGear(vm());
  });
  $('#gearGrid').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-buy-item]');
    if (btn && !btn.disabled) buyItem(btn, btn.dataset.buyItem);
  });
  $('#propertyGrid').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-buy-property]');
    if (btn && !btn.disabled) buyProperty(btn, btn.dataset.buyProperty);
  });
  $('#btnCollectIncome').addEventListener('click', function (e) { collectIncome(e.currentTarget); });

  // ---- logs -----------------------------------------------------------------
  $$('#logFilters button').forEach(function (b) {
    b.addEventListener('click', function () { UI.logFilter = b.dataset.logFilter; loadLogs(true); });
  });
  $('#btnMoreLogs').addEventListener('click', function (e) {
    withBusy(e.currentTarget, 'more-logs', async function () {
      UI.logLimit = Math.min(200, UI.logLimit + 60);
      await loadLogs(false);
    });
  });
  $('#btnClearLogs').addEventListener('click', async function (e) {
    const btn = e.currentTarget;
    const ok = await modal({ title: 'Purge activity feed', body: 'Wipe every entry from your terminal history? This cannot be undone.', okText: 'Purge', danger: true, icon: 'fa-eraser' });
    if (!ok) return;
    withBusy(btn, 'clear-logs', async function () {
      await rpc('clear_logs');
      await loadLogs(true);
      toast('Terminal history cleared.', 'info');
    });
  });

  // ---- profile ----------------------------------------------------------------
  $('#btnChangePw').addEventListener('click', function (e) { changePassphrase(e.currentTarget); });

  // ---- admin ------------------------------------------------------------------
  let searchTimer = null;
  $('#admSearch').addEventListener('input', function (e) {
    UI.adminQuery = e.target.value.trim();
    UI.adminPage = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadAdmin, 250);   // debounced server-side filter
  });
  $('#adminTableBody').addEventListener('click', function (e) {
    const grant  = e.target.closest('[data-adm-grant]');
    const refill = e.target.closest('[data-adm-refill]');
    const role   = e.target.closest('[data-adm-role]');
    const purge  = e.target.closest('[data-adm-purge]');
    if (grant)  adminGrant(grant, grant.dataset.admGrant);
    if (refill) adminRefill(refill, refill.dataset.admRefill);
    if (role && !role.disabled)   adminSetRole(role, role.dataset.admRole);
    if (purge && !purge.disabled) adminPurge(purge, purge.dataset.admPurge);
  });

  // ---- shadow exchange --------------------------------------------------------
  let mkTimer = null;
  $('#mkSearch').addEventListener('input', function (e) {
    Market.query = e.target.value.trim();
    clearTimeout(mkTimer);
    // Debounced so a typed word is one filtered query, not eight.
    mkTimer = setTimeout(function () {
      loadMarket({ resetPage: true }).then(renderMarket).catch(function (err) { toast(err.message, 'error'); });
    }, 280);
  });
  ['#mkCategory', '#mkRarity', '#mkSort'].forEach(function (sel) {
    $(sel).addEventListener('change', function (e) {
      if (sel === '#mkCategory') Market.category = e.target.value;
      if (sel === '#mkRarity')   Market.rarity   = e.target.value;
      if (sel === '#mkSort')     Market.sort     = e.target.value;
      loadMarket({ resetPage: true }).then(renderMarket).catch(function (err) { toast(err.message, 'error'); });
    });
  });
  $('#mkPrev').addEventListener('click', function (e) {
    if (Market.page === 0) return;
    withBusy(e.currentTarget, 'mk-prev', async function () {
      Market.page -= 1; await loadMarket(); renderMarket();
    });
  });
  $('#mkNext').addEventListener('click', function (e) {
    if ((Market.page + 1) * Market.pageSize >= Market.total) return;
    withBusy(e.currentTarget, 'mk-next', async function () {
      Market.page += 1; await loadMarket(); renderMarket();
    });
  });
  $('#mkListItem').addEventListener('change', renderPriceHint);
  $('#mkBtnList').addEventListener('click', function (e) { marketPost(e.currentTarget); });

  // One delegated listener covers the grid; cards are re-rendered constantly.
  $('#mkGrid').addEventListener('click', function (e) {
    const buy    = e.target.closest('[data-mk-buy]');
    const offer  = e.target.closest('[data-mk-offer]');
    const cancel = e.target.closest('[data-mk-cancel]');
    if (buy && !buy.disabled) marketBuy(buy, buy.dataset.mkBuy, num(buy.dataset.mkTotal));
    if (offer)  marketOffer(offer, offer.dataset.mkOffer);
    if (cancel) marketCancel(cancel, cancel.dataset.mkCancel);
  });
  ['#mkIncoming', '#mkMine', '#mkMyOffers'].forEach(function (sel) {
    $(sel).addEventListener('click', function (e) {
      const acc = e.target.closest('[data-mk-accept]');
      const dec = e.target.closest('[data-mk-decline]');
      const can = e.target.closest('[data-mk-cancel]');
      const wdr = e.target.closest('[data-mk-withdraw]');
      if (acc) marketRespond(acc, acc.dataset.mkAccept, true);
      if (dec) marketRespond(dec, dec.dataset.mkDecline, false);
      if (can) marketCancel(can, can.dataset.mkCancel);
      if (wdr) marketWithdrawOffer(wdr, wdr.dataset.mkWithdraw);
    });
  });

  // ---- about / system diagnostics ---------------------------------------------
  $$('[data-diag-open]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openDiagnostics(); });
  });
  $$('[data-diag-close]').forEach(function (b) {
    b.addEventListener('click', closeDiagnostics);
  });
  $('#diagRerun').addEventListener('click', function () { runDiagnostics(); });
  $('#diagCopy').addEventListener('click', function (e) { copyDiagnostics(e.currentTarget); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#diagHost').hidden) closeDiagnostics();
  });
}

/* ==========================================================================
 * 22. BOOTSTRAP
 * ======================================================================== */
async function init() {
  Theme.init();
  setAuthTab('login');
  bindEvents();
  $('#footerStorageNote').textContent = 'Shadow net · server-authoritative';

  if (!CONFIGURED) {
    showLanding();
    await alertBox('Server configuration missing',
      'This build has no Supabase project attached. Copy config.example.js to config.js and fill in SUPABASE_URL and SUPABASE_ANON_KEY, or set those environment variables in your Cloudflare Pages project.',
      'fa-plug-circle-exclamation');
    return;
  }

  // A recovery link puts a session in the URL; Supabase consumes it for us.
  sb.auth.onAuthStateChange(function (event) {
    if (event === 'PASSWORD_RECOVERY') { UI.recovery = true; promptPasswordReset(); }
    if (event === 'SIGNED_OUT') { State.profile = null; showLanding(); }
  });

  const { data } = await sb.auth.getSession();
  if (data.session) {
    await showApp();
    rpc('touch_login').catch(() => {});
  } else {
    // Fetch the catalogue anyway so the landing page lists live content.
    try {
      Object.assign(Content, await rpc('get_catalog'));
      renderLandingExploits();
    } catch (e) { /* landing still renders without it */ }
    showLanding();
  }

  /* --------------------------------------------------------------------
   * Passive ticker. It only *displays* progress — energy and timers are
   * granted by the database. Every 30s we reconcile with the server.
   * ------------------------------------------------------------------ */
  let sinceSync = 0;
  setInterval(async function () {
    if (!State.profile || $('#viewApp').hidden) return;
    const user = vm();
    renderHeader(user);
    if (UI.tab === 'ops') renderOps(user);
    if (UI.tab === 'assets') {
      const el = $('#pendingIncome');
      if (el) el.textContent = money(pendingIncome());
    }
    if (UI.tab === 'contracts' && State.mission_run) renderActiveContract();

    sinceSync += 1;
    if (sinceSync >= 15) {          // 15 × 2s = 30s
      sinceSync = 0;
      await refreshSelf();
    }
  }, 2000);
}

document.addEventListener('DOMContentLoaded', init);
