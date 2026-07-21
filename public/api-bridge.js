// ===== Money Mate API Bridge =====
// Injected by server before the closing script tag of mockup/index.html.
// Shares the same script scope as the mockup — all mockup vars and functions
// are accessible here. Overrides key functions to add backend persistence.

(function () {
  var token = localStorage.getItem('moneymate_token');
  if (!token) { window.location.replace('/login'); return; }

  // ── Authenticated fetch helper ────────────────────────────────────────────────
  function apiFetch(url, opts) {
    return fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
    }, opts || {}));
  }

  // ── Build ISO month identifiers for API calls (mirrors server-side 15-month window) ─
  // MONTHS/MONTH_TAGS/monthIndex are already set correctly by the server at page-build time.
  var _SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var _now = new Date();
  var _dynIso = [];
  for (var _i = -11; _i <= 3; _i++) {
    var _d = new Date(_now.getFullYear(), _now.getMonth() + _i, 1);
    _dynIso.push(_d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0'));
  }
  var ISO_MONTHS = _dynIso;  // scoped to this IIFE; accessed by closures below

  // ── Override formatDateForDisplay to accept ISO YYYY-MM-DD from the server ────
  var _origFmt = formatDateForDisplay;
  formatDateForDisplay = function (s) {
    if (!s) return '';
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      return parseInt(m[3], 10) + ' ' + _SHORT[parseInt(m[2], 10) - 1] + ' ' + m[1];
    }
    return _origFmt(s);
  };

  // ── Bill-row DOM helpers ──────────────────────────────────────────────────────
  function createBillRow(t) {
    var row = document.createElement('div');
    row.className = 'bill-row';
    row.dataset.txnId = String(t.id);

    var dateEl = document.createElement('div');
    dateEl.className = 'bill-date';
    dateEl.textContent = formatDateForDisplay(t.date_str);

    var descEl = document.createElement('div');
    descEl.className = 'bill-merchant';
    descEl.textContent = t.merchant;

    var amtEl = document.createElement('div');
    amtEl.className = 'bill-amount' + (t.amount < 0 ? ' negative' : '');
    amtEl.textContent = (t.amount < 0 ? '-' : '+') + formatMoney(Math.abs(t.amount));

    row.appendChild(dateEl);
    row.appendChild(descEl);
    row.appendChild(amtEl);
    return row;
  }

  function placeBillRow(row, catId, subName) {
    var targetId = catId || 'cat-uncategorized';
    var catEl = document.getElementById(targetId) || document.getElementById('cat-uncategorized');
    if (subName && catEl) {
      findOrCreateSubcategoryDetails(catEl, subName).querySelector('.sub-content').appendChild(row);
    } else {
      catEl.querySelector('.category-content').appendChild(row);
    }
    refreshRowBadge(row);
  }

  // ── Load and render a month's transactions from the server ────────────────────
  function loadMonthTransactions(isoMonth) {
    return apiFetch('/api/transactions?month=' + isoMonth)
      .then(function (r) { return r.json(); })
      .then(function (txns) {
        document.querySelectorAll('.bill-row').forEach(function (r) { r.remove(); });
        // Reset in-memory tag state; fresh load from server is authoritative
        TXN_NOTES = {};
        TXN_TAX = {};
        TXN_SPLITS = {};

        if (Array.isArray(txns)) {
          txns.forEach(function (t) {
            var row = createBillRow(t);
            placeBillRow(row, t.category_id, t.sub_name);
            var key = rowKey(row);
            if (t.notes)  TXN_NOTES[key] = t.notes;
            if (t.is_tax) TXN_TAX[key]   = true;
            renderRowTagIndicators(row);
          });
        }

        refreshAllRowBadges();
        refreshAllCategoryTotals();
        refreshAllDateGroupHeaders();
        applyTxnFilter();
      })
      .catch(function (e) { console.error('loadMonthTransactions:', e); });
  }

  // ── Override processCSVText to capture filename and most-recent balance ──────
  var _origProcessCSV = processCSVText;
  processCSVText = function (text, filename) {
    window._lastImportFilename = filename || 'import.csv';
    window._lastImportBalance  = null;
    _origProcessCSV(text, filename);
    // After parsing, extract balance from the first row (bank CSVs are newest-first)
    if (importColMap && importColMap.balance >= 0 && importRows && importRows.length > 0) {
      var balRaw = (importRows[0][importColMap.balance] || '').replace(/[^0-9.]/g, '');
      var bal = parseFloat(balRaw);
      if (!isNaN(bal) && bal > 0) window._lastImportBalance = bal;
    }
  };

  // ── Override commitImport: POST to server instead of creating DOM directly ────
  commitImport = function () {
    if (!importParsed || importParsed.length === 0) return;

    var payload = {
      filename: window._lastImportFilename || 'import.csv',
      balance:  window._lastImportBalance != null ? window._lastImportBalance : undefined,
      transactions: importParsed.map(function (t) {
        return { date_str: t.date, merchant: t.desc, amount: t.amount };
      })
    };

    apiFetch('/api/import', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('Import failed: ' + data.error); return; }

        (data.transactions || []).forEach(function (t) {
          var row = createBillRow(t);
          // Use category from server, or fall back to keyword auto-detect
          var catId  = t.category_id || 'cat-uncategorized';
          var subName = t.sub_name || null;
          if (catId === 'cat-uncategorized') {
            var auto = autoCategory(t.merchant);
            if (auto) { catId = auto.catId; subName = auto.subName || null; }
          }
          placeBillRow(row, catId, subName);
          // Persist auto-detected category back to server
          if (catId !== 'cat-uncategorized' && (!t.category_id || t.category_id === 'cat-uncategorized')) {
            apiFetch('/api/transactions/' + t.id, {
              method: 'PUT',
              body: JSON.stringify({ category_id: catId, sub_name: subName })
            });
          }
        });

        applyTxnFilter();
        importParsed = [];
        if (data.balance != null) applyBalanceToUI(data.balance);

        var skippedNote = data.skipped > 0
          ? ' <span style="font-size:13px;font-weight:400;color:#888;">('
            + data.skipped + ' duplicate' + (data.skipped !== 1 ? 's' : '') + ' skipped)</span>'
          : '';
        document.getElementById('import-result').innerHTML =
          '<div class="import-success">' +
            '<div class="success-icon">✅</div>' +
            '<h3>' + data.added + ' transactions imported' + skippedNote + '</h3>' +
            '<p>Auto-categorised where keywords matched. Tap any transaction to recategorise it.</p>' +
          '</div>' +
          '<button type="button" class="import-confirm-btn" style="margin-top:16px;" data-action="show-home">Go to Home</button>' +
          '<button type="button" class="subpage-add-btn" style="margin-top:10px;" data-action="import-again">Import another file</button>';
        document.getElementById('import-drop-zone').hidden = true;
      })
      .catch(function (e) {
        console.error('commitImport:', e);
        alert('Import failed — please try again.');
      });
  };

  // ── Override closeCategorizeModal: persist category/notes/tax to server ───────
  var _origCloseModal = closeCategorizeModal;
  closeCategorizeModal = function () {
    var row = activeRow;
    if (row) {
      var txnId = row.dataset.txnId;
      if (txnId) {
        var key = rowKey(row);
        var parentCat = row.closest('details.category');
        var parentSub = row.closest('details.subcategory');
        var catId = parentCat ? parentCat.id : 'cat-uncategorized';
        var subName = null;
        if (parentSub) {
          var subSpan = parentSub.querySelector('.subcategory-row > span:first-child');
          if (subSpan) subName = subSpan.textContent.trim();
        }
        apiFetch('/api/transactions/' + txnId, {
          method: 'PUT',
          body: JSON.stringify({
            category_id: catId,
            sub_name:    subName || null,
            notes:       TXN_NOTES[key] || null,
            is_tax:      TXN_TAX[key] ? 1 : 0
          })
        });
      }
    }
    _origCloseModal();
  };

  // ── Override renderMonth: load transactions from server on each month change ──
  renderMonth = function () {
    var isoMonth = ISO_MONTHS[monthIndex];
    document.getElementById('month-label').textContent = MONTHS[monthIndex];
    document.getElementById('prev-month-btn').disabled = monthIndex === 0;
    document.getElementById('next-month-btn').disabled = monthIndex === MONTHS.length - 1;

    var tag = MONTH_TAGS[monthIndex];
    var balance = parseFloat(((document.querySelector('.balance') || {}).textContent || '0').replace(/[^0-9.]/g, '')) || 0;
    var upcomingTotal = 0;
    document.querySelectorAll('.breakdown-row.minus').forEach(function (row) {
      var match = row.dataset.month === tag;
      row.hidden = !match;
      if (match) upcomingTotal += Math.abs(parseFloat((row.querySelector('span:last-child').textContent || '0').replace(/[^0-9.-]/g, '')));
    });
    SAFE_TO_SPEND_BASE = balance - upcomingTotal;
    var balRow = document.querySelector('.breakdown-row:not(.minus):not(.total) span:last-child');
    if (balRow) balRow.textContent = formatMoney(balance);
    var sub = document.querySelector('.safe-spend-sub');
    if (sub) sub.textContent = 'After ' + formatMoney(upcomingTotal) + ' in upcoming recurring bills';
    var totRow = document.querySelector('.breakdown-row.total span:last-child');
    if (totRow) totRow.textContent = formatMoney(balance - upcomingTotal);
    renderSafeSpendBar();

    loadMonthTransactions(isoMonth);
  };

  // ── Import history panel ──────────────────────────────────────────────────────
  function loadAndShowImportHistory() {
    apiFetch('/api/imports')
      .then(function (r) { return r.json(); })
      .then(function (imports) {
        var body = document.getElementById('import-body');
        if (!body) return;
        var old = document.getElementById('import-history-section');
        if (old) old.remove();
        if (!imports || imports.length === 0) return;

        var wrap = document.createElement('div');
        wrap.id = 'import-history-section';
        wrap.style.cssText = 'margin-top:20px;border-top:1px solid #eef0f3;padding-top:14px;';

        var title = document.createElement('div');
        title.style.cssText = 'font-size:13px;font-weight:700;color:#444;margin-bottom:10px;letter-spacing:.01em;';
        title.textContent = 'Import History';
        wrap.appendChild(title);

        imports.forEach(function (imp) {
          var card = document.createElement('div');
          card.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f5f5f8;gap:10px;';

          var info = document.createElement('div');
          info.style.cssText = 'min-width:0;flex:1;';
          var fname = document.createElement('div');
          fname.style.cssText = 'font-size:13px;font-weight:600;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          fname.textContent = imp.filename;
          var meta = document.createElement('div');
          meta.style.cssText = 'font-size:11px;color:#999;margin-top:2px;line-height:1.5;';
          var d = new Date(imp.imported_at + (imp.imported_at.endsWith('Z') ? '' : 'Z'));
          var dateRange = (imp.date_from && imp.date_to)
            ? imp.date_from + ' → ' + imp.date_to
            : null;
          var balText = (imp.balance != null) ? ' · Balance: $' + Number(imp.balance).toLocaleString('en-AU', {minimumFractionDigits:2, maximumFractionDigits:2}) : '';
          meta.innerHTML =
            d.toLocaleDateString('en-AU') + ' · '
            + imp.row_count + ' added'
            + (imp.skipped_count > 0 ? ', ' + imp.skipped_count + ' duplicates skipped' : '')
            + balText
            + (dateRange ? '<br>' + dateRange : '');
          info.appendChild(fname);
          info.appendChild(meta);

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.style.cssText = 'color:#e74c3c;border:1px solid #f5c6cb;background:#fff5f5;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;flex-shrink:0;';
          delBtn.textContent = 'Delete';
          (function (importId) {
            delBtn.addEventListener('click', function () {
              if (!confirm('Delete this import and all ' + imp.row_count + ' of its transactions?\n\nThis cannot be undone.')) return;
              apiFetch('/api/imports/' + importId, { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                  if (!res.ok) { alert('Delete failed.'); return; }
                  loadMonthTransactions(ISO_MONTHS[monthIndex]);
                  loadAndShowImportHistory();
                })
                .catch(function () { alert('Delete failed — please try again.'); });
            });
          })(imp.id);

          card.appendChild(info);
          card.appendChild(delBtn);
          wrap.appendChild(card);
        });

        body.appendChild(wrap);
      })
      .catch(function (e) { console.error('loadAndShowImportHistory:', e); });
  }

  // Override resetImportPage so opening/resetting the import page also refreshes history
  var _origResetImportPage = resetImportPage;
  resetImportPage = function () {
    _origResetImportPage();
    loadAndShowImportHistory();
  };

  // ── Persist new subcategory to server when created in categorize modal ──────────
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-action="modal-new-subcategory"]');
    if (!btn) return;
    var form = btn.closest('details.picker-new-form');
    var input = form ? form.querySelector('.modal-new-sub-input') : null;
    var name = input ? input.value.trim() : '';
    var catId = btn.dataset.catId;
    if (!name || !catId) return;
    apiFetch('/api/subcategories', {
      method: 'POST',
      body: JSON.stringify({ category_id: catId, name: name, keywords: [] })
    }).catch(function (e) { console.error('subcategory save failed:', e); });
  });

  // ── Save-balance handler (settings page) ─────────────────────────────────────
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('[data-action="save-balance"]')) return;
    var input = document.getElementById('settings-balance-input');
    var val = parseFloat((input ? input.value : '') || '0');
    if (isNaN(val) || val < 0) { alert('Please enter a valid balance.'); return; }
    apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ balance: val })
    }).then(function () {
      applyBalanceToUI(val);
      if (input) { input.style.borderColor = '#27ae60'; setTimeout(function(){ input.style.borderColor = ''; }, 1200); }
    }).catch(function () { alert('Could not save balance. Please try again.'); });
  });

  // ── Pre-fill balance input when settings page opens ──────────────────────────
  var _origRenderSettingsPage = renderSettingsPage;
  renderSettingsPage = function () {
    _origRenderSettingsPage();
    var input = document.getElementById('settings-balance-input');
    if (input) {
      var balEl = document.querySelector('.balance');
      var current = balEl ? parseFloat(balEl.textContent.replace(/[^0-9.]/g, '')) : 0;
      if (current > 0) input.value = current.toFixed(2);
    }
    // Append admin link if this user is an admin
    if (IS_ADMIN) {
      var body = document.getElementById('settings-body');
      if (body) {
        var adminSection = document.createElement('div');
        adminSection.innerHTML =
          '<div class="settings-section-label" style="margin-top:8px;">Administration</div>' +
          '<div class="settings-list">' +
            '<a href="/admin" style="text-decoration:none;display:flex;justify-content:space-between;align-items:center;padding:12px 14px;" class="settings-row">' +
              '<span>Manage accounts</span>' +
              '<span class="settings-value" style="color:#6c5ce7;font-weight:600;">Admin ›</span>' +
            '</a>' +
          '</div>';
        body.appendChild(adminSection);
      }
    }
  };

  // ── Persist subcategory when a new category+subcategory is created in modal ──
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-action="modal-new-category"]');
    if (!btn) return;
    var form = btn.closest('details.picker-new-form');
    var catInput = form ? form.querySelector('.modal-new-cat-input') : null;
    var subInput = form ? form.querySelector('.modal-new-sub-for-cat-input') : null;
    var catName = catInput ? catInput.value.trim() : '';
    var subName = subInput ? subInput.value.trim() : '';
    if (!catName || !subName) return;
    var catId = 'cat-' + catName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    apiFetch('/api/subcategories', {
      method: 'POST',
      body: JSON.stringify({ category_id: catId, name: subName, keywords: [] })
    }).catch(function (e) { console.error('subcategory save failed:', e); });
  });

  // ── Logout button (desktop sidebar only — mobile uses Settings page) ──────────
  function addLogoutButton() {
    if (!window.matchMedia('(min-width: 760px)').matches) return;
    var navbar = document.querySelector('.navbar');
    if (!navbar) return;
    var spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1;min-height:8px;';
    navbar.appendChild(spacer);

    var btn = document.createElement('div');
    btn.className = 'nav-item';
    btn.style.cssText = 'color:#e74c3c;cursor:pointer;';
    btn.innerHTML =
      '<span class="nav-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>' +
          '<polyline points="16 17 21 12 16 7"/>' +
          '<line x1="21" y1="12" x2="9" y2="12"/>' +
        '</svg>' +
      '</span>Logout';
    btn.addEventListener('click', function () {
      if (confirm('Log out of Money Mate?')) {
        localStorage.removeItem('moneymate_token');
        window.location.href = '/login';
      }
    });
    navbar.appendChild(btn);
  }

  // ── Apply balance to header and Safe-to-Spend breakdown ──────────────────────
  function applyBalanceToUI(bal) {
    if (bal == null || isNaN(bal)) return;
    var balEl = document.querySelector('.balance');
    if (balEl) balEl.textContent = formatMoney(bal);
    var balRow = document.querySelector('.breakdown-row:not(.minus):not(.total) span:last-child');
    if (balRow) balRow.textContent = formatMoney(bal);
    // Re-run renderMonth so Safe-to-Spend recalculates with real balance
    renderMonth();
  }

  var IS_ADMIN = false;

  // ── Bootstrap ─────────────────────────────────────────────────────────────────
  apiFetch('/api/auth/me')
    .then(function (r) {
      if (!r.ok) throw new Error('Not authenticated');
      return r.json();
    })
    .then(function (meData) {
      IS_ADMIN = !!(meData && meData.user && meData.user.is_admin);
      addLogoutButton();
      // Load saved balance from settings before loading transactions
      return apiFetch('/api/settings').then(function (r) { return r.json(); })
        .then(function (s) {
          if (s && s.settings && s.settings.balance) {
            applyBalanceToUI(s.settings.balance);
          }
          // Merge server subcategories into the default SUBCATEGORIES object
          if (s && s.subcategories && s.subcategories.length) {
            s.subcategories.forEach(function (sub) {
              if (!SUBCATEGORIES[sub.category_id]) SUBCATEGORIES[sub.category_id] = [];
              if (SUBCATEGORIES[sub.category_id].indexOf(sub.name) < 0) {
                SUBCATEGORIES[sub.category_id].push(sub.name);
              }
            });
          }
          return loadMonthTransactions(ISO_MONTHS[monthIndex]);
        });
    })
    .catch(function () {
      localStorage.removeItem('moneymate_token');
      window.location.replace('/login');
    });

})();
