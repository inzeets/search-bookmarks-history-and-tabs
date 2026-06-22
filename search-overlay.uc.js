// ==UserScript==
// @name            Unified Search Overlay
// @include         main
// ==/UserScript==

// Searches bookmarks, history, and tabs using Firefox's native PlacesUtils APIs.
// No extension dependency.
// Shortcut: Alt+B

(function unifiedSearch() {
    'use strict';

    // Clean up any previous instance so reloading from the script manager works
    window._us?.destroy();

    const doc = window.document;
    const SHORTCUT = { key: 'b', alt: true, ctrl: false, shift: false };

    // ── Styles ──────────────────────────────────────────────────────────

    const style = doc.createElement('style');
    style.textContent = `
        #us-overlay {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(0, 0, 0, 0.55);
            align-items: center;
            justify-content: center;
        }
        #us-overlay.open { display: flex; }

        #us-box {
            width: 900px;
            height: 500px;
            display: flex;
            flex-direction: column;
            background: #040c10;
            color: #e1e1e1;
            font-family: "Segoe UI", sans-serif;
            font-size: 14px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.8);
            border: 2px solid #3c2711;
            border-radius: 5px;
        }

        #us-search {
            flex: 0 0 auto;
            appearance: none;
            -moz-appearance: none;
            border: none;
            outline: none;
            background: #040c10;
            color: #ffcf8a;
            font-family: inherit;
            font-size: 15px;
            padding: 4px 8px;
        }

        #us-scroll { flex: 1; overflow-y: scroll; }

        #us-table {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
            white-space: nowrap;
        }

        #us-table td {
            padding: 3px 0;
            cursor: default;
            user-select: none;
            overflow: hidden;
        }

        /* type stripe */
        #us-table td:nth-child(1) { width: 4px; padding: 0; }
        /* favicon */
        #us-table td:nth-child(2) { width: 16px; padding-left: 7px; padding-right: 7px; }
        #us-table td:nth-child(2) img { width: 16px; height: 16px; display: block; }
        #us-table td:nth-child(2):empty::before {
            content: '';
            display: block;
            width: 16px; height: 16px;
            border-radius: 3px;
            background: #393939;
        }

        /* title cell */
        #us-table td:nth-child(3) { width: 45%; padding-left: 2px; }
        .us-cell-flex {
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
        }
        .us-title-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .us-time-badge {
            flex-shrink: 0;
            font-size: 11px;
            padding: 1px 5px 2px;
            border-radius: 3px;
            white-space: nowrap;
            line-height: 1.4;
            background: #0c1f0c;
            color: #7ac850;
        }

        /* url cell */
        #us-table td:nth-child(4) { color: #888; font-size: 13px; }
        .us-url-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .us-badges {
            flex-shrink: 0;
            display: flex;
            gap: 3px;
            align-items: center;
        }
        .us-tag-badge {
            font-size: 11px;
            padding: 1px 5px 2px;
            border-radius: 3px;
            white-space: nowrap;
            line-height: 1.4;
            background: #0c1826;
            color: #557a99;
        }
        .us-tag-match  { color: #5dc8f5; font-weight: 600; }
        .us-tag-rest   { color: #557a99; }
        .us-text-match { color: #ffcf8a; font-weight: 600; }

        #us-table tr.sel { background: #3c2711; color: #ffcf8a; text-shadow: 0 0 2px #000; }
        #us-table tr.sel td:nth-child(4) { color: #c8a060; }
        #us-table tr.sel .us-time-badge  { background: #1a3a0d; color: #a0e060; }
        #us-table tr.sel .us-tag-badge   { background: #0c1e30; }
        #us-table tr.sel .us-tag-rest    { color: #7aaabb; }

        .us-tab      td:nth-child(1) { background: #ffffff55; }
        .us-bookmark td:nth-child(1) { background: #44aa4488; }
        .us-history  td:nth-child(1) { background: #2f7cce88; }
    `;
    doc.head.appendChild(style);

    // ── DOM ─────────────────────────────────────────────────────────────

    const overlay = doc.createElement('div');
    overlay.id = 'us-overlay';

    const box = doc.createElement('div');
    box.id = 'us-box';

    const searchEl = doc.createElement('input');
    searchEl.id = 'us-search';
    searchEl.setAttribute('autocomplete', 'off');
    searchEl.setAttribute('spellcheck', 'false');
    searchEl.placeholder = 'Search all  |  t: tabs  b: bookmarks  h: history  #tag  ~folder';

    const scrollEl = doc.createElement('div');
    scrollEl.id = 'us-scroll';

    const table = doc.createElement('table');
    table.id = 'us-table';
    const tbody = doc.createElement('tbody');
    table.appendChild(tbody);
    scrollEl.appendChild(table);
    box.append(searchEl, scrollEl);
    overlay.appendChild(box);
    doc.documentElement.appendChild(overlay);

    // ── State ────────────────────────────────────────────────────────────

    let shownItems = [];
    let selIndex  = 0;

    // ── Query parsing ────────────────────────────────────────────────────
    // t <term>         → tabs only
    // b <term>         → bookmarks only
    // h <term>         → history only
    // #scr #ff ...     → bookmarks filtered by ALL tag terms (multi-tag AND)
    // ~folder          → bookmarks filtered by folder
    // (none)           → all sources

    function parseQuery(raw) {
        const q = raw.trimStart();

        // Mode prefixes take priority
        const prefixes = [['t ', 'tabs'], ['b ', 'bookmarks'], ['h ', 'history']];
        for (const [prefix, mode] of prefixes) {
            if (q.startsWith(prefix)) {
                const rest = q.slice(prefix.length).trim();
                const hi = rest.indexOf('#');
                if (hi !== -1) {
                    const textTerm = rest.slice(0, hi).trim();
                    const tagTerms = rest.slice(hi + 1).split(/\s+/)
                        .map(s => s.replace(/^#/, '')).filter(Boolean);
                    return { mode, term: tagTerms[0] || textTerm, tagTerms, textTerm };
                }
                return { mode, term: rest, tagTerms: [], textTerm: rest };
            }
        }
        if (q.startsWith('~')) return { mode: 'folders', term: q.slice(1), tagTerms: [], textTerm: '' };

        // Everything before the first '#' is the text term;
        // everything from '#' onward (space-separated) are tag terms.
        const hashIdx = q.indexOf('#');
        if (hashIdx !== -1) {
            const textTerm = q.slice(0, hashIdx).trim();
            const tagTerms = q.slice(hashIdx + 1).split(/\s+/)
                .map(s => s.replace(/^#/, '')).filter(Boolean);
            return { mode: 'tags', term: tagTerms[0] || '', tagTerms, textTerm };
        }
        return { mode: 'all', term: q, tagTerms: [], textTerm: q };
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function relativeTime(ms) {
        const s = (Date.now() - ms) / 1000;
        if (s < 90)      return 'now';
        if (s < 3600)    return Math.floor(s / 60)    + 'm';
        if (s < 86400)   return Math.floor(s / 3600)  + 'h';
        if (s < 604800)  return Math.floor(s / 86400) + 'd';
        if (s < 2592000) return Math.floor(s / 604800) + 'w';
        return                  Math.floor(s / 2592000) + 'mo';
    }

    // Extracts ['javascript', 'react'] from "My Page #javascript #react"
    function extractTags(title) {
        const tags = [];
        const parts = title.split(' #');
        for (let i = 1; i < parts.length; i++) {
            const tag = parts[i].split(/\s/)[0].trim();
            if (tag && !/^\d/.test(tag)) tags.push(tag);
        }
        return tags;
    }

    function stripTags(title) {
        return title.replace(/\s#[^\s]+/g, '').trim();
    }

    // Badge with the matched portion of the tag highlighted.
    // tagTerms: array of search terms to match against this tag (indexOf, any of them).
    function makeTagBadge(tag, tagTerms) {
        const span = doc.createElement('span');
        span.className = 'us-tag-badge';

        const matchTerm = tagTerms.find(tt => tt && tag.toLowerCase().includes(tt.toLowerCase()));

        span.appendChild(doc.createTextNode('#'));

        if (matchTerm) {
            const idx  = tag.toLowerCase().indexOf(matchTerm.toLowerCase());
            const pre  = tag.slice(0, idx);
            const hit  = tag.slice(idx, idx + matchTerm.length);
            const post = tag.slice(idx + matchTerm.length);
            if (pre)  { const s = doc.createElement('span'); s.className = 'us-tag-rest';  s.textContent = pre;  span.appendChild(s); }
            const m = doc.createElement('span'); m.className = 'us-tag-match'; m.textContent = hit; span.appendChild(m);
            if (post) { const s = doc.createElement('span'); s.className = 'us-tag-rest';  s.textContent = post; span.appendChild(s); }
        } else {
            span.appendChild(doc.createTextNode(tag));
        }
        return span;
    }

    // Returns a span with `term` highlighted inside `text`, or plain text node if no match.
    function makeHighlighted(text, term) {
        if (!term) return doc.createTextNode(text);
        const idx = text.toLowerCase().indexOf(term.toLowerCase());
        if (idx === -1) return doc.createTextNode(text);
        const frag = doc.createDocumentFragment();
        if (idx > 0) frag.appendChild(doc.createTextNode(text.slice(0, idx)));
        const m = doc.createElement('span');
        m.className = 'us-text-match';
        m.textContent = text.slice(idx, idx + term.length);
        frag.appendChild(m);
        if (idx + term.length < text.length) frag.appendChild(doc.createTextNode(text.slice(idx + term.length)));
        return frag;
    }

    // ── Search ───────────────────────────────────────────────────────────

    async function runSearch(query) {
        const { mode, term, tagTerms, textTerm } = parseQuery(query);
        const t = term.toLowerCase();
        const tt = textTerm.toLowerCase();
        const results = [];

        // ── Tabs ────────────────────────────────────────────────────────
        if (mode === 'all' || mode === 'tabs') {
            // Build URL→tags map so bookmarked tabs show their tags
            const urlTagsMap = new Map();
            try {
                const allBmarks = await PlacesUtils.bookmarks.search(
                    { type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
                );
                for (const b of allBmarks) {
                    if (!b.url) continue;
                    const bUrl  = b.url.href || String(b.url);
                    const bTags = extractTags(b.title || '');
                    if (bTags.length) urlTagsMap.set(bUrl, bTags);
                }
            } catch (ex) { Cu.reportError('[us] urlTagsMap: ' + ex); }

            const wins = Services.wm.getEnumerator('navigator:browser');
            while (wins.hasMoreElements()) {
                const w = wins.getNext();
                if (w.closed) continue;
                for (const tab of w.gBrowser.tabs) {
                    if (tab.hidden) continue;
                    const tabUrl = tab.linkedBrowser?.currentURI?.spec || '';
                    const title  = (tab.label || '').toLowerCase();
                    const url    = tabUrl.toLowerCase();
                    const tags   = urlTagsMap.get(tabUrl) || [];
                    // Text filter (only textTerm, not tag term)
                    if (tt && !title.includes(tt) && !url.includes(tt)) continue;
                    // Tag filter
                    if (tagTerms.length > 0) {
                        const allMatch = tagTerms.every(tagT =>
                            tags.some(tag => tag.toLowerCase().includes(tagT.toLowerCase()))
                        );
                        if (!allMatch) continue;
                    }
                    results.push({
                        type:         'tab',
                        title:        tab.label || '',
                        url:          tabUrl,
                        favicon:      tab.image || '',
                        lastAccessed: tab.lastAccessed || 0,
                        tags,
                        _tab: tab, _win: w,
                    });
                }
            }
        }

        // ── Bookmarks ───────────────────────────────────────────────────
        if (mode === 'all' || mode === 'bookmarks' || mode === 'tags' || mode === 'folders') {
            try {
                // Search with the first term; then AND-filter by remaining tag terms in JS
                const searchStr = mode === 'tags'    ? '#' + tagTerms[0]
                                                                                : mode === 'folders' ? '~' + term
                                                                                : term;
                const bmarks = await PlacesUtils.bookmarks.search(
                    searchStr || { type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
                );
                for (const b of bmarks) {
                    if (b.type !== PlacesUtils.bookmarks.TYPE_BOOKMARK || !b.url) continue;
                    const url  = b.url.href || String(b.url);
                    const tags = extractTags(b.title || '');
                    // For tags mode: bookmark must satisfy ALL tag terms
                    if (mode === 'tags') {
                        const allMatch = tagTerms.every(tagT =>
                            tags.some(tag => tag.toLowerCase().includes(tagT.toLowerCase()))
                        );
                        if (!allMatch) continue;
                        // Also filter by textTerm if present
                        if (tt) {
                            const titleL = (b.title || '').toLowerCase();
                            const urlL   = url.toLowerCase();
                            if (!titleL.includes(tt) && !urlL.includes(tt)) continue;
                        }
                    }
                    results.push({
                        type:         'bookmark',
                        title:        stripTags(b.title || url),
                        url,
                        favicon:      `page-icon:${url}`,
                        lastAccessed: b.lastModified ? b.lastModified.getTime() : 0,
                        tags,
                    });
                }
            } catch (ex) { Cu.reportError('[us] bookmarks: ' + ex); }
        }

        // ── History ─────────────────────────────────────────────────────
        if (mode === 'all' || mode === 'history') {
            try {
                const histQuery = PlacesUtils.history.getNewQuery();
                if (t) histQuery.searchTerms = t;
                const opts = PlacesUtils.history.getNewQueryOptions();
                opts.maxResults = t ? 50 : 30;
                opts.sortingMode = t
                    ? Ci.nsINavHistoryQueryOptions.SORT_BY_VISITCOUNT_DESCENDING
                    : Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING;
                const { root } = PlacesUtils.history.executeQuery(histQuery, opts);
                root.containerOpen = true;
                for (let i = 0; i < root.childCount; i++) {
                    const node = root.getChild(i);
                    if (!node.uri) continue;
                    results.push({
                        type:         'history',
                        title:        node.title || node.uri,
                        url:          node.uri,
                        favicon:      `page-icon:${node.uri}`,
                        lastAccessed: node.time ? node.time / 1000 : 0,
                        tags:         [],
                    });
                }
                root.containerOpen = false;
            } catch (ex) { Cu.reportError('[us] history: ' + ex); }
        }

        results.sort((a, b) => b.lastAccessed - a.lastAccessed);
        render(results, tagTerms, textTerm);
    }

    // ── Render ───────────────────────────────────────────────────────────

    function render(items, tagTerms, textTerm) {
        shownItems = items;
        const frag = doc.createDocumentFragment();
        for (const item of items) {
            const tr = doc.createElement('tr');
            tr.className = 'us-' + item.type;

            // type stripe
            const typeTd = doc.createElement('td');

            // favicon
            const iconTd = doc.createElement('td');
            if (item.favicon && !item.favicon.startsWith('chrome://')) {
                const img = doc.createElement('img');
                img.src = item.favicon;
                img.addEventListener('error', () => img.setAttribute('data-broken', '1'));
                iconTd.appendChild(img);
            }

            // title cell: [title text .....] [time badge]
            const titleTd = doc.createElement('td');
            const titleFlex = doc.createElement('div');
            titleFlex.className = 'us-cell-flex';
            const titleSpan = doc.createElement('span');
            titleSpan.className = 'us-title-text';
            titleSpan.appendChild(makeHighlighted(item.title, textTerm));
            titleFlex.appendChild(titleSpan);
            if (item.lastAccessed) {
                const tb = doc.createElement('span');
                tb.className = 'us-time-badge';
                tb.textContent = relativeTime(item.lastAccessed);
                titleFlex.appendChild(tb);
            }
            titleTd.appendChild(titleFlex);

            // url cell: [url text .........] [#tag #tag]
            const urlTd = doc.createElement('td');
            const urlFlex = doc.createElement('div');
            urlFlex.className = 'us-cell-flex';
            const urlSpan = doc.createElement('span');
            urlSpan.className = 'us-url-text';
            urlSpan.appendChild(makeHighlighted(item.url, textTerm));
            urlFlex.appendChild(urlSpan);
            if (item.tags?.length) {
                const badges = doc.createElement('div');
                badges.className = 'us-badges';
                for (const tag of item.tags) {
                    badges.appendChild(makeTagBadge(tag, tagTerms));
                }
                urlFlex.appendChild(badges);
            }
            urlTd.appendChild(urlFlex);

            tr.append(typeTd, iconTd, titleTd, urlTd);
            frag.appendChild(tr);
        }
        tbody.textContent = '';
        tbody.appendChild(frag);
        select(0);
    }

    function select(i) {
        selIndex = Math.max(0, Math.min(i, shownItems.length - 1));
        for (const tr of tbody.rows) tr.classList.remove('sel');
        const row = tbody.rows[selIndex];
        if (!row) return;
        row.classList.add('sel');
        const rTop = row.offsetTop;
        const rBot = rTop + row.offsetHeight;
        if (rBot > scrollEl.scrollTop + scrollEl.clientHeight)
            scrollEl.scrollTop = rBot - scrollEl.clientHeight;
        else if (rTop < scrollEl.scrollTop)
            scrollEl.scrollTop = rTop;
    }

    // ── Actions ──────────────────────────────────────────────────────────

    function activate() {
        const item = shownItems[selIndex];
        if (!item) return;
        usClose();
        if (item.type === 'tab') {
            item._win.focus();
            item._win.gBrowser.selectedTab = item._tab;
        } else {
            openTrustedLinkIn(item.url, 'current');
        }
    }

    // ── Open / Close ─────────────────────────────────────────────────────

    function usOpen() {
        searchEl.value = '';
        overlay.classList.add('open');
        searchEl.focus();
        runSearch('');
    }

    function closeTab() {
        const item = shownItems[selIndex];
        if (!item || item.type !== 'tab') return;
        const saved = selIndex;
        item._win.gBrowser.removeTab(item._tab);
        shownItems = shownItems.filter(x => x !== item);
        // re-render keeping current query
        const fakeTagTerms = [];
        render(shownItems, fakeTagTerms, '');
        select(Math.min(saved, shownItems.length - 1));
        searchEl.focus();
    }

    function usClose() {
        overlay.classList.remove('open');
    }

    // ── Events ───────────────────────────────────────────────────────────

    searchEl.addEventListener('input', e => runSearch(e.target.value));

    tbody.addEventListener('click', e => {
        const tr = e.target.closest('tr');
        if (!tr) return;
        select(tr.rowIndex);
        activate();
    });

    overlay.addEventListener('keydown', e => {
        switch (e.key) {
            case 'ArrowDown': select(selIndex + 1);               e.preventDefault(); break;
            case 'ArrowUp':   select(selIndex - 1);               e.preventDefault(); break;
            case 'PageDown':  select(selIndex + 13);              e.preventDefault(); break;
            case 'PageUp':    select(Math.max(0, selIndex - 13)); e.preventDefault(); break;
            case 'Enter':     activate();                                              break;
            case 'Escape':    usClose();                                               break;
            case 'Delete':    closeTab();                          e.preventDefault(); break;
        }
    });

    overlay.addEventListener('mousedown', e => {
        if (e.target === overlay) usClose();
    });

    const _keyHandler = e => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
            usClose(); e.preventDefault(); return;
        }
        const k = e.key.toLowerCase();
        if (k === SHORTCUT.key &&
            e.altKey   === SHORTCUT.alt   &&
            e.ctrlKey  === SHORTCUT.ctrl  &&
            e.shiftKey === SHORTCUT.shift)
        {
            e.preventDefault();
            e.stopPropagation();
            overlay.classList.contains('open') ? usClose() : usOpen();
        }
    };
    window.addEventListener('keydown', _keyHandler, true);

    window._us = {
        destroy() {
            window.removeEventListener('keydown', _keyHandler, true);
            overlay.remove();
            style.remove();
            delete window._us;
        }
    };
})();
