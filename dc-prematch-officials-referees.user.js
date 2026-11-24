// ==UserScript==
// @name         DC – Prematch Officials
// @namespace    dkode.dc.referee
// @version      3.5.0
// @description  Sloupec "Referee available" se jménem rozhodčího z Google tabulky (klik = otevře Lineups a doplní rozhodčího), Check v DC → Hotovo = TRUE, Lineups → automatické hledání rozhodčích podle sportu, "Check all" a "Bez rozhodčích" u soutěží
// @match        https://dc.livesport.eu/*
// @match        https://dcstg.livesport.eu/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      docs.google.com
// @connect      googleusercontent.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/MrQev/dc-prematch-officials/main/dc-prematch-officials-referees.user.js
// @downloadURL  https://raw.githubusercontent.com/MrQev/dc-prematch-officials/main/dc-prematch-officials-referees.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // KONFIGURACE
  // SHEET_URL: odkaz na Google tabulku (stačí zkopírovat z adresního řádku, včetně #gid=…
  //            pokud data nejsou na prvním listu). Dá se změnit i přes menu Tampermonkey.
  // ID_COLUMN / REFEREE_COLUMN: název sloupce v hlavičce NEBO písmeno sloupce (A, B, C…).
  //            Když je null, script sloupce zkusí najít sám podle názvu v hlavičce.
  // ---------------------------------------------------------------------------
  const DEFAULT_SHEET_URL = '';
  const ID_COLUMN = 'DC ID';         // sloupec s ID eventu v DC
  const REFEREE_COLUMN = 'Rozhodčí';  // sloupec se jménem rozhodčího
  const DONE_COLUMN = 'Hotovo';       // sloupec, který se po Checku nastaví na TRUE
  const HEADER_SEARCH_ROWS = 10;      // v kolika prvních řádcích hledat hlavičku
  const REFRESH_MINUTES = 5;     // jak často se tabulka znovu načítá

  const ID_HEADER_GUESSES = ['dc id', 'event id', 'eventid', 'id zápasu', 'id zapasu', 'match id', 'id'];
  const REF_HEADER_GUESSES = ['referee', 'rozhodčí', 'rozhodci', 'hlavní rozhodčí', 'main referee'];

  const COL_CLASS = 'dc-ref-avail-col';
  let refMap = new Map();        // eventId -> jméno rozhodčího
  let sheetIds = new Set();      // všechna DC ID v tabulce
  let doneSet = new Set();       // DC ID s Hotovo = TRUE
  const sendingSet = new Set();  // DC ID, které se právě zapisují
  let status = 'loading';        // loading | ok | error | nourl
  let statusMsg = '';

  // --- nastavení přes menu Tampermonkey -------------------------------------
  const getSheetUrl = () => GM_getValue('sheetUrl', DEFAULT_SHEET_URL);
  function askSheetUrl() {
    const url = prompt('Vlož odkaz na Google tabulku (včetně #gid=… pro konkrétní list):', getSheetUrl());
    if (url !== null) { GM_setValue('sheetUrl', url.trim()); loadSheet(); }
  }
  GM_registerMenuCommand('Nastavit Google tabulku s rozhodčími', askSheetUrl);
  GM_registerMenuCommand('Znovu načíst rozhodčí', () => loadSheet());

  const getWebAppUrl = () => GM_getValue('webAppUrl', '');
  const getSecret = () => GM_getValue('webAppSecret', '');
  GM_registerMenuCommand('Nastavit zápis do tabulky (Apps Script)', () => {
    const url = prompt('URL nasazené Apps Script web app (končí na /exec):', getWebAppUrl());
    if (url === null) return;
    const secret = prompt('Tajný klíč (SECRET z Apps Scriptu):', getSecret());
    if (secret === null) return;
    GM_setValue('webAppUrl', url.trim());
    GM_setValue('webAppSecret', secret.trim());
  });

  // --- načtení Google tabulky ------------------------------------------------
  function buildCsvUrl(url) {
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return null;
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }

  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function resolveColumn(header, wanted, guesses) {
    const norm = (s) => String(s || '').trim().toLowerCase();
    if (wanted) {
      if (/^[A-Z]{1,2}$/i.test(wanted)) {
        return wanted.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      }
      return header.findIndex((h) => norm(h) === norm(wanted));
    }
    for (const g of guesses) {
      const i = header.findIndex((h) => norm(h) === g);
      if (i !== -1) return i;
    }
    return header.findIndex((h) => guesses.some((g) => norm(h).includes(g)));
  }

  function loadSheet() {
    const url = getSheetUrl();
    const csvUrl = url && buildCsvUrl(url);
    if (!csvUrl) {
      status = 'nourl'; statusMsg = 'Nastav odkaz na tabulku v menu Tampermonkey';
      apply(); return;
    }
    status = 'loading'; apply();
    GM_xmlhttpRequest({
      method: 'GET',
      url: csvUrl,
      onload: (res) => {
        const text = res.responseText || '';
        if (res.status !== 200 || /^\s*<(!doctype|html)/i.test(text)) {
          status = 'error';
          statusMsg = `Tabulku se nepodařilo načíst (HTTP ${res.status}). Jsi v prohlížeči přihlášený do Googlu s přístupem k tabulce?`;
          apply(); return;
        }
        const rows = parseCsv(text);
        // hlavička nemusí být na prvním řádku → najít první řádek, kde jsou oba sloupce
        let headerRow = -1, idIdx = -1, refIdx = -1;
        for (let i = 0; i < Math.min(HEADER_SEARCH_ROWS, rows.length); i++) {
          const a = resolveColumn(rows[i], ID_COLUMN, ID_HEADER_GUESSES);
          const b = resolveColumn(rows[i], REFEREE_COLUMN, REF_HEADER_GUESSES);
          if (a >= 0 && b >= 0 && a !== b) { headerRow = i; idIdx = a; refIdx = b; break; }
        }
        if (headerRow < 0) {
          status = 'error';
          statusMsg = `V prvních ${HEADER_SEARCH_ROWS} řádcích jsem nenašel sloupce "${ID_COLUMN}" a "${REFEREE_COLUMN}". Zkontroluj ID_COLUMN / REFEREE_COLUMN.`;
          apply(); return;
        }
        const doneIdx = resolveColumn(rows[headerRow], DONE_COLUMN, ['hotovo', 'done']);
        const map = new Map(), ids = new Set(), done = new Set();
        for (const r of rows.slice(headerRow + 1)) {
          const id = String(r[idIdx] || '').replace(/\D/g, '');
          if (!id) continue;
          ids.add(id);
          const ref = String(r[refIdx] || '').trim();
          if (ref) map.set(id, ref);
          if (doneIdx >= 0 && /^(true|pravda|1|ano|x|✓|✔)$/i.test(String(r[doneIdx] || '').trim())) done.add(id);
        }
        refMap = map; sheetIds = ids; doneSet = done;
        status = 'ok';
        statusMsg = `Načteno ${map.size} rozhodčích (${new Date().toLocaleTimeString()})`;
        apply();
      },
      onerror: () => { status = 'error'; statusMsg = 'Chyba sítě při načítání tabulky'; apply(); },
    });
  }

  // --- styly -----------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    th.${COL_CLASS}, td.${COL_CLASS} { text-align: center; white-space: nowrap; }
    th.${COL_CLASS} .ref-reload { cursor: pointer; margin-left: 4px; }
    td.${COL_CLASS} .ref-yes { color: #28a745; font-weight: bold; }
    td.${COL_CLASS} .ref-link { cursor: pointer; text-decoration: underline dotted; }
    td.${COL_CLASS} .ref-link:hover { text-decoration: underline; }
    td.${COL_CLASS} .ref-no  { color: #bbb; }
    td.${COL_CLASS} .ref-done { color: #28a745; margin-left: 4px; }
    td.${COL_CLASS} .ref-sending { margin-left: 4px; }
    td.${COL_CLASS} .ref-fail { color: #dc3545; margin-left: 4px; }
    th.${COL_CLASS} .ref-err { color: #dc3545; margin-left: 4px; }
    .dc-ref-no-referees-badge {
      display: inline-block; background: rgba(255,0,70,0.14); color: #FF0046;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 2px 6px; border-radius: 4px; margin-left: 8px; white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
  `;
  document.head.appendChild(style);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // --- vykreslení ------------------------------------------------------------
  function renderHeader(th) {
    const icon = status === 'loading' ? '⏳' : (status === 'ok' ? '⟳' : '⚠');
    const key = `${status}|${statusMsg}`;
    if (th.dataset.key === key) return;
    th.dataset.key = key;
    th.innerHTML = `<span class="ws-nowrap">Referee available</span>` +
      `<span class="ref-reload ${status === 'ok' || status === 'loading' ? '' : 'ref-err'}" title="${esc(statusMsg || 'Načíst znovu')}">${icon}</span>`;
  }

  function renderCell(td, eventId) {
    const name = refMap.get(eventId);
    const mark = sendingSet.has(eventId) ? 'sending' : (failMap.has(eventId) ? 'fail' : (doneSet.has(eventId) ? 'done' : ''));
    const key = `${status}|${name || ''}|${mark}`;
    if (td.dataset.key === key) return;
    td.dataset.key = key;
    let html;
    if (status === 'loading' && !refMap.size) html = '<span class="ref-no">…</span>';
    else if (name) html = `<span class="ref-yes ref-link" title="Kliknutím otevřeš Lineups a doplníš rozhodčího: ${esc(name)}">${esc(name)}</span>`;
    else html = '<span class="ref-no" title="Rozhodčí v tabulce není">—</span>';
    if (mark === 'done') html += '<span class="ref-done" title="V tabulce Hotovo = TRUE">☑</span>';
    if (mark === 'sending') html += '<span class="ref-sending" title="Zapisuji do tabulky…">⏳</span>';
    if (mark === 'fail') html += `<span class="ref-fail" title="${esc(failMap.get(eventId))}">⚠</span>`;
    td.innerHTML = html;
  }

  function apply() {
    const table = document.getElementById('dlist_table');
    if (!table) return;

    const headRow = table.querySelector('thead tr');
    const epsTh = headRow && headRow.querySelector('th[id*="_ch_eps_"]');
    if (!epsTh) return;
    let th = headRow.querySelector(`th.${COL_CLASS}`);
    if (!th || th.previousElementSibling !== epsTh) {
      if (th) th.remove();
      th = document.createElement('th');
      th.className = COL_CLASS;
      epsTh.after(th);
    }
    renderHeader(th);

    table.querySelectorAll('#dlist_table_tbody > tr[id^="dlist_table_row_"]').forEach((tr) => {
      const eventId = tr.dataset.id;
      const epsTd = tr.querySelector('.rh-event-participants')?.closest('td');
      if (!eventId || !epsTd) return;
      let td = tr.querySelector(`td.${COL_CLASS}`);
      if (!td || td.previousElementSibling !== epsTd) {
        if (td) td.remove();
        td = document.createElement('td');
        td.className = COL_CLASS;
        epsTd.after(td);
      }
      renderCell(td, eventId);
    });
  }

  // --- zápis Hotovo = TRUE po kliknutí na Check ------------------------------
  const failMap = new Map();     // DC ID -> chybová hláška
  let queue = new Set();
  let flushTimer = null;

  function queueDone(eventId) {
    if (!sheetIds.has(eventId) || doneSet.has(eventId)) return; // zápas v tabulce není / už je hotovo
    if (!getWebAppUrl()) {
      failMap.set(eventId, 'Není nastavený zápis – menu Tampermonkey → Nastavit zápis do tabulky');
      apply(); return;
    }
    queue.add(eventId); sendingSet.add(eventId); failMap.delete(eventId);
    apply();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushQueue, 800); // "Check all" → pošle se to jednou dávkou
  }

  function flushQueue() {
    const ids = [...queue]; queue = new Set();
    if (!ids.length) return;
    const fail = (msg) => { ids.forEach((id) => { sendingSet.delete(id); failMap.set(id, msg); }); apply(); };
    GM_xmlhttpRequest({
      method: 'POST',
      url: getWebAppUrl(),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      data: JSON.stringify({ secret: getSecret(), ids }),
      onload: (res) => {
        let json;
        try { json = JSON.parse(res.responseText); } catch { return fail(`Neočekávaná odpověď (HTTP ${res.status}) – zkontroluj nasazení web app`); }
        if (!json.ok) return fail(json.error || 'Chyba zápisu');
        (json.updated || []).forEach((id) => { sendingSet.delete(id); doneSet.add(id); });
        (json.notFound || []).forEach((id) => { sendingSet.delete(id); failMap.set(id, 'DC ID v tabulce nenalezeno'); });
        ids.forEach((id) => sendingSet.delete(id));
        apply();
      },
      onerror: () => fail('Chyba sítě při zápisu do tabulky'),
    });
  }

  // zachytí klik na Check (i programový .click() z "Check all")
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action-id$="-doCheck-click"]');
    if (!btn) return;
    const tr = btn.closest('tr[id^="dlist_table_row_"]');
    if (tr && tr.dataset.id) queueDone(tr.dataset.id);
  }, true);

  // klik na ikonu v hlavičce = znovu načíst tabulku
  document.addEventListener('click', (e) => {
    if (!e.target.closest(`th.${COL_CLASS} .ref-reload`)) return;
    e.preventDefault(); e.stopPropagation();
    if (status === 'nourl') askSheetUrl(); else loadSheet();
  }, true);


  // ===========================================================================
  // LINEUPS – DOPLNĚNÍ ROZHODČÍCH
  // (převzato z "DC Prematch Officials — Auto-open Referee search on Lineups" 2.1)
  //
  // • Ruční klik na Lineups: podle sportu přidá řádky Referee a postupně otevře hledání
  //   (jako dřív). Jediný výsledek TVÉHO hledání se vybere sám, po vyplnění všech slotů se uloží.
  // • Klik na jméno ve sloupci Referee available: otevře Lineups daného zápasu, přidá řádky
  //   a do hledání rovnou vepíše jméno z tabulky. Jediný odpovídající výsledek → vybere se
  //   a soupiska se uloží sama. Víc výsledků → vybereš ručně, uloží se po výběru.
  //   Nic nenalezeno → zkusí se ještě jen příjmení.
  //   Víc jmen v jedné buňce oddělených ; nebo | nebo novým řádkem → každé do dalšího slotu.
  // ===========================================================================

  const SPORT_REFEREE_COUNT = {
    football:       1,
    soccer:         1,
    hockey:         2,
    'ice hockey':   2,
    basketball:     3,
    handball:       2,
    volleyball:     2,
    baseball:       6,
    'rugby league': 3,
    'rugby union':  1,
  };
  const DEFAULT_REFEREE_COUNT            = 1;
  const REFEREE_PARTICIPANT_TYPE_VALUE   = '23';
  const SEARCH_TRIGGER_SELECTOR          = '.participant-select [data-action-id$="-doOpenSearch-click"]';
  const OLD_SEARCH_LINK_SELECTOR         = '.participant-select a[data-action-id$="-doOpenSearch-click"]';
  const ADD_ROW_SELECTOR                 = '[data-action-id$="_officials-doAddItem-click"]';
  const SAVE_BTN_SELECTOR                = 'button[data-action-id$="-doSave-click"]';
  const FORMATION_SELECTOR               = 'select[data-action-id$="_officials-doSelectFormation-change"]';
  const LINEUPS_ICON_SELECTOR            = 'span[title="Lineups"]';
  const NAME_FILTER_SELECTOR             = '[data-test-id="filter-field-search"]';
  const SELECTION_TIMEOUT_MS             = 120_000;
  const AFTER_ADD_ROW_WAIT_MS            = 250;
  const AFTER_SELECTION_WAIT_MS          = 300;
  const AFTER_ALL_ROWS_ADDED_WAIT_MS     = 100;
  const POLL_INTERVAL_MS                 = 200;
  const OPEN_CONFIRM_WAIT_MS             = 2500;
  const LINEUP_LOAD_TIMEOUT_MS           = 30_000;  // jak dlouho čekat, než se nová soupiska načte
  const LINEUP_SAME_PANEL_FALLBACK_MS    = 8_000;   // když DC znovu použije stejný panel, po této době ho bereme
  const LINEUP_STABLE_MS                 = 700;     // soupiska musí být tak dlouho beze změny, než se na ni sáhne
  const ADD_ROW_ATTEMPTS                 = 3;
  const AUTO_PICK_SINGLE_RESULT          = true;
  const AUTO_PICK_SETTLE_MS              = 350;
  const AUTO_PICK_IMPLICIT_WAIT_MS       = 1800;
  const AUTO_PICK_MAX_WAIT_MS            = 15000;
  const SURNAME_FALLBACK                 = true;  // 0 výsledků pro celé jméno → zkusit příjmení

  const log = (...a) => console.log('[DC Officials]', ...a);
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(fn, timeoutMs = 6000, stepMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = fn();
      if (val) return val;
      await sleep(stepMs);
    }
    return null;
  }

  function fireClickSequence(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
    };
    const fire = (Type, type, extra) => {
      const init = { ...base, ...extra };
      let ev;
      try { ev = new Type(type, { ...init, view: window }); } catch (e) { ev = new Type(type, init); }
      el.dispatchEvent(ev);
    };
    if (typeof PointerEvent === 'function') {
      fire(PointerEvent, 'pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 });
    }
    fire(MouseEvent, 'mousedown', { buttons: 1, detail: 1 });
    if (typeof PointerEvent === 'function') {
      fire(PointerEvent, 'pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 });
    }
    fire(MouseEvent, 'mouseup', { buttons: 0, detail: 1 });
    fire(MouseEvent, 'click', { buttons: 0, detail: 1 });
  }

  function isRendered(el) {
    if (!el || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function getDatalistRoot() {
    const roots = Array.from(document.querySelectorAll('#datalist-container')).filter(isRendered);
    return roots.length ? roots[roots.length - 1] : null;
  }

  function findParticipantCell(row) {
    if (!row) return null;
    return Array.from(row.querySelectorAll('td')).find((td) =>
      Array.from(td.classList).some((c) => c.endsWith('-participant'))) || null;
  }

  // Soupiska, se kterou aktuální běh pracuje (nastaví se, když se nová soupiska načte).
  // Díky tomu se nesáhne na předchozí, ještě otevřený/zavírající se panel.
  let pinnedFormation = null;

  function getLiveOfficialsTable() {
    if (pinnedFormation && pinnedFormation.isConnected && pinnedFormation.offsetParent !== null) {
      return pinnedFormation.closest('table');
    }
    const visible = Array.from(document.querySelectorAll(FORMATION_SELECTOR))
      .reverse()
      .find((el) => el.offsetParent !== null);
    return visible ? visible.closest('table') : null;
  }

  const visibleFormations = () =>
    Array.from(document.querySelectorAll(FORMATION_SELECTOR)).filter((el) => el.offsetParent !== null);

  // Počká na soupisku otevřenou TÍMTO klikem: nový panel (ne ten, který byl vidět před
  // klikem) a pak, až se participanti dotáhnou (obsah tabulky se přestane měnit).
  async function waitForFreshLineup(formationsBefore, alive) {
    const start = Date.now();
    const formation = await waitFor(() => {
      if (!alive()) return 'aborted';
      const vis = visibleFormations();
      const fresh = vis.reverse().find((el) => !formationsBefore.has(el));
      if (fresh) return fresh;
      // DC mohlo použít stejný panel znovu → po chvíli vzít ten, co je vidět
      if (Date.now() - start > LINEUP_SAME_PANEL_FALLBACK_MS && vis.length) return vis[0];
      return null;
    }, LINEUP_LOAD_TIMEOUT_MS, 150);
    if (!formation || formation === 'aborted') return null;

    // Ustálení: počet řádků a obsah tabulky beze změny po LINEUP_STABLE_MS
    let lastSig = null, stableSince = Date.now();
    const ok = await waitFor(() => {
      if (!alive()) return 'aborted';
      if (!formation.isConnected) return 'lost';
      const table = formation.closest('table');
      const sig = table ? `${table.querySelectorAll('tbody tr').length}|${table.textContent.length}` : '';
      if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); return null; }
      const panel = formation.closest('.winbox, [id*="cml_instance"]') || table;
      if (panel && panel.querySelector('.ant-spin[aria-busy="true"], .ant-spin-spinning')) { stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= LINEUP_STABLE_MS ? true : null;
    }, LINEUP_LOAD_TIMEOUT_MS, 150);
    if (ok !== true) return ok === 'lost' ? waitForFreshLineup(formationsBefore, alive) : null;
    log(`lineup loaded in ${Date.now() - start} ms`);
    return formation;
  }

  // ── Detekce sportu ──────────────────────────────────────────────────────────
  function sportFromText(text, source) {
    text = text.toLowerCase().trim();
    for (const [key, count] of Object.entries(SPORT_REFEREE_COUNT)) {
      if (text.includes(key)) { log(`sport="${key}" (${source}), refereeCount=${count}`); return { sport: key, refereeCount: count }; }
    }
    return null;
  }

  function detectSport(clickedIcon) {
    const matchRow = clickedIcon?.closest('tr');
    if (matchRow) {
      let el = matchRow.previousElementSibling;
      while (el) {
        if (el.classList.contains('group-label')) {
          const sportLink = el.querySelector('a[href^="/jsx/data/sport"]');
          const res = sportLink && sportFromText(sportLink.textContent, 'group-label');
          if (res) return res;
          break;
        }
        el = el.previousElementSibling;
      }
    }
    const globalSportLink = document.querySelector('a[href^="/jsx/data/sport"]');
    const res = globalSportLink && sportFromText(globalSportLink.textContent, 'global nav');
    if (res) return res;
    log(`sport not detected, default=${DEFAULT_REFEREE_COUNT}`);
    return { sport: 'unknown', refereeCount: DEFAULT_REFEREE_COUNT };
  }

  // ── Řádky rozhodčích ────────────────────────────────────────────────────────
  function getRefereeRows(table) {
    return Array.from(table.querySelectorAll('tbody tr')).filter((r) => {
      const ptSelect = r.querySelector('select[data-action-id$="-doSetPt-change"]');
      if (!ptSelect) return false;
      if (ptSelect.value === REFEREE_PARTICIPANT_TYPE_VALUE) return true;
      return ptSelect.options[ptSelect.selectedIndex]?.textContent.trim() === 'Referee';
    });
  }

  function isRowEmpty(row) {
    if (!row) return false;
    if (row.querySelector('.participant-container--participant-na')) return true;
    const holder = findParticipantCell(row)?.querySelector('.participant-container')
      || row.querySelector('.participant-select .participant-container');
    const text = holder?.textContent.trim();
    if (text) return /participant\s*n\/a/i.test(text);
    return !!row.querySelector(OLD_SEARCH_LINK_SELECTOR) || !holder;
  }

  async function addOneRefereeRow() {
    const table = getLiveOfficialsTable();
    if (!table) return false;
    const addIcon = table.querySelector(ADD_ROW_SELECTOR);
    if (!addIcon) return false;

    const totalBefore = table.querySelectorAll('tbody tr').length;
    fireClickSequence(addIcon);
    const appeared = await waitFor(() => {
      const t = getLiveOfficialsTable();
      return t && t.querySelectorAll('tbody tr').length > totalBefore ? true : null;
    }, 3000, 100);
    if (!appeared) return false;
    await sleep(200);

    const t2 = getLiveOfficialsTable();
    if (!t2) return false;
    const rows = t2.querySelectorAll('tbody tr');
    const newRow = rows[rows.length - 1];
    const ptSelect = newRow?.querySelector('select[data-action-id$="-doSetPt-change"]');
    const opt = ptSelect && Array.from(ptSelect.options).find((o) => o.value === REFEREE_PARTICIPANT_TYPE_VALUE);
    if (ptSelect && opt) {
      ptSelect.value = REFEREE_PARTICIPANT_TYPE_VALUE;
      ptSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(AFTER_ADD_ROW_WAIT_MS);
    }
    return true;
  }

  async function ensureRefereeRows(needed, alive, formationsBefore) {
    const formation = await waitForFreshLineup(formationsBefore, alive);
    if (!alive()) return [];
    if (!formation) { log('lineup table not found'); return []; }
    pinnedFormation = formation;

    let refs = getRefereeRows(getLiveOfficialsTable());
    log(`existing=${refs.length}, needed=${needed}`);
    let attempts = 0;
    while (refs.length < needed && alive() && attempts < needed * ADD_ROW_ATTEMPTS) {
      attempts++;
      log(`adding referee row ${refs.length + 1}/${needed}`);
      const added = await addOneRefereeRow();
      if (!added) { log('row did not appear, retrying'); await sleep(500); }
      const t = getLiveOfficialsTable();
      refs = t ? getRefereeRows(t) : [];
    }
    await sleep(AFTER_ALL_ROWS_ADDED_WAIT_MS);
    const finalTable = getLiveOfficialsTable();
    return finalTable ? getRefereeRows(finalTable) : refs;
  }

  function clickSave() {
    const btn = Array.from(document.querySelectorAll(SAVE_BTN_SELECTOR))
      .reverse().find((el) => el.offsetParent !== null);
    if (btn) { log('clicking Save'); btn.click(); } else { log('Save button not found'); }
  }

  async function openSearchForRow(row, slotIndex) {
    const trigger = row.querySelector(SEARCH_TRIGGER_SELECTOR);
    if (!trigger) return false;
    const psId = row.querySelector('.participant-select')?.id || null;
    const rootBefore = getDatalistRoot();
    const isOpen = () => {
      if (psId) {
        const legacy = document.getElementById(`${psId}_ps_list_table_tbody`);
        if (legacy && legacy.offsetParent !== null) return true;
      }
      const root = getDatalistRoot();
      return !!root && (root !== rootBefore || !rootBefore);
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      fireClickSequence(trigger);
      const opened = await waitFor(() => (isOpen() || !isRowEmpty(row) ? true : null), OPEN_CONFIRM_WAIT_MS, 100);
      if (opened) return true;
      if (rootBefore) break;
      log(`search did not open for slot ${slotIndex + 1}, attempt ${attempt}/2`);
    }
    log(`could not confirm that the search opened for slot ${slotIndex + 1} — waiting for a manual selection`);
    return false;
  }

  // ── Automatický výběr jediného výsledku ─────────────────────────────────────
  // Spouští se jen po skutečném vyhledání (tvém, nebo vepsání jména z tabulky tímto
  // scriptem) – nikdy nad výchozím/zastaralým seznamem.
  let autoPick = { armed: false };
  const RESULT_NAME_SELECTOR = '[data-test-id^="table-column-name-"]';

  function resultCells(root) {
    return Array.from(root.querySelectorAll(RESULT_NAME_SELECTOR)).filter(isRendered);
  }
  const resultSignature = (root) => resultCells(root).map((c) => c.textContent.trim()).join('|');

  function resetAutoPick() { autoPick = { armed: false }; }

  function armAutoPick(via) {
    const root = getDatalistRoot();
    autoPick = {
      armed: true, via, armedAt: Date.now(),
      sigAtArm: root ? resultSignature(root) : '',
      sawBusy: false, lastSig: null, stableSince: 0, reported: false,
    };
  }

  const isInsidePanel = (el) => !!el?.closest?.('#datalist-container');
  const isSearchButton = (btn) =>
    /^datalist-controls-(search|refresh)-button$/.test(btn.getAttribute('data-test-id') || '') ||
    /^(search|refresh)\b/i.test(btn.textContent.trim());

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || !isInsidePanel(e.target)) return;
    armAutoPick('enter');
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.target.closest?.('button');
    if (btn && isInsidePanel(btn) && isSearchButton(btn)) armAutoPick('button');
  }, true);
  document.addEventListener('input', (e) => {
    if (!e.isTrusted || !isInsidePanel(e.target)) return;
    armAutoPick('typing');
  }, true);

  const normalizeForMatch = (str) => (str || '')
    .replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[đĐðÐ]/g, 'd').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/ß/g, 'ss').replace(/[ıİ]/g, 'i')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function typedFilters(root) {
    return {
      name: root.querySelector(NAME_FILTER_SELECTOR)?.value?.trim() || '',
      id: root.querySelector('[data-test-id="filter-field-id"]')?.value?.trim() || '',
    };
  }

  function resultMatchesTyped(typed, resultName) {
    if (typed.name) {
      const result = normalizeForMatch(resultName);
      return normalizeForMatch(typed.name).split(' ').some((tok) => tok.length >= 2 && result.includes(tok));
    }
    return !!typed.id;
  }

  // Vrací stav dokončeného hledání: 'picked' | 'none' | 'many' | null (ještě se čeká)
  function autoPickTick() {
    if (!AUTO_PICK_SINGLE_RESULT || !autoPick.armed) return null;
    const now = Date.now();
    if (now - autoPick.armedAt > AUTO_PICK_MAX_WAIT_MS) { autoPick.armed = false; return null; }
    const root = getDatalistRoot();
    if (!root) return null;

    if (root.querySelector('.ant-spin[aria-busy="true"]')) {
      autoPick.sawBusy = true; autoPick.stableSince = 0; autoPick.lastSig = null;
      return null;
    }
    const sig = resultSignature(root);
    if (sig !== autoPick.lastSig) { autoPick.lastSig = sig; autoPick.stableSince = now; return null; }
    if (now - autoPick.stableSince < AUTO_PICK_SETTLE_MS) return null;

    const cycleDone = autoPick.sawBusy || sig !== autoPick.sigAtArm;
    const implicitOk = autoPick.via !== 'typing' && now - autoPick.armedAt >= AUTO_PICK_IMPLICIT_WAIT_MS;
    if (!cycleDone && !implicitOk) return null;

    const cells = resultCells(root);
    if (cells.length === 0) return 'none';
    if (cells.length > 1) return 'many';   // rozhodnutí nechat na uživateli
    const typed = typedFilters(root);
    const name = cells[0].textContent.trim();
    if (!resultMatchesTyped(typed, name)) return 'many';

    autoPick.armed = false;
    log(`single result "${name}" for "${typed.name || typed.id}" — selecting it`);
    fireClickSequence(cells[0]);
    return 'picked';
  }

  // ── Vepsání jména z Google tabulky do hledání ───────────────────────────────
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(input) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => 13 });
      Object.defineProperty(ev, 'which', { get: () => 13 });
      input.dispatchEvent(ev);
    }
  }

  async function searchByName(query) {
    const input = await waitFor(() => {
      const el = getDatalistRoot()?.querySelector(NAME_FILTER_SELECTOR);
      return el && isRendered(el) ? el : null;
    }, 5000, 100);
    if (!input) { log('search field not found – search manually'); return false; }

    log(`searching "${query}"`);
    input.focus();
    armAutoPick('script');                 // stav seznamu PŘED hledáním
    setNativeValue(input, query);
    await sleep(150);
    const root = getDatalistRoot();
    const btn = root && Array.from(root.querySelectorAll('button')).find((b) =>
      isRendered(b) && (b.getAttribute('data-test-id') === 'datalist-controls-search-button' || /^search\b/i.test(b.textContent.trim())));
    if (btn) fireClickSequence(btn); else pressEnter(input);
    return true;
  }

  // Akademické tituly, které se z jména před hledáním odstraní (před i za jménem).
  // Bez tečky se porovnává podle velikosti písmen (aby příjmení jako "Ba" nebo "Di" zůstala),
  // s tečkou na konci ("ing.", "Dr.") velikost písmen nevadí. Doplň podle potřeby.
  const TITLES = [
    'BA', 'MA', 'BSc', 'MSc', 'MBA', 'MPA', 'LLB', 'LLM', 'BEng', 'MEng', 'BEd', 'MEd', 'BBA', 'Mag', 'MagPhil',
    'Ing', 'MgA', 'Mgr', 'Bc', 'BcA', 'Dr', 'PhD', 'PhDr', 'MUDr', 'MVDr', 'JUDr', 'RNDr', 'PaedDr', 'ThDr',
    'CSc', 'DrSc', 'DiS', 'Prof', 'Doc', 'DI', 'DiplIng', 'Dipl', 'DrMed', 'Mr', 'Mrs', 'Ms',
  ];
  const TITLES_LOWER = TITLES.map((t) => t.toLowerCase());
  function isTitle(tok) {
    const bare = tok.replace(/[.\-]/g, '');
    if (!bare) return false;
    if (TITLES.includes(bare)) return true;
    if (bare === bare.toUpperCase() && TITLES_LOWER.includes(bare.toLowerCase())) return true; // MSC, ING…
    if (tok.includes('.') && TITLES_LOWER.includes(bare.toLowerCase())) return true;           // ing., dr.
    return false;
  }

  // "Christian-Petru Ciochirca , BA" → "Christian-Petru Ciochirca"
  // "Ing. Stefan Macanovic , MSc"    → "Stefan Macanovic"
  // "BA Alain Sadikovski"            → "Alain Sadikovski"
  function cleanName(raw) {
    const parts = String(raw || '').split(',')
      .map((part) => part.trim().split(/\s+/).filter((tok) => tok && !isTitle(tok)).join(' '))
      .filter(Boolean);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  const splitNames = (cell) => String(cell || '').split(/\s*(?:;|\||\n)\s*/).map(cleanName).filter(Boolean);
  const surnameOf = (name) => { const parts = name.trim().split(/\s+/); return parts.length > 1 ? parts[parts.length - 1] : null; };

  // ── Postupné vyplnění slotů ─────────────────────────────────────────────────
  async function openSearchesSequentially(slots, names, alive) {
    for (let slotIndex = 0; slotIndex < slots; slotIndex++) {
      if (!alive()) return;
      const table = getLiveOfficialsTable();
      if (!table) { log('table lost, aborting'); return; }
      const refs = getRefereeRows(table);
      if (slotIndex >= refs.length) { log(`slot ${slotIndex} not found, aborting`); return; }

      const row = refs[slotIndex];
      if (!isRowEmpty(row)) { log(`slot ${slotIndex + 1} already filled, skipping`); continue; }
      if (!row.querySelector(SEARCH_TRIGGER_SELECTOR)) { log(`no search trigger in slot ${slotIndex + 1}, aborting`); return; }

      log(`opening search for slot ${slotIndex + 1}/${slots}`);
      resetAutoPick();
      await openSearchForRow(row, slotIndex);

      const name = names[slotIndex];
      let fallbackTried = false;
      if (name) await searchByName(name);

      const filled = await waitFor(() => {
        if (!alive()) return 'aborted';
        const result = autoPickTick();
        if (result === 'none' && name && SURNAME_FALLBACK && !fallbackTried) {
          fallbackTried = true;
          const surname = surnameOf(name);
          if (surname) { log(`no result for "${name}", trying "${surname}"`); searchByName(surname); }
        }
        const t = getLiveOfficialsTable();
        if (!t) return null;
        const freshRefs = getRefereeRows(t);
        if (slotIndex >= freshRefs.length) return null;
        return !isRowEmpty(freshRefs[slotIndex]) ? true : null;
      }, SELECTION_TIMEOUT_MS, POLL_INTERVAL_MS);

      if (filled === 'aborted') { log('aborted – another Lineups was opened'); return; }
      if (!filled) { log(`timeout waiting for slot ${slotIndex + 1}, aborting`); return; }
      log(`slot ${slotIndex + 1} filled`);
      await sleep(AFTER_SELECTION_WAIT_MS);
    }

    // Uložit jen když jsou opravdu VŠECHNY sloty vyplněné
    const finalTable = getLiveOfficialsTable();
    const finalRefs = finalTable ? getRefereeRows(finalTable) : [];
    const emptySlots = finalRefs.slice(0, slots).filter(isRowEmpty).length;
    if (!finalTable || finalRefs.length < slots || emptySlots > 0) {
      log(`NOT saving — ${emptySlots} of ${slots} referee slot(s) still empty`);
      return;
    }
    if (!alive()) return;
    log('all selections done, saving');
    await sleep(200);
    clickSave();
  }

  let currentRun = 0;
  async function openRefereeSearch(clickedIcon, names, formationsBefore) {
    const run = ++currentRun;            // nové otevření Lineups ukončí předchozí běh
    const alive = () => run === currentRun;
    pinnedFormation = null;
    const { refereeCount } = detectSport(clickedIcon);
    if (names.length > refereeCount) log(`${names.length} names in the sheet, but the sport needs ${refereeCount} – extra names ignored`);
    const refs = await ensureRefereeRows(refereeCount, alive, formationsBefore);
    if (!alive()) return;
    if (!refs.length) { log('no referee rows found, aborting'); return; }
    await openSearchesSequentially(refereeCount, names, alive);
  }

  // Jména pro nejbližší klik na Lineups (nastaví se klikem na jméno ve sloupci)
  let pendingLineupNames = null;

  document.addEventListener('click', (event) => {
    const icon = event.target.closest?.(LINEUPS_ICON_SELECTOR);
    if (!icon) return;
    const names = pendingLineupNames || [];
    pendingLineupNames = null;
    // snímek soupisek, které jsou vidět PŘED tím, než DC na klik zareaguje
    const formationsBefore = new Set(visibleFormations());
    openRefereeSearch(icon, names, formationsBefore);
  }, true);

  // Klik na jméno rozhodčího ve sloupci → otevřít Lineups toho zápasu a doplnit
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.(`td.${COL_CLASS} .ref-link`);
    if (!link) return;
    e.preventDefault(); e.stopPropagation();
    const tr = link.closest('tr[id^="dlist_table_row_"]');
    const name = tr && refMap.get(tr.dataset.id);
    const icon = tr && tr.querySelector(LINEUPS_ICON_SELECTOR);
    if (!name || !icon) { log('Lineups icon or referee name not found for this row'); return; }
    pendingLineupNames = splitNames(name);
    fireClickSequence(icon);
  }, true);


  // ===========================================================================
  // BULK CHECK – odznak "✓ Check all" za breadcrumbem soutěže
  // (převzato z "Bulk Check per Tournament Stage (data-checking tool)" 2.1)
  // Kliknutí na Check projdou i přes zápis Hotovo = TRUE do Google tabulky výše.
  // ===========================================================================
  const BULK_CLICK_DELAY_MS = 200;   // prodleva mezi kliky, aby se nezahltil backend
  const BADGE_CLASS = 'dc-bulk-check-badge';

  function getEventRowsForHeader(headerTr) {
    const eventRows = [];
    let sibling = headerTr.nextElementSibling;
    while (sibling) {
      if (sibling.classList && sibling.classList.contains('group-label')) break; // další soutěž
      if (sibling.hasAttribute && sibling.hasAttribute('data-id')) eventRows.push(sibling);
      sibling = sibling.nextElementSibling;
    }
    return eventRows;
  }

  const getCheckButton = (eventRow) => eventRow.querySelector('a.button[data-action-id*="-doCheck-click"]');

  async function checkAllForTournament(headerTr, statusEl) {
    const buttons = getEventRowsForHeader(headerTr).map(getCheckButton).filter(Boolean);
    if (buttons.length === 0) { statusEl.textContent = '✓ Check all (0 eventů)'; return; }

    let done = 0;
    statusEl.textContent = `⏳ 0/${buttons.length}`;
    for (const btn of buttons) {
      btn.click();
      done += 1;
      statusEl.textContent = `⏳ ${done}/${buttons.length}`;
      await sleep(BULK_CLICK_DELAY_MS);
    }
    statusEl.textContent = `✅ Checknuto ${done}/${buttons.length}`;
    setTimeout(() => { statusEl.textContent = '✓ Check all'; }, 2000);
  }

  function injectBulkBadge(anchor) {
    // Odznak se hledá kdekoli v breadcrumbu (ne jen hned za kotvou) – jiné skripty
    // vkládají odznaky na stejné místo a jinak by se navzájem množily.
    const container = anchor.parentElement || anchor.closest('tr');
    const existing = container ? Array.from(container.querySelectorAll(':scope > .' + BADGE_CLASS)) : [];
    if (existing.length) {
      existing.slice(1).forEach((extra) => extra.remove());
      return;
    }
    const headerTr = anchor.closest('tr');
    if (!headerTr) return;

    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = '✓ Check all';
    badge.title = 'Odškrtnout Check u všech zápasů této soutěže';
    Object.assign(badge.style, {
      cursor: 'pointer', marginLeft: '8px', padding: '2px 8px', border: '1px solid #28a745',
      borderRadius: '4px', color: '#28a745', fontSize: '12px', fontWeight: 'bold',
      userSelect: 'none', whiteSpace: 'nowrap', display: 'inline-block',
    });

    badge.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (badge.dataset.running === '1') return; // ochrana proti double-clicku
      const freshHeaderTr = anchor.closest('tr') || headerTr;
      badge.dataset.running = '1';
      badge.style.opacity = '0.6';
      await checkAllForTournament(freshHeaderTr, badge);
      badge.style.opacity = '1';
      badge.dataset.running = '0';
    });

    anchor.insertAdjacentElement('afterend', badge);
  }

  function scanBulkBadges() {
    document.querySelectorAll('tr.group-label [id$="_path_rh_tournament_stage_0"]').forEach(injectBulkBadge);
  }


  // ===========================================================================
  // "BEZ ROZHODČÍCH" – odznak u soutěží, které nemají použitelný zdroj rozhodčích
  // (převzato z "DC Prematch Officials — Open Lineups, set formation & auto-fill coaches" 5.9.1)
  // Názvy = tournament_template přesně tak, jak je v breadcrumbu, např. "Thai League 1 (Thailand)".
  // ===========================================================================
  const NO_REFEREE_TOURNAMENTS = [
    'Thai League 1 (Thailand)',
    'Betway Premiership (South Africa)',
    'Super League (Malaysia)',
    'Premier League (Singapore)',
    'Super League (Indonesia)',
    'KBO (South Korea)',
    'K League 1 (South Korea)',
    'K League 2 (South Korea)',
    'LMB (Mexico)',
    'League One (China)',
    'League Two (China)',
    'Super League (China)',
    'Saudi Professional League (Saudi Arabia)',
    'NPB (Japan)',
    'J1 League (Japan)',
    'J2 League (Japan)',
    'Liiga (Finland)',
    'DEL (Germany)',
    'SHL (Sweden)',
    'Extraliga (Czech Republic)',
    'National League (Switzerland)',
    'KHL (Russia)',
    'ISL (India)',
    'AFC Challenge League (Asia)',
    'EHL (Norway)',
    'Canadian Premier League (Canada)',
    'ACB (Spain)',
  ];
  const NO_REF_BADGE_CLASS = 'dc-ref-no-referees-badge';
  // Odznak stejného významu z coach scriptu – když ho tam už ten script dal, druhý nepřidáváme.
  const FOREIGN_NO_REF_BADGE_CLASS = 'dc-no-referees-badge';
  const NO_REF_SET = new Set(NO_REFEREE_TOURNAMENTS.map((n) => n.toLowerCase()));

  function annotateNoRefereeTournaments() {
    document.querySelectorAll('tr.group-label [id$="_path_rh_tournament_template_0"] a').forEach((link) => {
      const pathContainer = link.closest('span[id$="_path_rh_tournament_template_0"]')?.parentElement;
      if (!pathContainer) return;
      const wanted = NO_REF_SET.has(link.textContent.trim().toLowerCase())
        && !pathContainer.querySelector(`:scope > .${FOREIGN_NO_REF_BADGE_CLASS}`);

      // hledá se v celém breadcrumbu, ne jen vedle kotvy (jinak se odznaky skriptů množí)
      const own = Array.from(pathContainer.querySelectorAll(`:scope > .${NO_REF_BADGE_CLASS}`));
      own.slice(1).forEach((extra) => extra.remove());
      if (wanted && !own[0]) {
        const badge = document.createElement('span');
        badge.className = NO_REF_BADGE_CLASS;
        badge.textContent = 'Bez rozhodčích';
        badge.title = 'Pro tuto soutěž není zdroj rozhodčích';
        pathContainer.appendChild(badge);   // na konec breadcrumbu, za "Check all"
      } else if (!wanted && own[0]) {
        own[0].remove();
      }
    });
  }

  // DC tabulku překresluje → hlídat změny
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      observer.disconnect();
      apply();
      scanBulkBadges();
      annotateNoRefereeTournaments();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });

  apply();
  scanBulkBadges();
  annotateNoRefereeTournaments();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { scanBulkBadges(); annotateNoRefereeTournaments(); }, 1500);   // pojistka, kdyby observer něco propásl
  loadSheet();
  setInterval(loadSheet, REFRESH_MINUTES * 60 * 1000);
})();
