// ==UserScript==
// @name         DC – Prematch Officials
// @namespace    dkode.dc.referee
// @version      3.11.1
// @description  Sloupec "Referee available" se jménem rozhodčího z Google tabulky (klik = otevře Lineups a doplní rozhodčího), Check v DC → Hotovo = TRUE, klik na pitchera = doplní nadhazovače do soupisky (baseball), Lineups → automatické hledání rozhodčích podle sportu, "Check all" a "Bez rozhodčích" u soutěží, štítky Scan / Ruční skript podle listu Soutěže
// @match        https://dc.livesport.eu/data/data-checking/prematch-officials*
// @match        https://dc.livesport.eu/data/data-checking/prematch-resources*
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

  // ===========================================================================
  // BULK CHECK – odznak "✓ Check all" za breadcrumbem soutěže
  // (převzato z "Bulk Check per Tournament Stage (data-checking tool)" 2.1)
  // Běží v Prematch Officials i v Prematch Resources. V Officials kliknutí na Check
  // projdou i přes zápis Hotovo = TRUE do Google tabulky.
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
      await new Promise((r) => setTimeout(r, BULK_CLICK_DELAY_MS));
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


  // V Prematch Resources běží JEN "Check all" – nic jiného (sloupec, tabulka, Lineups…).
  const IS_OFFICIALS = location.pathname.startsWith('/data/data-checking/prematch-officials');
  if (!IS_OFFICIALS) {
    scanBulkBadges();
    let bulkTimer = null;
    new MutationObserver(() => {
      clearTimeout(bulkTimer);
      bulkTimer = setTimeout(scanBulkBadges, 100);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(scanBulkBadges, 1500);   // pojistka, kdyby observer něco propásl
    return;
  }

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

  // --- Pitcheři (baseball): list ve stejné Google tabulce -------------------
  const PITCHER_GID = '67554807';                 // list s pitchery (když není nastavený jiný odkaz)
  const PITCHER_HOME_COLUMN = 'Pitcher domácí';
  const PITCHER_AWAY_COLUMN = 'Pitcher hosté';
  const PITCH_COL_CLASS = 'dc-pitch-col';
  let pitcherMap = new Map();    // eventId -> { home, away }
  let pitcherIds = new Set();    // všechna DC ID v listu pitcherů
  let pitcherDone = new Set();   // DC ID s Hotovo = TRUE v listu pitcherů
  let pStatus = 'loading';
  let pStatusMsg = '';

  // --- Soutěže: list "Soutěže" ve stejné tabulce -----------------------------
  const COMP_GID = '674311894';
  const COMP_ID_COLUMN = 'DC template ID';
  const COMP_SCAN_COLUMN = 'Scan';
  const COMP_MANUAL_COLUMN = 'Ruční skript';
  let compMap = new Map();       // tournament template ID -> { scan, manual }

  // --- nastavení přes menu Tampermonkey -------------------------------------
  const getSheetUrl = () => GM_getValue('sheetUrl', DEFAULT_SHEET_URL);
  function askSheetUrl() {
    const url = prompt('Vlož odkaz na Google tabulku (včetně #gid=… pro konkrétní list):', getSheetUrl());
    if (url !== null) { GM_setValue('sheetUrl', url.trim()); loadSheet(); loadPitchers(); loadCompetitions(); }
  }
  GM_registerMenuCommand('Nastavit Google tabulku s rozhodčími', askSheetUrl);

  // List s pitchery: když není nastavený vlastní odkaz, vezme se stejná tabulka a list PITCHER_GID
  function getPitcherSheetUrl() {
    const own = GM_getValue('pitcherSheetUrl', '');
    if (own) return own;
    const m = getSheetUrl().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/edit#gid=${PITCHER_GID}` : '';
  }
  function askPitcherSheetUrl() {
    const url = prompt('Odkaz na list s pitchery (prázdné = stejná tabulka, list ' + PITCHER_GID + '):', GM_getValue('pitcherSheetUrl', ''));
    if (url !== null) { GM_setValue('pitcherSheetUrl', url.trim()); loadPitchers(); loadCompetitions(); }
  }
  GM_registerMenuCommand('Nastavit list s pitchery', askPitcherSheetUrl);
  GM_registerMenuCommand('Znovu načíst tabulku', () => { loadSheet(); loadPitchers(); loadCompetitions(); });

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

  function loadPitchers() {
    const csvUrl = buildCsvUrl(getPitcherSheetUrl() || '');
    if (!csvUrl) {
      pStatus = 'nourl'; pStatusMsg = 'Nastav odkaz na tabulku v menu Tampermonkey';
      apply(); return;
    }
    pStatus = 'loading'; apply();
    GM_xmlhttpRequest({
      method: 'GET',
      url: csvUrl,
      onload: (res) => {
        const text = res.responseText || '';
        if (res.status !== 200 || /^\s*<(!doctype|html)/i.test(text)) {
          pStatus = 'error';
          pStatusMsg = `List s pitchery se nepodařilo načíst (HTTP ${res.status})`;
          apply(); return;
        }
        const rows = parseCsv(text);
        let headerRow = -1, idIdx = -1, homeIdx = -1, awayIdx = -1;
        for (let i = 0; i < Math.min(HEADER_SEARCH_ROWS, rows.length); i++) {
          const a = resolveColumn(rows[i], ID_COLUMN, ID_HEADER_GUESSES);
          const b = resolveColumn(rows[i], PITCHER_HOME_COLUMN, []);
          const c = resolveColumn(rows[i], PITCHER_AWAY_COLUMN, []);
          if (a >= 0 && b >= 0 && c >= 0) { headerRow = i; idIdx = a; homeIdx = b; awayIdx = c; break; }
        }
        if (headerRow < 0) {
          pStatus = 'error';
          pStatusMsg = `V listu s pitchery chybí sloupce "${ID_COLUMN}", "${PITCHER_HOME_COLUMN}" nebo "${PITCHER_AWAY_COLUMN}"`;
          apply(); return;
        }
        const doneIdx = resolveColumn(rows[headerRow], DONE_COLUMN, ['hotovo', 'done']);
        const map = new Map(), ids = new Set(), done = new Set();
        for (const r of rows.slice(headerRow + 1)) {
          const id = String(r[idIdx] || '').replace(/\D/g, '');
          if (!id) continue;
          ids.add(id);
          const home = String(r[homeIdx] || '').trim();
          const away = String(r[awayIdx] || '').trim();
          if (home || away) map.set(id, { home, away });
          if (doneIdx >= 0 && /^(true|pravda|1|ano|x|✓|✔)$/i.test(String(r[doneIdx] || '').trim())) done.add(id);
        }
        pitcherMap = map; pitcherIds = ids; pitcherDone = done;
        pStatus = 'ok';
        pStatusMsg = `Načteno ${map.size} zápasů s pitchery (${new Date().toLocaleTimeString()})`;
        apply();
      },
      onerror: () => { pStatus = 'error'; pStatusMsg = 'Chyba sítě při načítání listu s pitchery'; apply(); },
    });
  }

  // List Soutěže: DC template ID → zpracování přes Scan / Ruční skript (hodnota "ano")
  function getCompSheetUrl() {
    const m = getSheetUrl().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/edit#gid=${COMP_GID}` : '';
  }
  const isYes = (v) => /^(ano|true|pravda|x|1|✓|✔|yes)$/i.test(String(v || '').trim());

  function loadCompetitions() {
    const csvUrl = buildCsvUrl(getCompSheetUrl() || '');
    if (!csvUrl) return;
    GM_xmlhttpRequest({
      method: 'GET',
      url: csvUrl,
      onload: (res) => {
        const text = res.responseText || '';
        if (res.status !== 200 || /^\s*<(!doctype|html)/i.test(text)) {
          console.log('[DC Officials]', `list Soutěže se nepodařilo načíst (HTTP ${res.status})`);
          return;
        }
        const rows = parseCsv(text);
        let headerRow = -1, idIdx = -1, scanIdx = -1, manIdx = -1;
        for (let i = 0; i < Math.min(HEADER_SEARCH_ROWS, rows.length); i++) {
          const a = resolveColumn(rows[i], COMP_ID_COLUMN, []);
          const b = resolveColumn(rows[i], COMP_SCAN_COLUMN, []);
          const c = resolveColumn(rows[i], COMP_MANUAL_COLUMN, []);
          if (a >= 0 && b >= 0 && c >= 0) { headerRow = i; idIdx = a; scanIdx = b; manIdx = c; break; }
        }
        if (headerRow < 0) {
          console.log('[DC Officials]', `v listu Soutěže chybí sloupce "${COMP_ID_COLUMN}", "${COMP_SCAN_COLUMN}" nebo "${COMP_MANUAL_COLUMN}"`);
          return;
        }
        const map = new Map();
        for (const r of rows.slice(headerRow + 1)) {
          const id = String(r[idIdx] || '').replace(/\D/g, '');
          if (id) map.set(id, { scan: isYes(r[scanIdx]), manual: isYes(r[manIdx]) });
        }
        compMap = map;
        console.log('[DC Officials]', `list Soutěže: ${map.size} soutěží`);
        annotateCompetitionModes();
      },
      onerror: () => console.log('[DC Officials]', 'chyba sítě při načítání listu Soutěže'),
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
    th.${PITCH_COL_CLASS} { white-space: nowrap; }
    td.${PITCH_COL_CLASS} { text-align: left; white-space: nowrap; }
    th.${PITCH_COL_CLASS} .ref-reload { cursor: pointer; margin-left: 4px; }
    th.${PITCH_COL_CLASS} .ref-err { color: #dc3545; margin-left: 4px; }
    td.${PITCH_COL_CLASS} .p-lb { display: inline-block; width: 12px; color: #999; font-size: 10px; }
    td.${PITCH_COL_CLASS} .ref-yes { color: #1565c0; font-weight: bold; }   /* pitcheři modře, rozhodčí zeleně */
    td.${PITCH_COL_CLASS} .ref-link { cursor: pointer; text-decoration: underline dotted; }
    td.${PITCH_COL_CLASS} .ref-link:hover { text-decoration: underline; }
    td.${PITCH_COL_CLASS} .ref-no  { color: #bbb; }
    td.${PITCH_COL_CLASS} .ref-done { color: #28a745; margin-left: 4px; }
    td.${PITCH_COL_CLASS} .ref-sending { margin-left: 4px; }
    td.${PITCH_COL_CLASS} .ref-fail { color: #dc3545; margin-left: 4px; }
    /* štítky vzhledem stejné jako "✓ Check all": rámeček, bez pozadí */
    .dc-mode-badge, .dc-ref-no-referees-badge {
      display: inline-block; margin-left: 8px; padding: 2px 8px;
      border: 1px solid currentColor; border-radius: 4px; background: transparent;
      font-size: 12px; font-weight: bold; white-space: nowrap; user-select: none;
    }
    .dc-mode-badges { display: inline; }
    .dc-mode-badge.mode-scan   { color: #1565c0; }
    .dc-mode-badge.mode-manual { color: #c25e00; }
    .dc-mode-badge.mode-skip   { color: #888; }
    .dc-ref-no-referees-badge  { color: #FF0046; }

    tr.dc-mode-skip-row { opacity: 0.55; }
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

  const sportOfLabel = (tr) => (tr.querySelector('a[href^="/jsx/data/sport"]')?.textContent || '').trim().toLowerCase();
  const isBaseball = (sport) => /baseball/.test(sport || '');

  function markFor(eventId, doneSetForColumn) {
    if (sendingSet.has(eventId)) return 'sending';
    if (failMap.has(eventId)) return 'fail';
    return doneSetForColumn.has(eventId) ? 'done' : '';
  }
  function markHtml(mark, eventId) {
    if (mark === 'done') return '<span class="ref-done" title="V tabulce Hotovo = TRUE">☑</span>';
    if (mark === 'sending') return '<span class="ref-sending" title="Zapisuji do tabulky…">⏳</span>';
    if (mark === 'fail') return `<span class="ref-fail" title="${esc(failMap.get(eventId))}">⚠</span>`;
    return '';
  }

  function renderCell(td, eventId, sport) {
    const name = refMap.get(eventId);
    const clickable = !isBaseball(sport);   // u baseballu se rozhodčí nedoplňují
    const mark = markFor(eventId, doneSet);
    const key = `${status}|${name || ''}|${mark}|${clickable}`;
    if (td.dataset.key === key) return;
    td.dataset.key = key;
    let html;
    if (status === 'loading' && !refMap.size) html = '<span class="ref-no">…</span>';
    else if (name && clickable) html = `<span class="ref-yes ref-link" title="Kliknutím otevřeš Lineups a doplníš rozhodčího: ${esc(name)}">${esc(name)}</span>`;
    else if (name) html = `<span class="ref-yes" title="U baseballu se rozhodčí nedoplňují">${esc(name)}</span>`;
    else html = '<span class="ref-no" title="Rozhodčí v tabulce není">—</span>';
    td.innerHTML = html + markHtml(mark, eventId);
  }

  function renderPitchHeader(th) {
    const icon = pStatus === 'loading' ? '⏳' : (pStatus === 'ok' ? '⟳' : '⚠');
    const key = `${pStatus}|${pStatusMsg}`;
    if (th.dataset.key === key) return;
    th.dataset.key = key;
    th.innerHTML = `<span class="ws-nowrap">Pitchers</span>` +
      `<span class="ref-reload ${pStatus === 'ok' || pStatus === 'loading' ? '' : 'ref-err'}" title="${esc(pStatusMsg || 'Načíst znovu')}">${icon}</span>`;
  }

  function renderPitchCell(td, eventId, sport) {
    const p = pitcherMap.get(eventId);
    const mark = p ? markFor(eventId, pitcherDone) : '';
    const key = `${pStatus}|${p ? p.home + '|' + p.away : ''}|${mark}|${isBaseball(sport)}`;
    if (td.dataset.key === key) return;
    td.dataset.key = key;
    if (!p) {
      td.innerHTML = isBaseball(sport) ? '<span class="ref-no" title="Zápas v listu s pitchery není">—</span>' : '';
      return;
    }
    const line = (label, who, name) => `<div><span class="p-lb">${label}</span>` + (name
      ? `<span class="ref-yes ref-link" title="Kliknutím otevřeš Lineups a doplníš pitchery (${who}: ${esc(name)})">${esc(name)}</span>`
      : '<span class="ref-no">—</span>') + '</div>';
    td.innerHTML = line('D', 'domácí', p.home).replace('</div>', markHtml(mark, eventId) + '</div>') + line('H', 'hosté', p.away);
  }

  function placeAfter(parent, prev, tag, cls) {
    let el = parent.querySelector(`:scope > ${tag}.${cls}`);
    if (!el || el.previousElementSibling !== prev) {
      if (el) el.remove();
      el = document.createElement(tag);
      el.className = cls;
      prev.after(el);
    }
    return el;
  }

  function apply() {
    const table = document.getElementById('dlist_table');
    if (!table) return;
    const headRow = table.querySelector('thead tr');
    const epsTh = headRow && headRow.querySelector('th[id*="_ch_eps_"]');
    if (!epsTh) return;

    const rows = [];
    let sport = '';
    table.querySelectorAll('#dlist_table_tbody > tr').forEach((tr) => {
      if (tr.classList.contains('group-label')) { sport = sportOfLabel(tr); return; }
      if (/^dlist_table_row_\d+$/.test(tr.id) && tr.dataset.id) rows.push({ tr, sport });
    });
    // sloupec Pitchers jen když je na stránce baseball nebo zápas z listu pitcherů
    const needPitch = rows.some((r) => isBaseball(r.sport) || pitcherMap.has(r.tr.dataset.id));

    const th = placeAfter(headRow, epsTh, 'th', COL_CLASS);
    renderHeader(th);
    if (needPitch) renderPitchHeader(placeAfter(headRow, th, 'th', PITCH_COL_CLASS));
    else headRow.querySelector(`:scope > th.${PITCH_COL_CLASS}`)?.remove();

    rows.forEach(({ tr, sport: rowSport }) => {
      const eventId = tr.dataset.id;
      const epsTd = tr.querySelector('.rh-event-participants')?.closest('td');
      if (!epsTd) return;
      const td = placeAfter(tr, epsTd, 'td', COL_CLASS);
      renderCell(td, eventId, rowSport);
      if (needPitch) renderPitchCell(placeAfter(tr, td, 'td', PITCH_COL_CLASS), eventId, rowSport);
      else tr.querySelector(`:scope > td.${PITCH_COL_CLASS}`)?.remove();
    });
  }

  // --- zápis Hotovo = TRUE po kliknutí na Check ------------------------------
  const failMap = new Map();     // DC ID -> chybová hláška
  let queue = new Set();
  let flushTimer = null;

  function queueDone(eventId) {
    // zápas není v žádném listu / všude už je hotovo
    const needsRef = sheetIds.has(eventId) && !doneSet.has(eventId);
    const needsPitch = pitcherIds.has(eventId) && !pitcherDone.has(eventId);
    if (!needsRef && !needsPitch) return;
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
        (json.updated || []).forEach((id) => {
          sendingSet.delete(id);
          if (sheetIds.has(id)) doneSet.add(id);
          if (pitcherIds.has(id)) pitcherDone.add(id);
        });
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
    // ⟳ u rozhodčích i u pitcherů načte znovu oba listy najednou
    if (!e.target.closest(`th.${COL_CLASS} .ref-reload, th.${PITCH_COL_CLASS} .ref-reload`)) return;
    e.preventDefault(); e.stopPropagation();
    if (status === 'nourl') { askSheetUrl(); return; }   // askSheetUrl načte oba listy
    loadSheet();
    loadPitchers(); loadCompetitions();
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
    baseball:       0,   // u baseballu se rozhodčí nedoplňují (jen pitcheři přes sloupec Pitchers)
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
    const psId = (row.matches?.('.participant-select') ? row.id : row.querySelector('.participant-select')?.id) || null;
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

  async function searchByName(query, submit = true) {
    const input = await waitFor(() => {
      const el = getDatalistRoot()?.querySelector(NAME_FILTER_SELECTOR);
      return el && isRendered(el) ? el : null;
    }, 5000, 100);
    if (!input) { log('search field not found – search manually'); return false; }

    log(`${submit ? 'searching' : 'filtering'} "${query}"`);
    input.focus();
    armAutoPick('script');                 // stav seznamu PŘED hledáním
    setNativeValue(input, query);
    await sleep(150);
    if (submit) submitSearch(input, false);
    return true;
  }

  const findSearchInput = () => {
    const el = getDatalistRoot()?.querySelector(NAME_FILTER_SELECTOR);
    return el && isRendered(el) ? el : null;
  };

  // Odeslat hledání (tlačítko Search, jinak Enter) = globální hledání
  function submitSearch(input, rearm) {
    if (rearm) armAutoPick('script');
    const root = getDatalistRoot();
    const btn = root && Array.from(root.querySelectorAll('button')).find((b) =>
      isRendered(b) && (b.getAttribute('data-test-id') === 'datalist-controls-search-button' || /^search\b/i.test(b.textContent.trim())));
    if (btn) fireClickSequence(btn); else pressEnter(input);
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
    return String(raw || '').trim().split(/\s+/).filter((tok) => tok && !isTitle(tok)).join(' ');
  }

  // Víc rozhodčích v jedné buňce: oddělovač je čárka, středník, | nebo nový řádek.
  // Část, ve které po odstranění titulů nic nezbude (", BA", ", MSc"), se zahodí,
  // takže "Christian-Petru Ciochirca , BA" je pořád jeden rozhodčí, ale
  // "Aleksandar Radonjic, Jakub Izak, Rúben Györfy" jsou tři.
  const splitNames = (cell) => String(cell || '').split(/\s*(?:,|;|\||\n)\s*/).map(cleanName).filter(Boolean);
  const surnameOf = (name) => { const parts = name.trim().split(/\s+/); return parts.length > 1 ? parts[parts.length - 1] : null; };

  // ── Postupné vyplnění slotů ─────────────────────────────────────────────────
  async function openSearchesSequentially(slots, names, alive) {
    let changed = false;   // vyplnil tento běh aspoň jeden slot?
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
      changed = true;
      await sleep(AFTER_SELECTION_WAIT_MS);
    }

    // Všichni rozhodčí už byli doplnění předem → nic neukládat, soupiska zůstane otevřená
    if (!changed) { log('all referee slots already filled – nothing to save'); return; }

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
    if (refereeCount === 0) { log('referees are not filled for this sport'); return; }
    if (names.length > refereeCount) log(`${names.length} names in the sheet, but the sport needs ${refereeCount} – extra names ignored`);
    const refs = await ensureRefereeRows(refereeCount, alive, formationsBefore);
    if (!alive()) return;
    if (!refs.length) { log('no referee rows found, aborting'); return; }
    await openSearchesSequentially(refereeCount, names, alive);
  }

  // ===========================================================================
  // LINEUPS – PITCHEŘI (BASEBALL)
  // Klik na jméno ve sloupci Pitchers: otevře Lineups, v soupisce domácích i hostů
  // vezme řádek Pitchera (když soupiska prázdná, přidá 1 položku přes "Add items" –
  // první pozice je vždy Pitcher), vepíše jméno → nejdřív se filtrují hráči týmu,
  // když nikdo neodpovídá, spustí se globální hledání (pak případně jen příjmení).
  // Jediný odpovídající výsledek se vybere sám. Uloží se, až jsou doplnění oba.
  // ===========================================================================
  const PITCHER_POSITION_VALUE = '50';   // "- Lineup Position -" → Pitcher

  function instanceRootOf(el) {
    let n = el;
    while (n && !(n.id && /^cml_instance_\d+$/.test(n.id))) n = n.parentElement;
    return n;
  }

  // Řádky soupisky týmu: div.lineup-line (každý s vlastním participant-select)
  function lineupRows(instId, side) {
    const box = document.getElementById(`${instId}_epl_${side}`);
    if (!box) return [];
    return Array.from(box.querySelectorAll('.participant-select'))
      .map((ps) => ps.closest('.lineup-line') || ps.closest('.lineup-item-row') || ps);
  }

  const positionSelect = (row) => row.querySelector('select[id$="_position"]');
  const isPitcherRow = (row) => {
    const sel = positionSelect(row);
    return !!sel && (sel.value === PITCHER_POSITION_VALUE || sel.options[sel.selectedIndex]?.textContent.trim() === 'Pitcher');
  };

  const pitcherRow = (instId, side) => lineupRows(instId, side).find(isPitcherRow) || null;

  // počkat, až se dotáhnou i soupisky týmů (ne jen sekce Officials)
  async function waitForLineupContent(inst, alive) {
    let lastSig = null, stableSince = Date.now();
    return waitFor(() => {
      if (!alive()) return 'aborted';
      if (!document.getElementById(`${inst.id}_epl_home_control_panel`)) return null;
      const sig = `${inst.querySelectorAll('.participant-select').length}|${inst.textContent.length}`;
      if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); return null; }
      if (inst.querySelector('.ant-spin[aria-busy="true"], .ant-spin-spinning')) { stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= LINEUP_STABLE_MS ? true : null;
    }, LINEUP_LOAD_TIMEOUT_MS, 150);
  }

  async function addLineupItem(instId, side) {
    const count = document.getElementById(`${instId}_epl_${side}_control_panel_add_count`);
    if (count && count.value !== '1') {
      count.value = '1';
      count.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
    }
    const add = document.querySelector(`[data-action-id="${instId}_epl_${side}_control_panel-doAddItems-click"]`);
    if (!add) return false;
    fireClickSequence(add);
    return !!(await waitFor(() => lineupRows(instId, side).length > 0 || null, 5000, 100));
  }

  async function fillPitcher(instId, side, rawName, alive) {
    const name = splitNames(rawName)[0] || '';   // jedno jméno, bez titulů (i za čárkou)
    if (!name) return 'skip';
    let row = pitcherRow(instId, side);
    if (!row) {
      if (lineupRows(instId, side).length) {
        log(`${side}: lineup already has players but no Pitcher – fill it manually`);
        return 'fail';
      }
      log(`${side}: empty lineup, adding 1 item`);
      for (let attempt = 1; attempt <= ADD_ROW_ATTEMPTS && !lineupRows(instId, side).length; attempt++) {
        await addLineupItem(instId, side);
        await sleep(300);
      }
      const first = lineupRows(instId, side)[0];
      if (!first) { log(`${side}: could not add a lineup row`); return 'fail'; }
      // první položka je v DC vždy Pitcher – kdyby ne, nastavit pozici
      const sel = positionSelect(first);
      if (sel && !isPitcherRow(first) && Array.from(sel.options).some((o) => o.value === PITCHER_POSITION_VALUE)) {
        log(`${side}: setting position to Pitcher`);
        sel.value = PITCHER_POSITION_VALUE;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(AFTER_ADD_ROW_WAIT_MS);
      }
      row = pitcherRow(instId, side) || lineupRows(instId, side)[0];
    }
    if (!isRowEmpty(row)) { log(`${side}: pitcher already filled, skipping`); return 'skip'; }
    if (!row.querySelector(SEARCH_TRIGGER_SELECTOR)) { log(`${side}: no search trigger in the pitcher row`); return 'fail'; }

    resetAutoPick();
    await openSearchForRow(row, 0);
    await searchByName(name, false);       // jen filtr předvyplněných hráčů týmu
    let submitted = false, fallbackTried = false;

    const filled = await waitFor(() => {
      if (!alive()) return 'aborted';
      const result = autoPickTick();
      if (result === 'none') {
        const input = findSearchInput();
        if (!submitted && input) {
          submitted = true;
          log(`${side}: "${name}" not among team players, searching globally`);
          submitSearch(input, true);
        } else if (submitted && !fallbackTried && SURNAME_FALLBACK) {
          fallbackTried = true;
          const surname = surnameOf(name);
          if (surname) { log(`${side}: no result for "${name}", trying "${surname}"`); searchByName(surname, true); }
        }
      }
      const r = pitcherRow(instId, side);
      return r && !isRowEmpty(r) ? true : null;
    }, SELECTION_TIMEOUT_MS, POLL_INTERVAL_MS);

    if (filled === 'aborted') return 'aborted';
    if (!filled) { log(`${side}: timeout waiting for the pitcher`); return 'fail'; }
    log(`${side}: pitcher filled`);
    await sleep(AFTER_SELECTION_WAIT_MS);
    return 'filled';
  }

  async function openPitcherFill(clickedIcon, names, formationsBefore) {
    const run = ++currentRun;            // nové otevření Lineups ukončí předchozí běh
    const alive = () => run === currentRun;
    pinnedFormation = null;
    const formation = await waitForFreshLineup(formationsBefore, alive);
    if (!alive()) return;
    if (!formation) { log('lineup not found'); return; }
    pinnedFormation = formation;
    const inst = instanceRootOf(formation);
    if (!inst) { log('lineup instance not found'); return; }
    if ((await waitForLineupContent(inst, alive)) !== true) return;

    let changed = false;
    for (const side of ['home', 'away']) {
      if (!names[side]) continue;
      const result = await fillPitcher(inst.id, side, names[side], alive);
      if (result === 'aborted' || !alive()) return;
      if (result === 'fail') { log(`NOT saving – ${side} pitcher not filled`); return; }
      if (result === 'filled') changed = true;
    }
    if (!changed) { log('pitchers already filled, nothing to save'); return; }
    await sleep(200);
    const btn = Array.from(inst.querySelectorAll(SAVE_BTN_SELECTOR)).find((el) => el.offsetParent !== null);
    if (btn) { log('clicking Save'); btn.click(); } else clickSave();
  }

  // Akce pro nejbližší klik na Lineups (nastaví ji klik na jméno ve sloupci):
  // { type: 'referees', names } | { type: 'pitchers', home, away }
  let pendingLineupAction = null;

  document.addEventListener('click', (event) => {
    const icon = event.target.closest?.(LINEUPS_ICON_SELECTOR);
    if (!icon) return;
    const action = pendingLineupAction;
    pendingLineupAction = null;
    // snímek soupisek, které jsou vidět PŘED tím, než DC na klik zareaguje
    const formationsBefore = new Set(visibleFormations());
    if (action && action.type === 'pitchers') openPitcherFill(icon, action, formationsBefore);
    else openRefereeSearch(icon, (action && action.names) || [], formationsBefore);
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
    pendingLineupAction = { type: 'referees', names: splitNames(name) };
    fireClickSequence(icon);
  }, true);

  // Klik na pitchera ve sloupci Pitchers → otevřít Lineups a doplnit oba pitchery
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.(`td.${PITCH_COL_CLASS} .ref-link`);
    if (!link) return;
    e.preventDefault(); e.stopPropagation();
    const tr = link.closest('tr[id^="dlist_table_row_"]');
    const p = tr && pitcherMap.get(tr.dataset.id);
    const icon = tr && tr.querySelector(LINEUPS_ICON_SELECTOR);
    if (!p || !icon) { log('Lineups icon or pitchers not found for this row'); return; }
    pendingLineupAction = { type: 'pitchers', home: p.home, away: p.away };
    fireClickSequence(icon);
  }, true);


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

  // ===========================================================================
  // ŠTÍTKY ZPRACOVÁNÍ SOUTĚŽE (list Soutěže): Scan / Ruční skript / Neřešit
  // Soutěž, která v listu není, zůstane beze štítku. "Neřešit" = v listu je,
  // ale nemá "ano" ani u Scan, ani u Ruční skript → skupina se ztlumí.
  // ===========================================================================
  const ROW_LOOK = {
    'dc-mode-row-scan':   { bg: 'rgba(21, 101, 192, 0.1)', bar: 'inset 4px 0 0 #1565c0' },
    'dc-mode-row-manual': { bg: 'rgba(230, 120, 0, 0.12)', bar: 'inset 4px 0 0 #c25e00' },
    'dc-mode-row-both':   { bg: 'linear-gradient(90deg, rgba(21, 101, 192, 0.12), rgba(230, 120, 0, 0.14))', bar: 'inset 4px 0 0 #1565c0' },
    'dc-mode-row-skip':   { bg: 'rgba(0, 0, 0, 0.04)', bar: 'inset 4px 0 0 #bbb' },
  };

  function annotateCompetitionModes() {
    document.querySelectorAll('tr.group-label').forEach((labelTr) => {
      const tplLink = labelTr.querySelector('[id$="_path_rh_tournament_template_0"] a');
      const stage = labelTr.querySelector('[id$="_path_rh_tournament_stage_0"]');
      const pathContainer = (stage || tplLink?.closest('span'))?.parentElement;
      if (!tplLink || !pathContainer) return;

      const id = (tplLink.getAttribute('title') || '').replace(/\D/g, '');
      const mode = compMap.get(id);
      const skip = !!mode && !mode.scan && !mode.manual;
      const key = mode ? `${mode.scan}|${mode.manual}` : '';

      // štítky
      const boxes = Array.from(pathContainer.querySelectorAll(':scope > .dc-mode-badges'));
      boxes.slice(1).forEach((extra) => extra.remove());
      let box = boxes[0];
      if (!mode) { if (box) box.remove(); }
      else {
        if (!box) { box = document.createElement('span'); box.className = 'dc-mode-badges'; }
        // umístit hned za "Check all" (nebo za breadcrumb), před "Bez rozhodčích"
        const after = pathContainer.querySelector(':scope > .' + BADGE_CLASS) || stage || tplLink.closest('span');
        if (box.previousElementSibling !== after) after.after(box);
        if (box.dataset.key !== key) {
          box.dataset.key = key;
          box.innerHTML =
            (mode.scan ? '<span class="dc-mode-badge mode-scan" title="Zpracovává se přes Scan">Scan</span>' : '') +
            (mode.manual ? '<span class="dc-mode-badge mode-manual" title="Zpracovává se ručním scriptem">Ruční skript</span>' : '') +
            (skip ? '<span class="dc-mode-badge mode-skip" title="Soutěž se neřeší">Neřešit</span>' : '');
        }
      }

      // obarvení hlavičky podle zpracování
      const rowCls = !mode ? '' : skip ? 'dc-mode-row-skip'
        : mode.scan && mode.manual ? 'dc-mode-row-both' : mode.scan ? 'dc-mode-row-scan' : 'dc-mode-row-manual';
      ['dc-mode-row-scan', 'dc-mode-row-manual', 'dc-mode-row-both', 'dc-mode-row-skip'].forEach((c) => {
        if (labelTr.classList.contains(c) !== (c === rowCls)) labelTr.classList.toggle(c, c === rowCls);
      });
      // barva se dává přímo na buňku hlavičky (celá výška řádku DC i s odsazením),
      // inline s !important, aby ji styly DC nepřebily
      const cell = labelTr.querySelector(':scope > td');
      if (cell) {
        const look = ROW_LOOK[rowCls] || null;
        // prohlížeč hodnoty normalizuje (rgba → rgb…), proto se změna pozná podle
        // uloženého klíče + toho, jestli tam !important pořád je (ne porovnáním textu)
        const setImp = (el, prop, val) => {
          if (val == null) { if (el.style.getPropertyValue(prop)) el.style.removeProperty(prop); return; }
          const same = el.dataset.dcLook === rowCls && el.style.getPropertyPriority(prop) === 'important';
          if (!same) el.style.setProperty(prop, val, 'important');
        };
        setImp(cell, 'background', look && look.bg);
        setImp(cell, 'box-shadow', look && look.bar);
        const inner = cell.querySelector('.list-header-row');
        if (inner) setImp(inner, 'background', look ? 'transparent' : null);   // ať nepřekrývá barvu buňky
        if (cell.dataset.dcLook !== rowCls) { if (rowCls) cell.dataset.dcLook = rowCls; else delete cell.dataset.dcLook; }
        if (inner && inner.dataset.dcLook !== rowCls) { if (rowCls) inner.dataset.dcLook = rowCls; else delete inner.dataset.dcLook; }
      }

      // ztlumení skupiny "Neřešit"
      let el = labelTr;
      while (el) {
        if (el !== labelTr && el.classList.contains('group-label')) break;
        if (el.classList.contains('dc-mode-skip-row') !== skip) el.classList.toggle('dc-mode-skip-row', skip);
        el = el.nextElementSibling;
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
      annotateCompetitionModes();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });

  apply();
  scanBulkBadges();
  annotateNoRefereeTournaments();
  annotateCompetitionModes();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { scanBulkBadges(); annotateNoRefereeTournaments(); annotateCompetitionModes(); }, 1500);   // pojistka, kdyby observer něco propásl
  loadSheet();
  loadPitchers(); loadCompetitions();
  setInterval(() => { loadSheet(); loadPitchers(); loadCompetitions(); }, REFRESH_MINUTES * 60 * 1000);
})();
