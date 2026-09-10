/* =====================================================================
   LIC Printing Shop — Bookkeeping & Tax System
   Plain JS + Supabase. No build step — open index.html or host as-is.
   ===================================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------- init
  const CONFIG = window.APP_CONFIG || {};
  const configOk =
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_ANON_KEY &&
    !/YOUR-PROJECT-REF|YOUR-ANON-PUBLIC-KEY/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);

  let sb = null;
  if (configOk && window.supabase) {
    sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  }
  document.getElementById("config-banner").style.display = configOk ? "none" : "block";
  document.getElementById("brand-name").textContent = CONFIG.COMPANY_NAME || "LIC Printing Shop";
  document.getElementById("brand-sub").textContent = "Books & Tax System";
  document.getElementById("login-brand-name").textContent = CONFIG.COMPANY_NAME || "LIC Printing Shop";

  document.getElementById("today-label").textContent = new Date().toLocaleDateString("en-PH", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const monthISO = () => new Date().toISOString().slice(0, 7);

  function fmtMoney(n) {
    const v = Number(n || 0);
    return v.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return "";
    const dt = typeof d === "string" ? new Date(d + (d.length === 7 ? "-01" : "T00:00:00")) : d;
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtMonth(d) {
    if (!d) return "";
    const dt = new Date(d.length === 7 ? d + "-01" : d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString("en-PH", { year: "numeric", month: "long" });
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  let toastTimer;
  function toast(msg, isError) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = "toast"), 3200);
  }
  function requireDb() {
    if (!sb) {
      toast("Not connected to the database yet — see the banner above.", true);
      return false;
    }
    return true;
  }
  function toCSV(rows, columns) {
    const head = columns.map((c) => c.label).join(",");
    const body = rows
      .map((r) =>
        columns
          .map((c) => {
            let v = c.get ? c.get(r) : r[c.key];
            v = v === null || v === undefined ? "" : String(v);
            if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
            return v;
          })
          .join(",")
      )
      .join("\n");
    return head + "\n" + body;
  }
  function downloadCSV(filename, rows, columns) {
    const csv = toCSV(rows, columns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function statusBadge(status) {
    const map = { "FULLY PAID": "good", PARTIAL: "warn", UNPAID: "bad", "N/A": "neutral" };
    return `<span class="badge ${map[status] || "neutral"}">${escapeHtml(status)}</span>`;
  }
  function computeStatus(total, received) {
    const bal = Number(total || 0) - Number(received || 0);
    if (Number(total || 0) <= 0) return "N/A";
    if (bal <= 0) return "FULLY PAID";
    if (Number(received || 0) > 0) return "PARTIAL";
    return "UNPAID";
  }

  // ---------------------------------------------------------------- auth gate
  let bootedAfterAuth = false;

  const ADMIN_ONLY_VIEWS = ["invoices", "expensesreport", "withholding", "reports", "incomestatement"];
  let currentRole = "staff";

  // Daily Sales and Daily Expenses each have two locked-entity nav entries
  // (Sole Prop / Corp) instead of a dropdown on the form, so staff can't
  // accidentally file one entity's transaction under the other.
  let currentSalesEntity = "SOLE PROPRIETORSHIP";
  let currentExpensesEntity = "SOLE PROPRIETORSHIP";
  const NAV_ENTITY = {
    "sales-sp": { kind: "sales", entity: "SOLE PROPRIETORSHIP" },
    "sales-corp": { kind: "sales", entity: "CORPORATION" },
    "expenses-sp": { kind: "expenses", entity: "SOLE PROPRIETORSHIP" },
    "expenses-corp": { kind: "expenses", entity: "CORPORATION" },
  };
  const VIEW_SECTION = { "sales-sp": "sales", "sales-corp": "sales", "expenses-sp": "expenses", "expenses-corp": "expenses" };
  function fullEntityLabel(v) {
    return v === "CORPORATION" ? "LIC Printing Corporation" : "LIC Printing Shop (Sole Proprietorship)";
  }

  // Default ATC suggested for each withholding rate -- a starting point only.
  // The real ATC also depends on the nature of the income payment (goods vs.
  // services vs. rent vs. professional fee), which this app has no way to
  // know automatically, so the field stays editable — treat this as a
  // best-guess default to speed up entry, not a compliance guarantee.
  const ATC_BY_RATE = {
    "0.01": "WC160", // 1% — goods, top withholding agent
    "0.02": "WC158", // 2% — services, top withholding agent
    "0.05": "WC100", // 5% — rental / certain brokers & agents
    "0.10": "WI010", // 10% — professional/talent fees (individual)
  };

  // VAT threshold for monitoring Corp (Non-VAT) cumulative sales. BIR's
  // current VAT registration threshold is ₱3,000,000 (Sec. 109(BB) NIRC, as
  // last amended by the TRAIN law) -- confirm this hasn't changed before
  // relying on it, since Congress can adjust it.
  const VAT_THRESHOLD = 3000000;

  function showAppShell(session) {
    $("login-screen").style.display = "none";
    $("app-shell").style.display = "flex";
    currentRole = session?.user?.user_metadata?.role === "admin" ? "admin" : "staff";
    $("signed-in-as").textContent = session?.user?.email
      ? `Signed in as ${session.user.email} (${currentRole === "admin" ? "Administrator" : "Employee"})`
      : "";
    $("nav-admin-group").style.display = currentRole === "admin" ? "" : "none";
    if (!bootedAfterAuth) {
      bootedAfterAuth = true;
      loadDashboard();
      refreshDatalists();
    }
  }
  function showLoginScreen() {
    bootedAfterAuth = false;
    $("app-shell").style.display = "none";
    $("login-screen").style.display = "flex";
    $("login-password").value = "";
  }

  async function initAuthGate() {
    if (!sb) {
      // No valid Supabase config yet — show the shell so the red config
      // banner (and setup instructions) are visible instead of a login
      // screen nobody can sign into.
      $("login-screen").style.display = "none";
      $("app-shell").style.display = "flex";
      return;
    }
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (session) showAppShell(session);
    else showLoginScreen();

    sb.auth.onAuthStateChange((_event, session) => {
      if (session) showAppShell(session);
      else showLoginScreen();
    });

    $("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("login-email").value.trim();
      const password = $("login-password").value;
      const msg = $("login-msg");
      const btn = $("login-submit");
      msg.textContent = "";
      msg.className = "login-msg";
      btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      if (error) {
        msg.textContent = error.message;
        return;
      }
    });

    $("logout-btn").addEventListener("click", async () => {
      await sb.auth.signOut();
    });
  }

  // ---------------------------------------------------------------- nav
  const views = ["dashboard", "sales", "expenses", "pettycash", "receivables", "bills", "opsreport", "staff", "invoices", "expensesreport", "withholding", "reports", "incomestatement"];
  const titles = {
    dashboard: "Dashboard",
    "sales-sp": "Daily Sales — LIC Printing Shop", "sales-corp": "Daily Sales — LIC Printing Corporation",
    "expenses-sp": "Daily Expenses — LIC Printing Shop", "expenses-corp": "Daily Expenses — LIC Printing Corporation",
    pettycash: "Petty Cash Vouchers",
    receivables: "Receivables", bills: "Bill Tracker", opsreport: "Daily Operations Report", staff: "Staff",
    invoices: "Sales Report", expensesreport: "Expenses Report", withholding: "2307 Register", reports: "Reports", incomestatement: "Income Statement",
  };
  const loaded = {};
  const loaders = {
    dashboard: loadDashboard,
    "sales-sp": loadSales, "sales-corp": loadSales,
    "expenses-sp": loadExpenses, "expenses-corp": loadExpenses,
    pettycash: loadPettyCash,
    receivables: loadReceivables, bills: loadBills, opsreport: loadOpsReport, staff: loadStaff,
    invoices: loadInvoices, expensesreport: loadExpensesReport, withholding: loadWithholding, reports: loadReports, incomestatement: loadIncomeStatement,
  };

  function showView(name) {
    if (ADMIN_ONLY_VIEWS.includes(name) && currentRole !== "admin") {
      toast("That section is restricted to administrator accounts.", true);
      name = "dashboard";
    }
    const nav = NAV_ENTITY[name];
    if (nav) {
      if (nav.kind === "sales") {
        currentSalesEntity = nav.entity;
        $("sales-entity").value = currentSalesEntity;
        $("sales-entity-label").textContent = fullEntityLabel(currentSalesEntity);
        updateSalesFormForEntity();
        checkCorpVatThreshold();
      } else {
        currentExpensesEntity = nav.entity;
        $("expenses-entity").value = currentExpensesEntity;
        $("expenses-entity-label").textContent = fullEntityLabel(currentExpensesEntity);
      }
    }
    const sectionId = VIEW_SECTION[name] || name;
    views.forEach((v) => {
      $("view-" + v).classList.toggle("active", v === sectionId);
    });
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $("view-title").textContent = titles[name] || titles[sectionId];
    if (sb && loaders[name]) loaders[name]();
  }
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  // ---------------------------------------------------------------- datalists (shared reference data)
  async function refreshDatalists() {
    if (!sb) return;
    try {
      const { data: staff } = await sb.from("staff").select("name").eq("active", true).order("name");
      $("staff-list").innerHTML = (staff || []).map((s) => `<option value="${escapeHtml(s.name)}">`).join("");

      const { data: custs } = await sb.from("sales").select("tradename").limit(1000);
      const names = Array.from(new Set((custs || []).map((c) => c.tradename).filter(Boolean))).sort();
      $("customer-list").innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join("");

      const { data: payees } = await sb.from("expenses").select("business_name").limit(1000);
      const pnames = Array.from(new Set((payees || []).map((c) => c.business_name).filter(Boolean))).sort();
      $("expense-payee-list").innerHTML = pnames.map((n) => `<option value="${escapeHtml(n)}">`).join("");
    } catch (e) {
      console.warn("datalist refresh failed", e);
    }
  }

  /* =====================================================================
     DASHBOARD
     ===================================================================== */
  async function loadDashboard() {
    if (!requireDb()) return;
    const today = todayISO();
    const monthStart = today.slice(0, 7) + "-01";

    const [{ data: todaySales }, { data: monthSales }, { data: todayExp }, { data: monthExp }, { data: receivables }, { data: recentSales }] =
      await Promise.all([
        sb.from("sales").select("total_amount").eq("trx_date", today),
        sb.from("sales").select("total_amount").gte("trx_date", monthStart),
        sb.from("expenses").select("amount").eq("trx_date", today),
        sb.from("expenses").select("amount").gte("trx_date", monthStart),
        sb.from("sales").select("balance").neq("balance", 0),
        sb.from("v_sales_status").select("*").order("trx_date", { ascending: false }).limit(10),
      ]);

    const sum = (rows, key) => (rows || []).reduce((a, r) => a + Number(r[key] || 0), 0);
    const todaySalesTotal = sum(todaySales, "total_amount");
    const todayExpTotal = sum(todayExp, "amount");
    const monthSalesTotal = sum(monthSales, "total_amount");
    const monthExpTotal = sum(monthExp, "amount");
    const totalReceivable = sum(receivables, "balance");

    $("dash-cards").innerHTML = [
      card("Today's sales", fmtMoney(todaySalesTotal), "good"),
      card("Today's expenses", fmtMoney(todayExpTotal), "bad"),
      card("Month-to-date net", fmtMoney(monthSalesTotal - monthExpTotal), monthSalesTotal - monthExpTotal >= 0 ? "good" : "bad"),
      card("Outstanding receivables", fmtMoney(totalReceivable), "warn"),
    ].join("");

    function card(label, value, cls) {
      return `<div class="stat-card"><div class="label">${label}</div><div class="value ${cls}">₱ ${value}</div></div>`;
    }

    // recent sales
    const tb = $("dash-recent-sales").querySelector("tbody");
    tb.innerHTML = (recentSales || []).length
      ? recentSales.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.tradename)}</td><td>${escapeHtml(r.reference_person || "")}</td>
          <td class="num">₱ ${fmtMoney(r.total_amount)}</td><td class="num">₱ ${fmtMoney(r.balance)}</td><td>${statusBadge(r.status)}</td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="6">No sales logged yet</td></tr>`;

    // bills due soon
    const period = monthISO();
    const { data: bills } = await sb
      .from("bill_payments")
      .select("*, billers(name)")
      .eq("period", period);
    const bt = $("dash-bills-table").querySelector("tbody");
    const soon = (bills || []).sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999")).slice(0, 8);
    bt.innerHTML = soon.length
      ? soon.map((b) => {
          const paid = Number(b.amount_paid || 0) >= Number(b.total_amount || 0) && Number(b.total_amount || 0) > 0;
          const overdue = !paid && b.due_date && b.due_date < todayISO();
          const status = paid ? statusBadge("FULLY PAID") : overdue ? statusBadge("UNPAID") : statusBadge("PARTIAL");
          return `<tr><td>${escapeHtml(b.billers?.name || "")}</td><td>${fmtDate(b.due_date)}</td><td class="num">₱ ${fmtMoney(b.total_amount)}</td><td>${status}</td></tr>`;
        }).join("")
      : `<tr class="empty-row"><td colspan="4">No billers set up yet — add one in Bill Tracker</td></tr>`;

    // sparkline: last 14 days sales vs expenses
    const since = new Date();
    since.setDate(since.getDate() - 13);
    const sinceISO = since.toISOString().slice(0, 10);
    const [{ data: spSales }, { data: spExp }] = await Promise.all([
      sb.from("sales").select("trx_date,total_amount").gte("trx_date", sinceISO),
      sb.from("expenses").select("trx_date,amount").gte("trx_date", sinceISO),
    ]);
    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const s = sum((spSales || []).filter((r) => r.trx_date === iso), "total_amount");
      const e = sum((spExp || []).filter((r) => r.trx_date === iso), "amount");
      days.push({ iso, s, e });
    }
    const max = Math.max(1, ...days.map((d) => Math.max(d.s, d.e)));
    $("dash-sparkline").innerHTML = days
      .map((d) => {
        const h = Math.max(2, Math.round((d.s / max) * 52));
        const isToday = d.iso === todayISO();
        return `<div class="sparkbar${isToday ? " today" : ""}" style="height:${h}px" title="${fmtDate(d.iso)} — sales ₱${fmtMoney(d.s)} / expenses ₱${fmtMoney(d.e)}"></div>`;
      })
      .join("");

    refreshDatalists();
  }

  /* =====================================================================
     DAILY SALES
     ===================================================================== */
  // Sole Prop is VAT-registered -- show zero-rated/exempt + VAT preview.
  // Corp is Non-VAT -- hide those (item 7): only gross/discount/tax withheld
  // apply there, plus a threshold banner if cumulative sales get close to
  // (or cross) the VAT registration threshold.
  function updateSalesFormForEntity() {
    const isSoleProp = currentSalesEntity === "SOLE PROPRIETORSHIP";
    ["sales-zerorated-field", "sales-vatexempt-field", "sales-vat-preview-field"].forEach((id) => {
      $(id).style.display = isSoleProp ? "" : "none";
    });
    updateSalesVatPreview();
  }
  function updateSalesVatPreview() {
    if (currentSalesEntity !== "SOLE PROPRIETORSHIP") return;
    const gross = Number($("sales-total").value || 0);
    const exempt = $("sales-vatexempt").checked || $("sales-zerorated").checked;
    const { vat } = computeNetVat(gross, currentSalesEntity, exempt);
    $("sales-vat-preview").value = "₱ " + fmtMoney(vat) + ($("sales-zerorated").checked ? " (zero-rated)" : $("sales-vatexempt").checked ? " (exempt)" : "");
  }
  function updateSalesTaxWithheldFromPct() {
    const pct = $("sales-taxwithheld-pct").value;
    if (!pct) return;
    const gross = Number($("sales-total").value || 0);
    $("sales-taxwithheld").value = gross > 0 ? (gross * Number(pct)).toFixed(2) : "";
    $("sales-atc").value = ATC_BY_RATE[pct] || $("sales-atc").value;
    updateSales2307FieldVisibility();
  }
  function updateSales2307FieldVisibility() {
    const show = Number($("sales-taxwithheld").value || 0) > 0;
    $("sales-2307status-field").style.display = show ? "" : "none";
    $("sales-2307upload-field").style.display = show && $("sales-2307status").value === "yes" ? "" : "none";
  }
  // Advisory only -- never auto-charges VAT on Corp sales. Crossing the
  // threshold is a real BIR registration change (new COR, new invoicing
  // rules) that has to happen through BIR first; the app just flags it so
  // 5JS can review and act on it with the client.
  async function checkCorpVatThreshold() {
    const banner = $("sales-vat-threshold-banner");
    if (currentSalesEntity !== "CORPORATION" || !sb) { banner.style.display = "none"; return; }
    const yearStart = new Date().getFullYear() + "-01-01";
    const { data } = await sb.from("sales").select("total_amount").eq("business_entity", "CORPORATION").gte("trx_date", yearStart);
    const ytd = (data || []).reduce((a, r) => a + Number(r.total_amount || 0), 0);
    if (ytd >= VAT_THRESHOLD) {
      banner.textContent = `⚠ LIC Printing Corporation's cumulative sales this year are ₱${fmtMoney(ytd)} — at or above the ₱${fmtMoney(VAT_THRESHOLD)} VAT threshold. This is a monitoring flag only (VAT is NOT auto-charged here) — please review VAT registration status with BIR.`;
      banner.style.display = "";
    } else if (ytd >= VAT_THRESHOLD * 0.85) {
      banner.textContent = `Note: LIC Printing Corporation's cumulative sales this year are ₱${fmtMoney(ytd)}, approaching the ₱${fmtMoney(VAT_THRESHOLD)} VAT threshold.`;
      banner.style.display = "";
    } else {
      banner.style.display = "none";
    }
  }
  async function uploadClientCertificate(file, saleId) {
    if (!file) return null;
    const path = `2307-received/${saleId}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error } = await sb.storage.from("attachments").upload(path, file, { upsert: true });
    if (error) {
      toast("Sale saved, but the 2307 file upload failed: " + error.message + " (has the 'attachments' Storage bucket been created in Supabase?)", true);
      return null;
    }
    return path;
  }
  function initSalesForm() {
    $("sales-date").value = todayISO();
    $("sales-entity").value = currentSalesEntity;
    updateSalesFormForEntity();
    $("sales-total").addEventListener("input", () => { updateSalesTaxWithheldFromPct(); updateSalesVatPreview(); });
    $("sales-taxwithheld-pct").addEventListener("change", updateSalesTaxWithheldFromPct);
    $("sales-taxwithheld").addEventListener("input", updateSales2307FieldVisibility);
    $("sales-2307status").addEventListener("change", updateSales2307FieldVisibility);
    $("sales-zerorated").addEventListener("change", () => {
      if ($("sales-zerorated").checked) $("sales-vatexempt").checked = false;
      updateSalesVatPreview();
    });
    $("sales-vatexempt").addEventListener("change", () => {
      if ($("sales-vatexempt").checked) $("sales-zerorated").checked = false;
      updateSalesVatPreview();
    });
    $("sales-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("sales-id").value;
      const grossAmount = Number($("sales-total").value || 0);
      const zeroRated = $("sales-zerorated").checked;
      const vatExempt = $("sales-vatexempt").checked;
      const { vat } = computeNetVat(grossAmount, $("sales-entity").value, zeroRated || vatExempt);
      const pct = $("sales-taxwithheld-pct").value;
      const clientIssuedSel = $("sales-2307status").value; // "", "yes", "no"
      const certFile = $("sales-2307upload").files[0] || null;
      const payload = {
        trx_date: $("sales-date").value,
        tradename: $("sales-tradename").value.trim(),
        quote_no: $("sales-quote").value.trim() || null,
        reference_person: $("sales-staff").value.trim() || null,
        total_amount: grossAmount,
        amount_received: Number($("sales-received").value || 0),
        mode_of_payment: $("sales-mode").value.trim() || null,
        invoice_no: $("sales-invoice").value.trim() || null,
        business_entity: $("sales-entity").value || null,
        tin: $("sales-tin").value.trim() || null,
        atc: $("sales-atc").value.trim() || null,
        tax_withheld: $("sales-taxwithheld").value ? Number($("sales-taxwithheld").value) : null,
        tax_withheld_rate: pct ? Number(pct) : null,
        bir_receipt_no: $("sales-bir").value.trim() || null,
        is_walkin: $("sales-walkin").checked,
        zero_rated: zeroRated,
        vat_exempt: vatExempt,
        vat_amount: currentSalesEntity === "SOLE PROPRIETORSHIP" ? vat : 0,
        discount_amount: $("sales-discount").value ? Number($("sales-discount").value) : 0,
        discount_details: $("sales-discount-details").value.trim() || null,
        description: $("sales-description").value.trim() || null,
        remarks: $("sales-remarks").value.trim() || null,
      };
      let error, savedId = id || null;
      if (id) {
        ({ error } = await sb.from("sales").update(payload).eq("id", id));
      } else {
        const { data, error: insErr } = await sb.from("sales").insert(payload).select("id").single();
        error = insErr;
        if (data) savedId = data.id;
      }
      if (error) return toast(error.message, true);
      let msg = id ? "Sale updated" : "Sale saved";
      if (savedId) {
        let certPath = null;
        if (certFile) certPath = await uploadClientCertificate(certFile, savedId);
        await syncSaleWithholding(savedId, payload, {
          clientIssued: clientIssuedSel === "yes" ? true : clientIssuedSel === "no" ? false : null,
          certificateFilePath: certPath,
        });
        if (Number(payload.tax_withheld || 0) > 0) msg += " — 2307 (Received) synced";
        await syncSalesReport(savedId, payload);
        if ((payload.bir_receipt_no || "").trim()) msg += " — Sales Report synced";
      }
      toast(msg);
      resetSalesForm();
      loadSales();
      loadDashboard.dirty = true;
      if (currentSalesEntity === "CORPORATION") checkCorpVatThreshold();
    });
    $("sales-cancel-edit").addEventListener("click", resetSalesForm);
    $("sales-f-apply").addEventListener("click", loadSales);
    $("sales-f-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadSales(); }
    });
    ["sales-f-from", "sales-f-to", "sales-f-status"].forEach((id) => $(id).addEventListener("change", loadSales));
    $("sales-f-clear").addEventListener("click", () => {
      ["sales-f-from", "sales-f-to", "sales-f-search"].forEach((id) => ($(id).value = ""));
      $("sales-f-status").value = "";
      loadSales();
    });
    $("sales-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchSalesRows();
      downloadCSV(currentSalesEntity === "CORPORATION" ? "sales_corporation.csv" : "sales_sole_prop.csv", rows, [
        { label: "Date", key: "trx_date" }, { label: "Tradename", key: "tradename" },
        { label: "Staff", key: "reference_person" }, { label: "Total", key: "total_amount" },
        { label: "Received", key: "amount_received" }, { label: "Balance", key: "balance" },
        { label: "Status", key: "status" }, { label: "Mode", key: "mode_of_payment" },
        { label: "Xero Invoice No", key: "invoice_no" }, { label: "Business Entity", key: "business_entity" },
        { label: "TIN", key: "tin" }, { label: "ATC", key: "atc" }, { label: "Tax Withheld", key: "tax_withheld" },
        { label: "Payment Confirmed", get: (r) => (r.payment_confirmed ? "Yes" : "No") },
        { label: "Remarks", key: "remarks" },
      ]);
    });
  }
  function resetSalesForm() {
    $("sales-form").reset();
    $("sales-id").value = "";
    $("sales-entity").value = currentSalesEntity;
    $("sales-date").value = todayISO();
    $("sales-received").value = "0";
    $("sales-vat-preview").value = "";
    $("sales-form-title").textContent = "Log a sale";
    $("sales-cancel-edit").style.display = "none";
    updateSalesFormForEntity();
    updateSales2307FieldVisibility();
  }

  // A sale with tax actually withheld means the customer is the withholding
  // agent and owes US a 2307 (we hold it as a tax credit) — keep one
  // withholding_2307 row (direction 'received') in sync with each sale row.
  async function syncSaleWithholding(saleId, payload, opts) {
    const taxWithheld = Number(payload.tax_withheld || 0);
    if (taxWithheld > 0) {
      const monthStr = payload.trx_date.slice(0, 7);
      const whPayload = {
        sale_id: saleId,
        direction: "received",
        year: Number(payload.trx_date.slice(0, 4)),
        quarter: quarterOf(monthStr),
        month: monthStr + "-01",
        tin: payload.tin,
        payee_name: payload.tradename,
        atc: payload.atc,
        income_payment: payload.total_amount,
        tax_withheld: taxWithheld,
        invoice_ref: payload.invoice_no,
        business_entity: payload.business_entity || null,
        // Whether the client has actually handed over the physical 2307 --
        // NOT auto-assumed true just because tax was withheld (item 3).
        client_issued: opts && opts.clientIssued !== undefined ? opts.clientIssued : null,
      };
      if (opts && opts.certificateFilePath) whPayload.certificate_file_path = opts.certificateFilePath;
      const { error } = await sb.from("withholding_2307").upsert(whPayload, { onConflict: "sale_id" });
      if (error) toast("Sale saved, but the linked 2307 failed: " + error.message, true);
    } else {
      await sb.from("withholding_2307").delete().eq("sale_id", saleId);
    }
  }

  // A sale with a BIR receipt number is an officially issued invoice for BIR
  // purposes -- keep one issued_invoices row (linked by sale_id) in sync with
  // it instead of re-typing it on the Sales Report page. Rows with no sale_id
  // (carried over from the Declarations sheet) are never touched by this.
  // LIC Printing Shop (Sole Proprietorship) is VAT-registered; LIC Printing
  // Corporation is NON-VAT (percentage tax) -- non-VAT receipts show no VAT
  // breakdown, so gross = net and VAT = 0 for that entity.
  function computeNetVat(gross, entity, exemptOrZeroRated) {
    if (entity === "CORPORATION" || exemptOrZeroRated) return { net: gross, vat: 0 };
    const net = gross / 1.12;
    return { net, vat: gross - net };
  }
  async function syncSalesReport(saleId, payload) {
    const receiptNo = (payload.bir_receipt_no || "").trim();
    if (receiptNo) {
      const gross = Number(payload.total_amount || 0);
      const { net, vat } = computeNetVat(gross, payload.business_entity, payload.zero_rated || payload.vat_exempt);
      const taxWithheld = Number(payload.tax_withheld || 0);
      const monthStr = payload.trx_date.slice(0, 7);
      const invPayload = {
        sale_id: saleId,
        business_entity: payload.business_entity,
        month_declared: monthStr + "-01",
        invoice_date: payload.trx_date,
        invoice_no: receiptNo,
        tin: payload.tin,
        customer_name: payload.tradename,
        gross_sales: gross,
        net_sales: net,
        vat: vat,
        withholding_tax: taxWithheld,
        total_due: gross - taxWithheld,
        with_2307: taxWithheld > 0,
      };
      const { error } = await sb.from("issued_invoices").upsert(invPayload, { onConflict: "sale_id" });
      if (error) toast("Sale saved, but the linked Sales Report entry failed: " + error.message, true);
    } else {
      await sb.from("issued_invoices").delete().eq("sale_id", saleId);
    }
  }
  async function fetchSalesRows() {
    let q = sb.from("v_sales_status").select("*").eq("business_entity", currentSalesEntity).order("trx_date", { ascending: false });
    const from = $("sales-f-from").value, to = $("sales-f-to").value, status = $("sales-f-status").value, search = $("sales-f-search").value.trim();
    if (from) q = q.gte("trx_date", from);
    if (to) q = q.lte("trx_date", to);
    if (status) q = q.eq("status", status);
    if (search) q = q.ilike("tradename", `%${search}%`);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  function entityLabel(v) {
    if (v === "SOLE PROPRIETORSHIP") return "Sole Prop";
    if (v === "CORPORATION") return "Corp";
    return "";
  }
  async function loadSales() {
    if (!requireDb()) return;
    const [rows, { data: whLinks }, { data: invLinks }] = await Promise.all([
      fetchSalesRows(),
      sb.from("withholding_2307").select("sale_id").not("sale_id", "is", null),
      sb.from("issued_invoices").select("sale_id").not("sale_id", "is", null),
    ]);
    const has2307 = new Set((whLinks || []).map((w) => w.sale_id));
    const hasInvoice = new Set((invLinks || []).map((w) => w.sale_id));
    const tb = $("sales-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.tradename)}</td><td>${escapeHtml(r.reference_person || "")}</td>
          <td class="num">₱ ${fmtMoney(r.total_amount)}</td><td class="num">₱ ${fmtMoney(r.amount_received)}</td>
          <td class="num">₱ ${fmtMoney(r.balance)}</td><td>${statusBadge(r.status)}</td>
          <td>${escapeHtml(r.mode_of_payment || "")}</td><td>${escapeHtml(r.invoice_no || "")}</td>
          <td>${has2307.has(r.id) ? '<span class="badge good">2307</span>' : ""}</td>
          <td>${hasInvoice.has(r.id) ? '<span class="badge good">Filed</span>' : ""}</td>
          <td>
            ${r.payment_confirmed ? '<span class="badge good">Confirmed</span>' : '<span class="badge warn">Pending</span>'}
            ${currentRole === "admin" ? `<button class="btn small ghost" data-toggle-payment="${r.id}" data-confirmed="${r.payment_confirmed ? "1" : "0"}">${r.payment_confirmed ? "Unconfirm" : "Confirm"}</button>` : ""}
          </td>
          <td class="row-actions">
            <button class="btn small" data-edit-sale="${r.id}">Edit</button>
            <button class="btn small danger" data-del-sale="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="13">No sales match these filters</td></tr>`;

    tb.querySelectorAll("[data-edit-sale]").forEach((btn) =>
      btn.addEventListener("click", () => editSale(rows.find((r) => String(r.id) === btn.dataset.editSale)))
    );
    tb.querySelectorAll("[data-del-sale]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("sales", btn.dataset.delSale, loadSales))
    );
    tb.querySelectorAll("[data-toggle-payment]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!requireDb()) return;
        const id = btn.dataset.togglePayment;
        const next = btn.dataset.confirmed !== "1";
        const { error } = await sb.from("sales").update({ payment_confirmed: next }).eq("id", id);
        if (error) return toast(error.message, true);
        toast(next ? "Payment confirmed" : "Payment confirmation removed");
        loadSales();
      })
    );
  }
  async function editSale(r) {
    if (!r) return;
    $("sales-id").value = r.id;
    $("sales-date").value = r.trx_date;
    $("sales-tradename").value = r.tradename || "";
    $("sales-quote").value = r.quote_no || "";
    $("sales-staff").value = r.reference_person || "";
    $("sales-total").value = r.total_amount;
    $("sales-received").value = r.amount_received;
    $("sales-mode").value = r.mode_of_payment || "";
    $("sales-invoice").value = r.invoice_no || "";
    $("sales-entity").value = r.business_entity || "";
    $("sales-tin").value = r.tin || "";
    $("sales-atc").value = r.atc || "";
    $("sales-taxwithheld").value = r.tax_withheld ?? "";
    $("sales-taxwithheld-pct").value = r.tax_withheld_rate != null ? String(r.tax_withheld_rate) : "";
    $("sales-bir").value = r.bir_receipt_no || "";
    $("sales-walkin").checked = !!r.is_walkin;
    $("sales-zerorated").checked = !!r.zero_rated;
    $("sales-vatexempt").checked = !!r.vat_exempt;
    $("sales-discount").value = r.discount_amount || "";
    $("sales-discount-details").value = r.discount_details || "";
    $("sales-description").value = r.description || "";
    $("sales-remarks").value = r.remarks || "";
    $("sales-2307status").value = "";
    $("sales-2307upload").value = "";
    updateSalesFormForEntity();
    updateSales2307FieldVisibility();
    // Prefill "has the client issued the 2307" from the linked record, if
    // any, so re-saving an edit doesn't silently wipe out a status someone
    // already answered.
    if (Number(r.tax_withheld || 0) > 0 && requireDb()) {
      const { data: wh } = await sb.from("withholding_2307").select("client_issued").eq("sale_id", r.id).maybeSingle();
      if (wh && wh.client_issued === true) $("sales-2307status").value = "yes";
      else if (wh && wh.client_issued === false) $("sales-2307status").value = "no";
      updateSales2307FieldVisibility();
    }
    $("sales-form-title").textContent = "Edit sale";
    $("sales-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function deleteRow(table, id, reload) {
    if (!requireDb()) return;
    if (!confirm("Delete this record? This can't be undone.")) return;
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) return toast(error.message, true);
    toast("Deleted");
    reload();
  }

  /* =====================================================================
     DAILY EXPENSES
     ===================================================================== */
  function initExpensesForm() {
    $("expenses-date").value = todayISO();
    $("expenses-entity").value = currentExpensesEntity;
    $("expenses-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("expenses-id").value;
      const payload = {
        trx_date: $("expenses-date").value,
        business_scope: $("expenses-scope").value,
        business_entity: $("expenses-entity").value || null,
        tax_type: $("expenses-taxtype").value,
        tin: $("expenses-tin").value.trim() || null,
        business_name: $("expenses-business").value.trim(),
        amount: Number($("expenses-amount").value || 0),
        category: $("expenses-category").value.trim() || null,
        mode_of_payment: $("expenses-mode").value.trim() || null,
        invoice_no: $("expenses-invoice").value.trim() || null,
        atc: $("expenses-atc").value.trim() || null,
        tax_withheld: $("expenses-taxwithheld").value ? Number($("expenses-taxwithheld").value) : null,
        particulars: $("expenses-particulars").value.trim() || null,
        remarks: $("expenses-remarks").value.trim() || null,
      };
      let error, savedId = id ? Number(id) : null;
      if (id) {
        ({ error } = await sb.from("expenses").update(payload).eq("id", id));
      } else {
        const res = await sb.from("expenses").insert(payload).select("id").single();
        error = res.error;
        savedId = res.data?.id ?? null;
      }
      if (error) return toast(error.message, true);
      if (savedId) await syncExpenseWithholding(savedId, payload);
      const suffix = Number(payload.tax_withheld) > 0 ? " — 2307 (Issued) synced" : "";
      toast((id ? "Expense updated" : "Expense saved") + suffix);
      resetExpensesForm();
      loadExpenses();
    });
    $("expenses-cancel-edit").addEventListener("click", resetExpensesForm);
    $("expenses-f-apply").addEventListener("click", loadExpenses);
    $("expenses-f-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadExpenses(); }
    });
    ["expenses-f-from", "expenses-f-to", "expenses-f-withholding"].forEach((id) => $(id).addEventListener("change", loadExpenses));
    $("expenses-f-clear").addEventListener("click", () => {
      ["expenses-f-from", "expenses-f-to", "expenses-f-category", "expenses-f-search"].forEach((id) => ($(id).value = ""));
      $("expenses-f-withholding").value = "";
      loadExpenses();
    });
    $("expenses-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchExpensesRows();
      downloadCSV(currentExpensesEntity === "CORPORATION" ? "expenses_corporation.csv" : "expenses_sole_prop.csv", rows, [
        { label: "Date", key: "trx_date" }, { label: "Business", key: "business_name" },
        { label: "Category", key: "category" }, { label: "Tax Type", key: "tax_type" },
        { label: "Amount", key: "amount" }, { label: "Mode", key: "mode_of_payment" },
        { label: "TIN", key: "tin" }, { label: "ATC", key: "atc" }, { label: "Tax Withheld", key: "tax_withheld" },
        { label: "Particulars", key: "particulars" },
      ]);
    });
  }
  function resetExpensesForm() {
    $("expenses-form").reset();
    $("expenses-id").value = "";
    $("expenses-entity").value = currentExpensesEntity;
    $("expenses-date").value = todayISO();
    $("expenses-form-title").textContent = "Log an expense";
    $("expenses-cancel-edit").style.display = "none";
  }

  function quarterOf(monthStr) {
    // monthStr like "2026-09" or "2026-09-01"
    const m = Number(monthStr.slice(5, 7));
    return `Q${Math.floor((m - 1) / 3) + 1}`;
  }

  // ---------------------------------------------------------------------
  // Generate a printable/signable Certificate of Creditable Tax Withheld
  // at Source (BIR Form 2307), one PDF per certificate, so it can be
  // downloaded, signed, and sent straight to the vendor/lessor. Works from
  // whatever data is already on hand (an expense row, or a 2307 register
  // row) -- no extra lookups needed.
  // ---------------------------------------------------------------------
  function download2307Pdf({ entity, payeeName, tin, atc, incomePayment, taxWithheld, periodDate, invoiceRef }) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast("PDF library didn't load — check your internet connection and try again.", true);
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = 210;
    const marginX = 18;
    let y = 20;

    const payorName = fullEntityLabel(entity || "SOLE PROPRIETORSHIP");
    const d = periodDate ? new Date(periodDate) : new Date();
    const year = d.getFullYear();
    const monthStr = `${year}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const quarter = quarterOf(monthStr);
    const monthLabel = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("CERTIFICATE OF CREDITABLE TAX WITHHELD AT SOURCE", pageW / 2, y, { align: "center" });
    y += 6;
    doc.setFontSize(11);
    doc.text("(BIR FORM 2307)", pageW / 2, y, { align: "center" });
    y += 8;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`For the period ended: ${monthLabel}  (${quarter} ${year})`, pageW / 2, y, { align: "center" });
    y += 12;

    function section(title) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(title, marginX, y);
      y += 1.5;
      doc.setDrawColor(180);
      doc.line(marginX, y, pageW - marginX, y);
      y += 6;
      doc.setFont("helvetica", "normal");
    }
    function line(label, value) {
      doc.setFont("helvetica", "bold");
      doc.text(label, marginX, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value || ""), marginX + 45, y);
      doc.setDrawColor(150);
      doc.line(marginX + 45, y + 1, pageW - marginX, y + 1);
      y += 8;
    }

    section("PART I — PAYOR / WITHHOLDING AGENT");
    line("Name:", payorName);
    line("TIN:", "");
    line("Registered Address:", "");
    y += 2;

    section("PART II — PAYEE (INCOME RECIPIENT)");
    line("Name:", payeeName);
    line("TIN:", tin || "");
    line("Registered Address:", "");
    y += 4;

    // Withholding table
    doc.setDrawColor(0);
    const colX = [marginX, marginX + 30, marginX + 105, marginX + 145];
    const tableRight = pageW - marginX;
    const rowH = 9;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.rect(marginX, y, tableRight - marginX, rowH);
    doc.text("ATC", colX[0] + 2, y + 6);
    doc.text("Nature of Income Payment", colX[1] + 2, y + 6);
    doc.text("Income Payment", colX[2] + 2, y + 6);
    doc.text("Tax Withheld", colX[3] + 2, y + 6);
    [colX[1], colX[2], colX[3]].forEach((x) => doc.line(x, y, x, y + rowH));
    y += rowH;

    doc.setFont("helvetica", "normal");
    doc.rect(marginX, y, tableRight - marginX, rowH);
    doc.text(String(atc || ""), colX[0] + 2, y + 6);
    doc.text(invoiceRef ? `Ref: ${invoiceRef}` : "", colX[1] + 2, y + 6);
    doc.text(`Php ${fmtMoney(incomePayment)}`, colX[2] + 2, y + 6);
    doc.text(`Php ${fmtMoney(taxWithheld)}`, colX[3] + 2, y + 6);
    [colX[1], colX[2], colX[3]].forEach((x) => doc.line(x, y, x, y + rowH));
    y += rowH;

    doc.setFont("helvetica", "bold");
    doc.rect(marginX, y, tableRight - marginX, rowH);
    doc.text("TOTAL", colX[1] + 2, y + 6);
    doc.text(`Php ${fmtMoney(incomePayment)}`, colX[2] + 2, y + 6);
    doc.text(`Php ${fmtMoney(taxWithheld)}`, colX[3] + 2, y + 6);
    [colX[1], colX[2], colX[3]].forEach((x) => doc.line(x, y, x, y + rowH));
    y += rowH + 10;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    const declaration = "I declare, under the penalties of perjury, that this certificate has been made in good faith, verified by me, and to the best of my knowledge and belief, is true and correct, pursuant to the provisions of the National Internal Revenue Code, as amended, and the regulations issued under authority thereof.";
    const wrapped = doc.splitTextToSize(declaration, tableRight - marginX);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 4 + 14;

    const sigColW = (tableRight - marginX - 10) / 2;
    doc.line(marginX, y, marginX + sigColW, y);
    doc.line(marginX + sigColW + 10, y, tableRight, y);
    y += 5;
    doc.setFontSize(9);
    doc.text("Signature over Printed Name (Payor)", marginX, y);
    doc.text("Signature over Printed Name (Payee)", marginX + sigColW + 10, y);
    y += 10;
    doc.line(marginX, y, marginX + sigColW, y);
    doc.line(marginX + sigColW + 10, y, tableRight, y);
    y += 5;
    doc.text("Date", marginX, y);
    doc.text("Date", marginX + sigColW + 10, y);

    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.text("Generated from " + payorName + "'s Bookkeeping & Tax System — please review all details before signing and filing.", marginX, 287);

    const safeName = (payeeName || "payee").replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
    doc.save(`2307_${safeName}_${monthStr}.pdf`);
  }

  // An expense with tax actually withheld means WE owe the vendor a 2307
  // (we're the withholding agent) — keep one withholding_2307 row (direction
  // 'issued') in sync with each expense row instead of asking for the same
  // numbers twice.
  async function syncExpenseWithholding(expenseId, payload) {
    const taxWithheld = Number(payload.tax_withheld || 0);
    if (taxWithheld > 0) {
      const monthStr = payload.trx_date.slice(0, 7);
      const whPayload = {
        expense_id: expenseId,
        direction: "issued",
        year: Number(payload.trx_date.slice(0, 4)),
        quarter: quarterOf(monthStr),
        month: monthStr + "-01",
        tin: payload.tin,
        payee_name: payload.business_name,
        atc: payload.atc,
        income_payment: payload.amount,
        tax_withheld: taxWithheld,
        invoice_ref: payload.invoice_no,
        business_entity: payload.business_entity || null,
      };
      const { error } = await sb.from("withholding_2307").upsert(whPayload, { onConflict: "expense_id" });
      if (error) toast("Expense saved, but the linked 2307 failed: " + error.message, true);
    } else {
      // No tax withheld (any more) — remove a previously auto-generated 2307 for this expense row, if any.
      await sb.from("withholding_2307").delete().eq("expense_id", expenseId);
    }
  }
  async function fetchExpensesRows() {
    let q = sb.from("expenses").select("*").eq("business_entity", currentExpensesEntity).order("trx_date", { ascending: false });
    const from = $("expenses-f-from").value, to = $("expenses-f-to").value, cat = $("expenses-f-category").value.trim(), search = $("expenses-f-search").value.trim();
    const withholding = $("expenses-f-withholding").value;
    if (from) q = q.gte("trx_date", from);
    if (to) q = q.lte("trx_date", to);
    if (cat) q = q.ilike("category", `%${cat}%`);
    if (search) q = q.ilike("business_name", `%${search}%`);
    if (withholding === "with") q = q.gt("tax_withheld", 0);
    else if (withholding === "without") q = q.or("tax_withheld.is.null,tax_withheld.eq.0");
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  async function loadExpenses() {
    if (!requireDb()) return;
    const [rows, { data: whLinks }] = await Promise.all([
      fetchExpensesRows(),
      sb.from("withholding_2307").select("expense_id").not("expense_id", "is", null),
    ]);
    const has2307 = new Set((whLinks || []).map((w) => w.expense_id));
    const tb = $("expenses-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.business_name)}</td><td>${escapeHtml(r.category || "")}</td>
          <td>${escapeHtml(r.tax_type || "")}</td><td class="num">₱ ${fmtMoney(r.amount)}</td><td>${escapeHtml(r.mode_of_payment || "")}</td>
          <td>${has2307.has(r.id) ? '<span class="badge good">2307</span>' : ""}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-exp="${r.id}">Edit</button>
            <button class="btn small danger" data-del-exp="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="8">No expenses match these filters</td></tr>`;
    tb.querySelectorAll("[data-edit-exp]").forEach((btn) =>
      btn.addEventListener("click", () => editExpense(rows.find((r) => String(r.id) === btn.dataset.editExp)))
    );
    tb.querySelectorAll("[data-del-exp]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("expenses", btn.dataset.delExp, loadExpenses))
    );
  }
  function editExpense(r) {
    if (!r) return;
    $("expenses-id").value = r.id;
    $("expenses-date").value = r.trx_date;
    $("expenses-scope").value = r.business_scope || "LIC PRINTING SHOP";
    $("expenses-taxtype").value = r.tax_type || "VAT";
    $("expenses-tin").value = r.tin || "";
    $("expenses-business").value = r.business_name || "";
    $("expenses-amount").value = r.amount;
    $("expenses-category").value = r.category || "";
    $("expenses-mode").value = r.mode_of_payment || "";
    $("expenses-invoice").value = r.invoice_no || "";
    $("expenses-entity").value = r.business_entity || "";
    $("expenses-atc").value = r.atc || "";
    $("expenses-taxwithheld").value = r.tax_withheld ?? "";
    $("expenses-particulars").value = r.particulars || "";
    $("expenses-remarks").value = r.remarks || "";
    $("expenses-form-title").textContent = "Edit expense";
    $("expenses-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* =====================================================================
     EXPENSES: BULK IMPORT FROM EXCEL (receipt-scanning app export)
     ===================================================================== */
  const IMPORT_FIELD_LABELS = {
    "": "(ignore this column)",
    trx_date: "Date",
    business_name: "Business / payee",
    tin: "TIN",
    amount: "Amount",
    category: "Category",
    mode_of_payment: "Mode of payment",
    tax_type: "Tax type",
    invoice_no: "Invoice / OR no.",
    particulars: "Particulars / notes",
  };
  const IMPORT_FIELD_ORDER = ["trx_date", "business_name", "tin", "amount", "category", "mode_of_payment", "tax_type", "invoice_no", "particulars", ""];

  function guessImportField(header, usedTargets) {
    const h = String(header || "").toLowerCase().trim();
    const rules = [
      { key: "trx_date", test: (h) => /\bdate\b/.test(h) && !/month|quarter|qtr/.test(h) },
      { key: "tax_type", test: (h) => /tax type|vat type|vat\/non-vat/.test(h) },
      { key: "tin", test: (h) => /\btin\b/.test(h) },
      { key: "business_name", test: (h) => /vendor|business|merchant|store|payee|supplier|shop/.test(h) },
      { key: "amount", test: (h) => /\bamount\b/.test(h) && !/vat/.test(h) },
      { key: "category", test: (h) => /\bcategory\b/.test(h) },
      { key: "mode_of_payment", test: (h) => /mode of payment|payment mode|payment method/.test(h) },
      { key: "invoice_no", test: (h) => /receipt.*or no|or no\.?$|receipt no|invoice no/.test(h) },
      { key: "particulars", test: (h) => /description|particulars|notes|remarks|details/.test(h) },
    ];
    for (const rule of rules) {
      if (rule.test(h) && !usedTargets.has(rule.key)) return rule.key;
    }
    return "";
  }

  function parseImportDate(v) {
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    if (typeof v === "number") {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    const s = String(v || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      let [, a, b, y] = m;
      if (y.length === 2) y = "20" + y;
      const iso = `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
      const d2 = new Date(iso);
      if (!isNaN(d2)) return iso;
    }
    const d3 = new Date(s);
    if (!isNaN(d3)) return d3.toISOString().slice(0, 10);
    return "";
  }

  function parseImportAmount(v) {
    if (typeof v === "number") return v;
    const s = String(v || "").replace(/[₱,\s]/g, "");
    if (!s) return NaN;
    const n = Number(s);
    return isNaN(n) ? NaN : n;
  }

  function normalizeTaxType(v) {
    const s = String(v || "").toUpperCase().trim();
    if (!s) return "";
    if (s.includes("NON")) return "NVAT";
    if (s === "VAT") return "VAT";
    if (s.includes("EXEMPT")) return "EXEMPT";
    if (s.includes("NOT") && s.includes("RECEIPT")) return "NOT BIR RECEIPT";
    if (s === "NVAT") return "NVAT";
    return "";
  }

  let importHeaders = [];
  let importRawRows = [];
  let importColMap = {};
  let importPreviewRows = [];

  function initExpensesImport() {
    $("expenses-import-choose").addEventListener("click", () => $("expenses-import-file").click());
    $("expenses-import-file").addEventListener("change", handleImportFile);
    $("expenses-import-buildpreview").addEventListener("click", buildImportPreview);
    $("expenses-import-cancel-map").addEventListener("click", resetImportPanel);
    $("expenses-import-applydefaults").addEventListener("click", () => renderImportPreviewTable(true));
    $("expenses-import-confirm").addEventListener("click", confirmImport);
    $("expenses-import-cancel").addEventListener("click", resetImportPanel);
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!window.XLSX) {
      toast("The Excel reader didn't load — check your internet connection and reload the page.", true);
      return;
    }
    $("expenses-import-filename").textContent = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: "array", cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
        if (!rows.length) { toast("That file looks empty.", true); return; }
        importHeaders = rows[0].map((h) => String(h ?? "").trim());
        importRawRows = rows.slice(1).filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined));
        if (!importRawRows.length) { toast("No data rows found below the header row.", true); return; }
        renderImportMapping();
      } catch (err) {
        toast("Could not read that file: " + err.message, true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderImportMapping() {
    const usedTargets = new Set();
    importColMap = {};
    const html = importHeaders.map((h, i) => {
      const guess = guessImportField(h, usedTargets);
      if (guess) usedTargets.add(guess);
      importColMap[i] = guess;
      const opts = IMPORT_FIELD_ORDER.map(
        (key) => `<option value="${key}" ${key === guess ? "selected" : ""}>${escapeHtml(IMPORT_FIELD_LABELS[key])}</option>`
      ).join("");
      return `<div class="field"><label>${escapeHtml(h || "(column " + (i + 1) + ")")}</label><select data-import-col="${i}">${opts}</select></div>`;
    }).join("");
    $("expenses-import-mapping-rows").innerHTML = html;
    $("expenses-import-mapping-rows").querySelectorAll("[data-import-col]").forEach((sel) => {
      sel.addEventListener("change", () => { importColMap[Number(sel.dataset.importCol)] = sel.value; });
    });
    $("expenses-import-mapping").style.display = "block";
    $("expenses-import-preview").style.display = "none";
  }

  function buildImportPreview() {
    importPreviewRows = importRawRows.map((row) => {
      const rec = { trx_date: "", business_name: "", amount: NaN, category: "", mode_of_payment: "", tin: "", invoice_no: "", particulars: "", tax_type: "" };
      Object.keys(importColMap).forEach((colIdx) => {
        const field = importColMap[colIdx];
        if (!field) return;
        const raw = row[Number(colIdx)];
        if (field === "trx_date") rec.trx_date = parseImportDate(raw);
        else if (field === "amount") rec.amount = parseImportAmount(raw);
        else if (field === "tax_type") rec.tax_type = normalizeTaxType(raw);
        else rec[field] = String(raw ?? "").trim();
      });
      return rec;
    });
    if (!importPreviewRows.length) { toast("No data rows to preview.", true); return; }
    renderImportPreviewTable();
    $("expenses-import-preview").style.display = "block";
  }

  function renderImportPreviewTable(forceDefaultTaxType) {
    const defaultTaxType = $("expenses-import-taxtype").value;
    const taxOpts = ["VAT", "NVAT", "EXEMPT", "NOT BIR RECEIPT"];
    const tb = $("expenses-import-table").querySelector("tbody");
    tb.innerHTML = importPreviewRows.map((r, i) => {
      const tt = forceDefaultTaxType ? defaultTaxType : (r.tax_type || defaultTaxType);
      const amountVal = isNaN(r.amount) ? "" : r.amount;
      return `<tr>
        <td><input type="checkbox" data-imp-include="${i}" checked /></td>
        <td><input type="date" data-imp-date="${i}" value="${r.trx_date || ""}" style="width:130px;" /></td>
        <td><input type="text" data-imp-business="${i}" value="${escapeHtml(r.business_name)}" style="min-width:160px;" /></td>
        <td class="num"><input type="number" step="0.01" data-imp-amount="${i}" value="${amountVal}" style="width:90px;text-align:right;" /></td>
        <td><input type="text" data-imp-category="${i}" value="${escapeHtml(r.category)}" style="width:110px;" /></td>
        <td><input type="text" data-imp-mode="${i}" value="${escapeHtml(r.mode_of_payment)}" style="width:90px;" /></td>
        <td><select data-imp-taxtype="${i}">${taxOpts.map((o) => `<option value="${o}" ${o === tt ? "selected" : ""}>${o}</option>`).join("")}</select></td>
        <td><button type="button" class="btn small danger" data-imp-remove="${i}">Remove</button></td>
      </tr>`;
    }).join("");
    tb.querySelectorAll("[data-imp-remove]").forEach((btn) =>
      btn.addEventListener("click", () => {
        importPreviewRows.splice(Number(btn.dataset.impRemove), 1);
        renderImportPreviewTable();
      })
    );
    tb.querySelectorAll("[data-imp-include]").forEach((cb) => cb.addEventListener("change", updateImportSummary));
    updateImportSummary();
  }

  function updateImportSummary() {
    const total = importPreviewRows.reduce((a, r) => a + (isNaN(r.amount) ? 0 : Number(r.amount)), 0);
    const includedCount = $("expenses-import-table").querySelectorAll("[data-imp-include]:checked").length;
    $("expenses-import-summary").textContent =
      `${importPreviewRows.length} row(s) parsed, ${includedCount} checked for import — total ₱ ${fmtMoney(total)}. Review the fields below, uncheck or fix any that look wrong, then import.`;
  }

  function resetImportPanel() {
    importHeaders = []; importRawRows = []; importColMap = {}; importPreviewRows = [];
    $("expenses-import-file").value = "";
    $("expenses-import-filename").textContent = "";
    $("expenses-import-mapping").style.display = "none";
    $("expenses-import-preview").style.display = "none";
  }

  async function confirmImport() {
    if (!requireDb()) return;
    const scope = $("expenses-import-scope").value;
    const rowsEl = $("expenses-import-table").querySelectorAll("tbody tr");
    const payload = [];
    let skipped = 0;
    rowsEl.forEach((tr, i) => {
      const include = tr.querySelector(`[data-imp-include="${i}"]`).checked;
      if (!include) return;
      const date = tr.querySelector(`[data-imp-date="${i}"]`).value;
      const business = tr.querySelector(`[data-imp-business="${i}"]`).value.trim();
      const amountRaw = tr.querySelector(`[data-imp-amount="${i}"]`).value;
      const amount = amountRaw === "" ? NaN : Number(amountRaw);
      const category = tr.querySelector(`[data-imp-category="${i}"]`).value.trim();
      const mode = tr.querySelector(`[data-imp-mode="${i}"]`).value.trim();
      const taxType = tr.querySelector(`[data-imp-taxtype="${i}"]`).value;
      if (!date || !business || isNaN(amount)) { skipped++; return; }
      payload.push({
        trx_date: date,
        business_name: business,
        amount,
        category: category || null,
        mode_of_payment: mode || null,
        business_scope: scope,
        tax_type: taxType,
        source: "excel-import",
      });
    });
    if (!payload.length) return toast("Nothing valid to import — every row is missing a date, business name, or amount.", true);
    const chunkSize = 200;
    let imported = 0;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      const { error } = await sb.from("expenses").insert(chunk);
      if (error) {
        toast(`Imported ${imported} before an error: ${error.message}`, true);
        loadExpenses();
        return;
      }
      imported += chunk.length;
    }
    toast(`Imported ${imported} expense(s) from Excel${skipped ? `, skipped ${skipped} incomplete row(s)` : ""}`);
    resetImportPanel();
    loadExpenses();
  }

  /* =====================================================================
     EXPENSES: FIND & REMOVE DUPLICATES (same date + invoice/OR number)
     ===================================================================== */
  function initExpensesDedupe() {
    $("expenses-dedupe-scan").addEventListener("click", scanForDuplicateExpenses);
    $("expenses-dedupe-confirm").addEventListener("click", confirmDeleteDuplicateExpenses);
    $("expenses-dedupe-cancel").addEventListener("click", () => {
      dedupeCandidates = [];
      $("expenses-dedupe-results").style.display = "none";
      $("expenses-dedupe-summary").textContent = "";
    });
  }

  let dedupeCandidates = [];
  async function scanForDuplicateExpenses() {
    if (!requireDb()) return;
    $("expenses-dedupe-summary").textContent = "Scanning...";
    const { data, error } = await sb
      .from("expenses")
      .select("id,trx_date,invoice_no,business_name,amount")
      .order("trx_date", { ascending: true })
      .order("id", { ascending: true })
      .limit(5000);
    if (error) { $("expenses-dedupe-summary").textContent = ""; return toast(error.message, true); }

    const groups = {};
    (data || []).forEach((r) => {
      const inv = String(r.invoice_no || "").trim();
      if (!inv) return; // no invoice/OR number to match on — never treat these as duplicates
      const key = r.trx_date + "||" + inv.toUpperCase();
      groups[key] = groups[key] || [];
      groups[key].push(r);
    });

    dedupeCandidates = [];
    Object.values(groups)
      .filter((g) => g.length > 1)
      .forEach((g, gi) => {
        g.forEach((row, idx) => dedupeCandidates.push({ ...row, groupIndex: gi, isFirst: idx === 0 }));
      });

    renderDedupeResults();
  }

  function renderDedupeResults() {
    const panel = $("expenses-dedupe-results");
    if (!dedupeCandidates.length) {
      $("expenses-dedupe-summary").textContent = "No duplicates found (matched by same date + invoice/OR number).";
      panel.style.display = "none";
      return;
    }
    const groupCount = new Set(dedupeCandidates.map((r) => r.groupIndex)).size;
    const toDeleteCount = dedupeCandidates.filter((r) => !r.isFirst).length;
    $("expenses-dedupe-summary").textContent = `Found ${groupCount} matching group(s) — ${toDeleteCount} row(s) proposed for deletion.`;
    const tb = $("expenses-dedupe-table").querySelector("tbody");
    tb.innerHTML = dedupeCandidates
      .map((r, i) => `<tr style="${r.isFirst ? "" : "background:var(--warn-soft);"}">
          <td><input type="checkbox" data-dedupe-del="${i}" ${r.isFirst ? "" : "checked"} /></td>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.invoice_no || "")}</td>
          <td>${escapeHtml(r.business_name || "")}</td><td class="num">₱ ${fmtMoney(r.amount)}</td>
          <td>${r.isFirst ? '<span class="badge good">KEEP (oldest)</span>' : '<span class="badge warn">DUPLICATE</span>'}</td>
        </tr>`)
      .join("");
    panel.style.display = "block";
  }

  async function confirmDeleteDuplicateExpenses() {
    if (!requireDb()) return;
    const checks = $("expenses-dedupe-table").querySelectorAll("[data-dedupe-del]");
    const idsToDelete = [];
    checks.forEach((cb, i) => { if (cb.checked) idsToDelete.push(dedupeCandidates[i].id); });
    if (!idsToDelete.length) return toast("Nothing checked for deletion", true);
    if (!confirm(`Delete ${idsToDelete.length} duplicate expense(s)? This can't be undone.`)) return;
    const { error } = await sb.from("expenses").delete().in("id", idsToDelete);
    if (error) return toast(error.message, true);
    toast(`Deleted ${idsToDelete.length} duplicate expense(s)`);
    dedupeCandidates = [];
    $("expenses-dedupe-results").style.display = "none";
    $("expenses-dedupe-summary").textContent = "";
    loadExpenses();
  }

  /* =====================================================================
     PETTY CASH VOUCHERS (liaison/messenger reimbursements)
     ===================================================================== */
  function initPettyCashForm() {
    $("pettycash-date").value = todayISO();
    $("pettycash-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("pettycash-id").value;
      const payload = {
        business_entity: $("pettycash-entity").value,
        trx_date: $("pettycash-date").value,
        staff_name: $("pettycash-staff").value.trim(),
        amount: Number($("pettycash-amount").value || 0),
        particulars: $("pettycash-particulars").value.trim() || null,
        remarks: $("pettycash-remarks").value.trim() || null,
      };
      let error;
      if (id) ({ error } = await sb.from("petty_cash_vouchers").update(payload).eq("id", id));
      else ({ error } = await sb.from("petty_cash_vouchers").insert(payload));
      if (error) return toast(error.message, true);
      toast(id ? "Voucher updated" : "Voucher saved");
      resetPettyCashForm();
      loadPettyCash();
    });
    $("pettycash-cancel-edit").addEventListener("click", resetPettyCashForm);
    $("pettycash-f-apply").addEventListener("click", loadPettyCash);
    $("pettycash-f-status").addEventListener("change", loadPettyCash);
  }
  function resetPettyCashForm() {
    $("pettycash-form").reset();
    $("pettycash-id").value = "";
    $("pettycash-date").value = todayISO();
    $("pettycash-form-title").textContent = "Log a petty cash voucher";
    $("pettycash-cancel-edit").style.display = "none";
  }
  async function loadPettyCash() {
    if (!requireDb()) return;
    const status = $("pettycash-f-status").value;
    let q = sb.from("petty_cash_vouchers").select("*").order("trx_date", { ascending: false });
    if (status) q = q.eq("status", status);
    const { data, error } = await q.limit(500);
    if (error) return toast(error.message, true);
    const rows = data || [];
    const tb = $("pettycash-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${escapeHtml(entityLabel(r.business_entity))}</td><td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.staff_name)}</td>
          <td class="num">₱ ${fmtMoney(r.amount)}</td><td>${escapeHtml(r.particulars || "")}</td>
          <td>${r.status === "reimbursed" ? statusBadge("FULLY PAID") : statusBadge("UNPAID")}</td>
          <td>${r.reimbursed_date ? fmtDate(r.reimbursed_date) : ""}</td>
          <td class="row-actions">
            ${r.status === "pending" ? `<button class="btn small accent" data-reimburse="${r.id}">Mark reimbursed</button>` : ""}
            <button class="btn small" data-edit-pc="${r.id}">Edit</button>
            <button class="btn small danger" data-del-pc="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="8">No petty cash vouchers logged yet</td></tr>`;
    tb.querySelectorAll("[data-edit-pc]").forEach((btn) =>
      btn.addEventListener("click", () => editPettyCash(rows.find((r) => String(r.id) === btn.dataset.editPc)))
    );
    tb.querySelectorAll("[data-del-pc]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("petty_cash_vouchers", btn.dataset.delPc, loadPettyCash))
    );
    tb.querySelectorAll("[data-reimburse]").forEach((btn) =>
      btn.addEventListener("click", () => reimbursePettyCash(rows.find((r) => String(r.id) === btn.dataset.reimburse)))
    );
  }
  function editPettyCash(r) {
    if (!r) return;
    $("pettycash-id").value = r.id;
    $("pettycash-entity").value = r.business_entity || "SOLE PROPRIETORSHIP";
    $("pettycash-date").value = r.trx_date;
    $("pettycash-staff").value = r.staff_name || "";
    $("pettycash-amount").value = r.amount;
    $("pettycash-particulars").value = r.particulars || "";
    $("pettycash-remarks").value = r.remarks || "";
    $("pettycash-form-title").textContent = "Edit petty cash voucher";
    $("pettycash-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // Marking a voucher reimbursed is the moment it actually becomes a
  // company cash outflow -- create the matching expense row dated today
  // (the reimbursement day), not the day the liaison originally spent it.
  async function reimbursePettyCash(r) {
    if (!r) return;
    if (!confirm(`Mark ₱${fmtMoney(r.amount)} to ${r.staff_name} as reimbursed today, and create the matching expense entry?`)) return;
    const today = todayISO();
    const { data: expRow, error: expErr } = await sb.from("expenses").insert({
      trx_date: today,
      business_scope: "LIC PRINTING SHOP",
      business_entity: r.business_entity,
      tax_type: "NOT BIR RECEIPT",
      business_name: `PETTY CASH — ${r.staff_name}`,
      amount: r.amount,
      category: "PETTY CASH REIMBURSEMENT",
      particulars: r.particulars || null,
      remarks: `Reimbursement for voucher logged ${fmtDate(r.trx_date)}`,
    }).select("id").single();
    if (expErr) return toast(expErr.message, true);
    const { error } = await sb.from("petty_cash_vouchers").update({
      status: "reimbursed", reimbursed_date: today, expense_id: expRow.id,
    }).eq("id", r.id);
    if (error) return toast(error.message, true);
    toast("Voucher marked reimbursed — expense entry created");
    loadPettyCash();
  }

  /* =====================================================================
     RECEIVABLES
     ===================================================================== */
  let receivablesWired = false;
  async function loadReceivables() {
    if (!requireDb()) return;
    if (!receivablesWired) {
      receivablesWired = true;
      $("receivables-f-apply").addEventListener("click", loadReceivables);
      $("receivables-f-entity").addEventListener("change", loadReceivables);
      $("receivables-f-search").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); loadReceivables(); }
      });
      $("receivables-f-clear").addEventListener("click", () => {
        $("receivables-f-search").value = "";
        $("receivables-f-entity").value = "";
        loadReceivables();
      });
    }
    let q = sb.from("v_sales_status").select("*").neq("balance", 0).order("trx_date", { ascending: true });
    const search = $("receivables-f-search").value.trim();
    const entity = $("receivables-f-entity").value;
    if (search) q = q.ilike("tradename", `%${search}%`);
    if (entity) q = q.eq("business_entity", entity);
    const { data, error } = await q.limit(500);
    if (error) return toast(error.message, true);
    const rows = data || [];
    const total = rows.reduce((a, r) => a + Number(r.balance || 0), 0);
    const oldest = rows[0];
    $("receivables-cards").innerHTML = `
      <div class="stat-card"><div class="label">Total outstanding</div><div class="value warn">₱ ${fmtMoney(total)}</div></div>
      <div class="stat-card"><div class="label">Open balances</div><div class="value">${rows.length}</div></div>
      <div class="stat-card"><div class="label">Oldest unpaid</div><div class="value" style="font-size:15px;">${oldest ? fmtDate(oldest.trx_date) + " — " + escapeHtml(oldest.tradename) : "—"}</div></div>
    `;
    const tb = $("receivables-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.tradename)}</td><td>${escapeHtml(r.reference_person || "")}</td>
          <td class="num">₱ ${fmtMoney(r.total_amount)}</td><td class="num">₱ ${fmtMoney(r.amount_received)}</td>
          <td class="num">₱ ${fmtMoney(r.balance)}</td><td>${r.age_days} day${r.age_days === 1 ? "" : "s"}</td>
          <td class="row-actions"><button class="btn small accent" data-pay="${r.id}" data-bal="${r.balance}">Record payment</button></td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="8">Nothing outstanding — everything's paid up 🎉</td></tr>`;
    tb.querySelectorAll("[data-pay]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const amt = prompt(`Balance is ₱${fmtMoney(btn.dataset.bal)}. How much was just paid?`);
        if (amt === null) return;
        const n = Number(amt);
        if (!(n > 0)) return toast("Enter a valid amount", true);
        const { data: current, error: e1 } = await sb.from("sales").select("amount_received").eq("id", btn.dataset.pay).single();
        if (e1) return toast(e1.message, true);
        const { error } = await sb.from("sales").update({ amount_received: Number(current.amount_received || 0) + n }).eq("id", btn.dataset.pay);
        if (error) return toast(error.message, true);
        toast("Payment recorded");
        loadReceivables();
      })
    );
  }

  /* =====================================================================
     BILL TRACKER
     ===================================================================== */
  function initBillsForm() {
    $("bills-period").value = monthISO();
    $("biller-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const { error } = await sb.from("billers").insert({
        name: $("biller-name").value.trim(),
        typical_due_day: $("biller-due-day").value.trim() || null,
      });
      if (error) return toast(error.message, true);
      toast("Biller added");
      $("biller-form").reset();
      loadBills();
    });
    $("bills-period").addEventListener("change", loadBills);
    $("bills-f-apply").addEventListener("click", loadBills);
    $("bills-f-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadBills(); }
    });
    $("bills-f-clear").addEventListener("click", () => {
      $("bills-f-search").value = "";
      loadBills();
    });
  }
  async function loadBills() {
    if (!requireDb()) return;
    const period = $("bills-period").value || monthISO();
    const search = $("bills-f-search").value.trim();
    let billerQuery = sb.from("billers").select("*").eq("active", true).order("name");
    if (search) billerQuery = billerQuery.ilike("name", `%${search}%`);
    const { data: billers, error } = await billerQuery;
    if (error) return toast(error.message, true);
    const { data: payments } = await sb.from("bill_payments").select("*").eq("period", period);
    const byBiller = {};
    (payments || []).forEach((p) => (byBiller[p.biller_id] = p));

    const tb = $("bills-table").querySelector("tbody");
    tb.innerHTML = (billers || []).length
      ? billers.map((b) => {
          const p = byBiller[b.id];
          const paid = p && Number(p.amount_paid || 0) >= Number(p.total_amount || 0) && Number(p.total_amount || 0) > 0;
          const overdue = !paid && p?.due_date && p.due_date < todayISO();
          const status = paid ? statusBadge("FULLY PAID") : p?.amount_paid > 0 ? statusBadge("PARTIAL") : overdue ? statusBadge("UNPAID") : statusBadge("N/A");
          return `<tr>
            <td>${escapeHtml(b.name)}</td>
            <td><input type="date" class="bp-due" data-biller="${b.id}" value="${p?.due_date || ""}" /></td>
            <td><input type="number" step="0.01" class="bp-total" data-biller="${b.id}" value="${p?.total_amount ?? ""}" style="width:90px;" /></td>
            <td><input type="number" step="0.01" class="bp-paid" data-biller="${b.id}" value="${p?.amount_paid ?? ""}" style="width:90px;" /></td>
            <td><input type="date" class="bp-datepaid" data-biller="${b.id}" value="${p?.date_paid || ""}" /></td>
            <td><input list="payment-modes" class="bp-mode" data-biller="${b.id}" value="${escapeHtml(p?.mode_of_payment || "")}" style="width:100px;" /></td>
            <td>${status}</td>
            <td class="row-actions"><button class="btn small" data-save-bill="${b.id}">Save</button></td>
          </tr>`;
        }).join("")
      : `<tr class="empty-row"><td colspan="8">No billers yet — add one above</td></tr>`;

    tb.querySelectorAll("[data-save-bill]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.saveBill;
        const row = (r) => tb.querySelector(`.${r}[data-biller="${id}"]`).value;
        const payload = {
          biller_id: Number(id),
          period,
          due_date: row("bp-due") || null,
          total_amount: row("bp-total") === "" ? null : Number(row("bp-total")),
          amount_paid: row("bp-paid") === "" ? null : Number(row("bp-paid")),
          date_paid: row("bp-datepaid") || null,
          mode_of_payment: row("bp-mode") || null,
        };
        const { error } = await sb.from("bill_payments").upsert(payload, { onConflict: "biller_id,period" });
        if (error) return toast(error.message, true);
        toast("Saved");
        loadBills();
      })
    );
  }

  /* =====================================================================
     ISSUED INVOICES (compliance)
     ===================================================================== */
  // The manual "log an issued invoice" form was removed (item 8) -- this
  // register is now fed only by the auto-sync from Daily Sales (a row
  // appears exactly when a BIR receipt no. is entered there), plus the
  // pre-existing historical rows carried over from the Declarations sheet.
  function initInvoicesForm() {
    $("invoices-f-apply").addEventListener("click", loadInvoices);
    $("invoices-f-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadInvoices(); }
    });
    ["invoices-f-month", "invoices-f-entity"].forEach((id) => $(id).addEventListener("change", loadInvoices));
    $("invoices-f-clear").addEventListener("click", () => {
      $("invoices-f-month").value = "";
      $("invoices-f-search").value = "";
      $("invoices-f-entity").value = "";
      loadInvoices();
    });
    $("invoices-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchInvoicesRows();
      downloadCSV("sales_report.csv", rows, [
        { label: "Month", key: "month_declared" }, { label: "Date", key: "invoice_date" },
        { label: "Invoice No", key: "invoice_no" }, { label: "TIN", key: "tin" }, { label: "Customer", key: "customer_name" },
        { label: "Business Entity", key: "business_entity" },
        { label: "Gross", key: "gross_sales" }, { label: "Net", key: "net_sales" }, { label: "VAT", key: "vat" },
        { label: "Withholding Tax", key: "withholding_tax" }, { label: "With 2307", key: "with_2307" },
      ]);
    });
    $("invoices-export-slsp").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = (await fetchInvoicesRows()).filter((r) => !r.cancelled);
      exportSlsRelief(rows);
    });
  }
  // Standard BIR RELIEF/SLSP-style column layout for a Summary List of
  // Sales. This matches the well-known public RELIEF column set; BIR's own
  // Data Entry Module (DEM) may expect a specific .dat layout for direct
  // upload -- that exact fixed-format spec isn't something to guess at, so
  // it's not included here. Ask 5JS's usual DEM version for that layout and
  // this can be added as a companion export once confirmed.
  // Only Sole Prop rows go on a VAT SLS -- Corp is Non-VAT and isn't part
  // of a VAT filing. A row with ₱0 VAT is bucketed as Exempt/Zero-rated
  // (this register doesn't keep the two separate at the invoice level, only
  // on the Daily Sales row itself for entries made after this feature).
  function exportSlsRelief(rows) {
    const data = rows
      .filter((r) => r.business_entity === "SOLE PROPRIETORSHIP")
      .map((r) => {
        const vat = Number(r.vat || 0);
        return {
          "TIN": r.tin || "", "Registered Name": r.customer_name || "", "Address": "",
          "Exempt / Zero-Rated Sales": vat === 0 ? Number(r.gross_sales || 0) : 0,
          "Taxable Net Sales": vat > 0 ? Number(r.net_sales || 0) : 0,
          "Output Tax": vat,
          "Gross Sales": Number(r.gross_sales || 0),
        };
      });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SLS");
    XLSX.writeFile(wb, "sales_report_SLS_relief.xlsx");
  }
  async function fetchInvoicesRows() {
    let q = sb.from("issued_invoices").select("*").order("month_declared", { ascending: false });
    const month = $("invoices-f-month").value, search = $("invoices-f-search").value.trim(), entity = $("invoices-f-entity").value;
    if (month) q = q.eq("month_declared", month + "-01");
    if (search) q = q.ilike("customer_name", `%${search}%`);
    if (entity) q = q.eq("business_entity", entity);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  async function loadInvoices() {
    if (!requireDb()) return;
    const rows = await fetchInvoicesRows();
    const tb = $("invoices-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtMonth((r.month_declared || "").slice(0, 7))}</td><td>${fmtDate(r.invoice_date)}</td>
          <td>${escapeHtml(r.invoice_no || "")}${r.cancelled ? ' <span class="badge bad">CANCELLED</span>' : ""}${r.sale_id ? ' <span class="badge neutral">auto</span>' : ""}</td>
          <td>${escapeHtml(r.customer_name)}</td><td>${escapeHtml(entityLabel(r.business_entity))}</td><td class="num">₱ ${fmtMoney(r.gross_sales)}</td>
          <td class="num">₱ ${fmtMoney(r.net_sales)}</td><td class="num">₱ ${fmtMoney(r.vat)}</td>
          <td class="num">₱ ${fmtMoney(r.withholding_tax)}</td><td>${r.with_2307 ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
          <td class="row-actions">
            ${r.sale_id ? '<span class="hint">edit via Daily Sales</span>' : `<button class="btn small danger" data-del-inv="${r.id}">Del</button>`}
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="11">No invoices match these filters</td></tr>`;
    tb.querySelectorAll("[data-del-inv]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("issued_invoices", btn.dataset.delInv, loadInvoices))
    );
  }

  /* =====================================================================
     EXPENSES REPORT (Tax & Compliance) — all logged expenses, both entities
     ===================================================================== */
  let lastExpReportRows = [];
  function initExpensesReportForm() {
    const y = new Date().getFullYear(), m = String(new Date().getMonth() + 1).padStart(2, "0");
    $("expreport-from").value = `${y}-${m}-01`;
    $("expreport-to").value = todayISO();
    $("expreport-apply").addEventListener("click", loadExpensesReport);
    $("expreport-entity").addEventListener("change", loadExpensesReport);
    $("expreport-category").addEventListener("change", loadExpensesReport);
    ["expreport-from", "expreport-to"].forEach((id) => $(id).addEventListener("change", loadExpensesReport));
    $("expreport-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadExpensesReport(); }
    });
    $("expreport-mtd").addEventListener("click", () => {
      const yy = new Date().getFullYear(), mm = String(new Date().getMonth() + 1).padStart(2, "0");
      $("expreport-from").value = `${yy}-${mm}-01`;
      $("expreport-to").value = todayISO();
      loadExpensesReport();
    });
    $("expreport-export").addEventListener("click", () => {
      if (!lastExpReportRows.length) return toast("Nothing to export yet — run the report first", true);
      downloadCSV("expenses_report.csv", lastExpReportRows, [
        { label: "Date", key: "trx_date" }, { label: "Business", key: "business_name" },
        { label: "Category", key: "category" }, { label: "Tax Type", key: "tax_type" },
        { label: "Business Entity", key: "business_entity" }, { label: "Amount", key: "amount" },
        { label: "Mode", key: "mode_of_payment" }, { label: "ATC", key: "atc" }, { label: "Tax Withheld", key: "tax_withheld" },
      ]);
    });
    $("expreport-export-slp").addEventListener("click", () => {
      if (!lastExpReportRows.length) return toast("Nothing to export yet — run the report first", true);
      exportSlpRelief(lastExpReportRows);
    });
  }
  // Standard BIR RELIEF-style Summary List of Purchases columns. Same DAT-
  // format caveat as the Sales export above -- this is the Excel/.xlsx
  // layout, not BIR's DEM upload format.
  function exportSlpRelief(rows) {
    const data = rows
      .filter((r) => r.tax_type === "VAT" && (r.tin || "").trim())
      .map((r) => ({
        "TIN": r.tin, "Registered Name": r.business_name || "", "Address": "",
        "Amount of Purchases": Number(r.amount || 0),
        "Input Tax": Number(r.amount || 0) - Number(r.amount || 0) / 1.12,
        "Creditable Withholding Tax": Number(r.tax_withheld || 0),
      }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SLP");
    XLSX.writeFile(wb, "expenses_report_SLP_relief.xlsx");
  }
  // Category filter (item 9): "VAT, with TIN" / "With withholding tax" /
  // "Non-VAT" / "Others" (exempt, no BIR receipt, or anything else).
  function matchesExpReportCategory(r, cat) {
    if (!cat) return true;
    if (cat === "vat_tin") return r.tax_type === "VAT" && !!(r.tin || "").trim();
    if (cat === "withholding") return Number(r.tax_withheld || 0) > 0;
    if (cat === "nonvat") return r.tax_type === "NVAT";
    if (cat === "others") return r.tax_type === "EXEMPT" || r.tax_type === "NOT BIR RECEIPT" || !r.tax_type;
    return true;
  }
  async function loadExpensesReport() {
    if (!requireDb()) return;
    if (!$("expreport-from").value) $("expreport-from").value = todayISO();
    if (!$("expreport-to").value) $("expreport-to").value = todayISO();
    const from = $("expreport-from").value;
    const to = $("expreport-to").value;
    const entity = $("expreport-entity").value;
    const search = $("expreport-search").value.trim();
    const category = $("expreport-category").value;

    let q = sb.from("expenses").select("*").gte("trx_date", from).lte("trx_date", to).order("trx_date", { ascending: false });
    if (entity) q = q.eq("business_entity", entity);
    if (search) q = q.ilike("business_name", `%${search}%`);
    const { data, error } = await q.limit(2000);
    if (error) return toast(error.message, true);
    const rows = (data || []).filter((r) => matchesExpReportCategory(r, category));
    lastExpReportRows = rows;

    const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
    const vatTotal = rows.filter((r) => r.tax_type === "VAT").reduce((a, r) => a + Number(r.amount || 0), 0);
    const nonVatTotal = total - vatTotal;

    function card(label, value, cls) {
      return `<div class="stat-card"><div class="label">${label}</div><div class="value ${cls}">₱ ${value}</div></div>`;
    }
    $("expreport-cards").innerHTML = [
      card("Total expenses", fmtMoney(total), "bad"),
      card("VAT-tagged", fmtMoney(vatTotal), "warn"),
      card("Non-VAT / other", fmtMoney(nonVatTotal), "neutral"),
    ].join("");

    const cats = {};
    rows.forEach((r) => {
      const c = r.category || "(uncategorized)";
      if (!cats[c]) cats[c] = { count: 0, total: 0 };
      cats[c].count += 1;
      cats[c].total += Number(r.amount || 0);
    });
    const catNames = Object.keys(cats).sort((a, b) => cats[b].total - cats[a].total);
    const catBody = $("expreport-category-table").querySelector("tbody");
    catBody.innerHTML = catNames.length
      ? catNames.map((c) => `<tr><td>${escapeHtml(c)}</td><td class="num">${cats[c].count}</td><td class="num">₱ ${fmtMoney(cats[c].total)}</td></tr>`).join("")
      : `<tr class="empty-row"><td colspan="3">No expenses in this period</td></tr>`;

    const tb = $("expreport-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.business_name)}</td><td>${escapeHtml(r.category || "")}</td>
          <td>${escapeHtml(r.tax_type || "")}</td><td>${escapeHtml(entityLabel(r.business_entity))}</td>
          <td class="num">₱ ${fmtMoney(r.amount)}</td><td>${escapeHtml(r.mode_of_payment || "")}</td>
          <td>${escapeHtml(r.atc || "")}</td><td class="num">${r.tax_withheld ? "₱ " + fmtMoney(r.tax_withheld) : ""}</td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="9">No expenses match these filters</td></tr>`;
  }

  /* =====================================================================
     2307 WITHHOLDING REGISTER
     ===================================================================== */
  function initWithholdingForm() {
    $("withholding-year").value = new Date().getFullYear();
    $("withholding-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("withholding-id").value;
      const payload = {
        direction: $("withholding-direction").value || "received",
        year: Number($("withholding-year").value),
        quarter: $("withholding-quarter").value,
        month: $("withholding-month").value ? $("withholding-month").value + "-01" : null,
        tin: $("withholding-tin").value.trim() || null,
        payee_name: $("withholding-payee").value.trim(),
        atc: $("withholding-atc").value.trim() || null,
        income_payment: Number($("withholding-income").value || 0),
        tax_withheld: Number($("withholding-tax").value || 0),
        invoice_ref: $("withholding-invref").value.trim() || null,
        issued: $("withholding-issued").checked,
      };
      let error;
      if (id) ({ error } = await sb.from("withholding_2307").update(payload).eq("id", id));
      else ({ error } = await sb.from("withholding_2307").insert(payload));
      if (error) return toast(error.message, true);
      toast(id ? "2307 updated" : "2307 saved");
      resetWithholdingForm();
      loadWithholding();
    });
    $("withholding-cancel-edit").addEventListener("click", resetWithholdingForm);
    $("withholding-f-apply").addEventListener("click", loadWithholding);
    $("withholding-f-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); loadWithholding(); }
    });
    ["withholding-f-year", "withholding-f-quarter", "withholding-f-direction"].forEach((id) =>
      $(id).addEventListener("change", loadWithholding)
    );
    $("withholding-f-clear").addEventListener("click", () => {
      $("withholding-f-search").value = "";
      $("withholding-f-year").value = "";
      $("withholding-f-quarter").value = "";
      $("withholding-f-direction").value = "";
      loadWithholding();
    });
    $("withholding-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchWithholdingRows();
      downloadCSV("withholding_2307.csv", rows, [
        { label: "Direction", key: "direction" }, { label: "Year", key: "year" }, { label: "Quarter", key: "quarter" }, { label: "Month", key: "month" },
        { label: "TIN", key: "tin" }, { label: "Payee", key: "payee_name" }, { label: "ATC", key: "atc" },
        { label: "Income Payment", key: "income_payment" }, { label: "Tax Withheld", key: "tax_withheld" }, { label: "Issued", key: "issued" },
      ]);
    });
  }
  function resetWithholdingForm() {
    $("withholding-form").reset();
    $("withholding-id").value = "";
    $("withholding-direction").value = "received";
    $("withholding-year").value = new Date().getFullYear();
    $("withholding-form-title").textContent = "Log a 2307";
    $("withholding-cancel-edit").style.display = "none";
  }
  async function fetchWithholdingRows() {
    let q = sb.from("withholding_2307").select("*").order("year", { ascending: false }).order("quarter", { ascending: false });
    const year = $("withholding-f-year").value, qtr = $("withholding-f-quarter").value, direction = $("withholding-f-direction").value;
    const search = $("withholding-f-search").value.trim().replace(/[,()]/g, "");
    if (year) q = q.eq("year", Number(year));
    if (qtr) q = q.eq("quarter", qtr);
    if (direction) q = q.eq("direction", direction);
    if (search) q = q.or(`payee_name.ilike.%${search}%,tin.ilike.%${search}%,atc.ilike.%${search}%`);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  function directionBadge(d) {
    return d === "issued" ? '<span class="badge warn">Issued</span>' : '<span class="badge good">Received</span>';
  }
  function clientIssuedBadge(r) {
    if (r.direction !== "received") return "";
    if (r.client_issued === true) return '<span class="badge good">Issued by client</span>';
    if (r.client_issued === false) return '<span class="badge warn">Pending from client</span>';
    return '<span class="badge neutral">Not asked yet</span>';
  }
  async function loadWithholding() {
    if (!requireDb()) return;
    const rows = await fetchWithholdingRows();
    const tb = $("withholding-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${directionBadge(r.direction)}</td>
          <td>${r.year || ""}</td><td>${escapeHtml(r.quarter || "")}</td><td>${r.month ? fmtMonth(r.month.slice(0, 7)) : ""}</td>
          <td>${escapeHtml(r.payee_name)}</td><td>${escapeHtml(r.atc || "")}</td>
          <td class="num">₱ ${fmtMoney(r.income_payment)}</td><td class="num">₱ ${fmtMoney(r.tax_withheld)}</td>
          <td>${r.issued ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
          <td>
            ${clientIssuedBadge(r)}
            ${r.direction === "received" ? `
              ${r.certificate_file_path ? `<button class="btn small ghost" data-view-cert="${r.id}">View file</button>` : ""}
              <button class="btn small ghost" data-mark-issued="${r.id}">Mark issued</button>
              <button class="btn small ghost" data-mark-pending="${r.id}">Mark pending</button>
            ` : ""}
          </td>
          <td class="row-actions">
            ${r.direction === "issued" ? `<button class="btn small accent" data-pdf-wh="${r.id}">Download 2307</button>` : ""}
            <button class="btn small" data-edit-wh="${r.id}">Edit</button>
            <button class="btn small danger" data-del-wh="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="11">No 2307s match these filters</td></tr>`;
    tb.querySelectorAll("[data-edit-wh]").forEach((btn) =>
      btn.addEventListener("click", () => editWithholding(rows.find((r) => String(r.id) === btn.dataset.editWh)))
    );
    tb.querySelectorAll("[data-del-wh]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("withholding_2307", btn.dataset.delWh, loadWithholding))
    );
    tb.querySelectorAll("[data-pdf-wh]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const r = rows.find((row) => String(row.id) === btn.dataset.pdfWh);
        if (!r) return;
        download2307Pdf({
          entity: r.business_entity,
          payeeName: r.payee_name,
          tin: r.tin,
          atc: r.atc,
          incomePayment: r.income_payment,
          taxWithheld: r.tax_withheld,
          periodDate: r.month || (r.year ? `${r.year}-01-01` : null),
          invoiceRef: r.invoice_ref,
        });
      })
    );
    tb.querySelectorAll("[data-mark-issued],[data-mark-pending]").forEach((btn) => {
      const id = btn.dataset.markIssued || btn.dataset.markPending;
      btn.addEventListener("click", async () => {
        const { error } = await sb.from("withholding_2307").update({ client_issued: !!btn.dataset.markIssued }).eq("id", id);
        if (error) return toast(error.message, true);
        toast("2307 status updated");
        loadWithholding();
      });
    });
    tb.querySelectorAll("[data-view-cert]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const r = rows.find((row) => String(row.id) === btn.dataset.viewCert);
        if (!r || !r.certificate_file_path) return;
        const { data, error } = await sb.storage.from("attachments").createSignedUrl(r.certificate_file_path, 300);
        if (error) return toast("Couldn't open the file: " + error.message, true);
        window.open(data.signedUrl, "_blank");
      })
    );
  }
  function editWithholding(r) {
    if (!r) return;
    $("withholding-id").value = r.id;
    $("withholding-direction").value = r.direction || "received";
    $("withholding-year").value = r.year || "";
    $("withholding-quarter").value = r.quarter || "Q1";
    $("withholding-month").value = r.month ? r.month.slice(0, 7) : "";
    $("withholding-tin").value = r.tin || "";
    $("withholding-payee").value = r.payee_name || "";
    $("withholding-atc").value = r.atc || "";
    $("withholding-income").value = r.income_payment;
    $("withholding-tax").value = r.tax_withheld;
    $("withholding-invref").value = r.invoice_ref || "";
    $("withholding-issued").checked = !!r.issued;
    $("withholding-form-title").textContent = "Edit 2307";
    $("withholding-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* =====================================================================
     DAILY OPERATIONS REPORT (cash/sales summary + staff performance)
     ===================================================================== */
  let lastExpCatRows = [];
  function initOpsReportForm() {
    $("opsreport-from").value = todayISO();
    $("opsreport-to").value = todayISO();
    $("opsreport-apply").addEventListener("click", loadOpsReport);
    ["opsreport-from", "opsreport-to", "opsreport-entity"].forEach((id) => $(id).addEventListener("change", loadOpsReport));
    $("opsreport-today").addEventListener("click", () => {
      $("opsreport-from").value = todayISO();
      $("opsreport-to").value = todayISO();
      loadOpsReport();
    });
    $("opsreport-expcat-export").addEventListener("click", () => {
      if (!lastExpCatRows.length) return toast("Nothing to export yet — run the report first", true);
      downloadCSV("expenses_by_category.csv", lastExpCatRows, [
        { label: "Category", key: "category" }, { label: "# Transactions", key: "count" },
        { label: "Total", key: "total" }, { label: "% of expenses", get: (r) => r.pct.toFixed(1) },
      ]);
    });
  }

  async function loadOpsReport() {
    if (!requireDb()) return;
    if (!$("opsreport-from").value) $("opsreport-from").value = todayISO();
    if (!$("opsreport-to").value) $("opsreport-to").value = todayISO();
    const from = $("opsreport-from").value;
    const to = $("opsreport-to").value;
    const entity = $("opsreport-entity").value;

    let salesQuery = sb.from("sales").select("id,trx_date,tradename,total_amount,amount_received,balance,mode_of_payment,reference_person,business_entity,is_walkin,invoice_no,bir_receipt_no").gte("trx_date", from).lte("trx_date", to);
    if (entity) salesQuery = salesQuery.eq("business_entity", entity);
    let expQuery = sb.from("expenses").select("trx_date,amount,mode_of_payment,category,business_name,business_entity").gte("trx_date", from).lte("trx_date", to);
    if (entity) expQuery = expQuery.eq("business_entity", entity);
    let commQuery = sb.from("staff_commissions").select("*").gte("trx_date", from).lte("trx_date", to).order("trx_date", { ascending: false });
    if (entity) commQuery = commQuery.eq("business_entity", entity);

    const [{ data: sales, error: sErr }, { data: exp, error: eErr }, { data: commissions, error: cErr }] = await Promise.all([
      salesQuery,
      expQuery,
      commQuery,
    ]);
    if (sErr) return toast(sErr.message, true);
    if (eErr) return toast(eErr.message, true);
    if (cErr) console.warn("staff_commissions load failed", cErr.message);

    const sum = (rows, key) => (rows || []).reduce((a, r) => a + Number(r[key] || 0), 0);
    const totalSales = sum(sales, "total_amount");
    const totalReceived = sum(sales, "amount_received");
    const totalExpenses = sum(exp, "amount");
    const netCash = totalReceived - totalExpenses;

    function card(label, value, cls) {
      return `<div class="stat-card"><div class="label">${label}</div><div class="value ${cls}">₱ ${value}</div></div>`;
    }
    $("opsreport-cards").innerHTML = [
      card("Total sales (period)", fmtMoney(totalSales), "good"),
      card("Amount received (period)", fmtMoney(totalReceived), "good"),
      card("Total expenses (period)", fmtMoney(totalExpenses), "bad"),
      card("Net cash", fmtMoney(netCash), netCash >= 0 ? "good" : "bad"),
    ].join("");

    // ---- by entity (only shown when "Combined" is selected — item 5) ----
    const entityPanel = $("opsreport-entity-panel");
    if (!entity) {
      entityPanel.style.display = "";
      const byEntity = {};
      ["SOLE PROPRIETORSHIP", "CORPORATION"].forEach((e) => (byEntity[e] = { sales: 0, received: 0, exp: 0 }));
      (sales || []).forEach((r) => {
        const e = r.business_entity || "SOLE PROPRIETORSHIP";
        byEntity[e] = byEntity[e] || { sales: 0, received: 0, exp: 0 };
        byEntity[e].sales += Number(r.total_amount || 0);
        byEntity[e].received += Number(r.amount_received || 0);
      });
      (exp || []).forEach((r) => {
        const e = r.business_entity || "SOLE PROPRIETORSHIP";
        byEntity[e] = byEntity[e] || { sales: 0, received: 0, exp: 0 };
        byEntity[e].exp += Number(r.amount || 0);
      });
      const etb = $("opsreport-entity-table").querySelector("tbody");
      etb.innerHTML = Object.keys(byEntity).map((e) => `<tr>
          <td>${escapeHtml(fullEntityLabel(e))}</td><td class="num">₱ ${fmtMoney(byEntity[e].sales)}</td>
          <td class="num">₱ ${fmtMoney(byEntity[e].received)}</td><td class="num">₱ ${fmtMoney(byEntity[e].exp)}</td>
        </tr>`).join("");
    } else {
      entityPanel.style.display = "none";
    }

    // ---- with vs without BIR receipt (item 14) ----
    const withReceipt = (sales || []).filter((r) => (r.bir_receipt_no || "").trim());
    const withoutReceipt = (sales || []).filter((r) => !(r.bir_receipt_no || "").trim());
    const birTb = $("opsreport-bir-table").querySelector("tbody");
    birTb.innerHTML = `
      <tr><td>With BIR receipt no.</td><td class="num">${withReceipt.length}</td><td class="num">₱ ${fmtMoney(sum(withReceipt, "total_amount"))}</td></tr>
      <tr><td>Without BIR receipt no.</td><td class="num">${withoutReceipt.length}</td><td class="num">₱ ${fmtMoney(sum(withoutReceipt, "total_amount"))}</td></tr>
      <tr><td><strong>TOTAL</strong></td><td class="num"><strong>${(sales || []).length}</strong></td><td class="num"><strong>₱ ${fmtMoney(totalSales)}</strong></td></tr>`;

    // ---- breakdown by mode of payment (for closing the register) ----
    const modes = {};
    (sales || []).forEach((r) => {
      const m = r.mode_of_payment || "(not specified)";
      modes[m] = modes[m] || { sales: 0, exp: 0 };
      modes[m].sales += Number(r.amount_received || 0);
    });
    (exp || []).forEach((r) => {
      const m = r.mode_of_payment || "(not specified)";
      modes[m] = modes[m] || { sales: 0, exp: 0 };
      modes[m].exp += Number(r.amount || 0);
    });
    const modeNames = Object.keys(modes).sort((a, b) => a.localeCompare(b));
    const mtb = $("opsreport-mode-table").querySelector("tbody");
    mtb.innerHTML = modeNames.length
      ? modeNames.map((m) => {
          const net = modes[m].sales - modes[m].exp;
          return `<tr>
            <td>${escapeHtml(m)}</td><td class="num">₱ ${fmtMoney(modes[m].sales)}</td>
            <td class="num">₱ ${fmtMoney(modes[m].exp)}</td><td class="num">₱ ${fmtMoney(net)}</td>
          </tr>`;
        }).join("") + `<tr>
            <td><strong>TOTAL (all modes — Sales)</strong></td><td class="num"><strong>₱ ${fmtMoney(totalReceived)}</strong></td>
            <td class="num"><strong>₱ ${fmtMoney(totalExpenses)}</strong></td><td class="num"><strong>₱ ${fmtMoney(netCash)}</strong></td>
          </tr>`
      : `<tr class="empty-row"><td colspan="4">No transactions in this period</td></tr>`;

    // ---- expenses by category ----
    const cats = {};
    (exp || []).forEach((r) => {
      const c = r.category || "(uncategorized)";
      cats[c] = cats[c] || { count: 0, total: 0 };
      cats[c].count += 1;
      cats[c].total += Number(r.amount || 0);
    });
    const catNames = Object.keys(cats).sort((a, b) => cats[b].total - cats[a].total);
    lastExpCatRows = catNames.map((c) => ({
      category: c,
      count: cats[c].count,
      total: cats[c].total,
      pct: totalExpenses > 0 ? (cats[c].total / totalExpenses) * 100 : 0,
    }));
    const ectb = $("opsreport-expcat-table").querySelector("tbody");
    ectb.innerHTML = lastExpCatRows.length
      ? lastExpCatRows.map((r) => `<tr>
          <td>${escapeHtml(r.category)}</td><td class="num">${r.count}</td>
          <td class="num">₱ ${fmtMoney(r.total)}</td><td class="num">${r.pct.toFixed(1)}%</td>
        </tr>`).join("") + `<tr>
          <td><strong>TOTAL</strong></td><td class="num"><strong>${lastExpCatRows.reduce((a, r) => a + r.count, 0)}</strong></td>
          <td class="num"><strong>₱ ${fmtMoney(totalExpenses)}</strong></td><td class="num"><strong>100.0%</strong></td>
        </tr>`
      : `<tr class="empty-row"><td colspan="4">No expenses in this period</td></tr>`;

    // ---- staff performance (item 11: walk-in sales labeled as such, not
    // just "(unassigned)") ----
    const staff = {};
    (sales || []).forEach((r) => {
      const name = r.reference_person || (r.is_walkin ? "Walk-in" : "(unassigned)");
      staff[name] = staff[name] || { count: 0, total: 0, received: 0, balance: 0 };
      staff[name].count += 1;
      staff[name].total += Number(r.total_amount || 0);
      staff[name].received += Number(r.amount_received || 0);
      staff[name].balance += Number(r.balance || 0);
    });
    const staffNames = Object.keys(staff).sort((a, b) => staff[b].total - staff[a].total);
    const stb = $("opsreport-staff-table").querySelector("tbody");
    stb.innerHTML = staffNames.length
      ? staffNames.map((name) => {
          const s = staff[name];
          return `<tr>
            <td>${escapeHtml(name)}</td><td class="num">${s.count}</td>
            <td class="num">₱ ${fmtMoney(s.total)}</td><td class="num">₱ ${fmtMoney(s.received)}</td>
            <td class="num">₱ ${fmtMoney(s.balance)}</td>
          </tr>`;
        }).join("") + `<tr>
            <td><strong>TOTAL</strong></td><td class="num"><strong>${staffNames.reduce((a, n) => a + staff[n].count, 0)}</strong></td>
            <td class="num"><strong>₱ ${fmtMoney(totalSales)}</strong></td><td class="num"><strong>₱ ${fmtMoney(totalReceived)}</strong></td>
            <td class="num"><strong>₱ ${fmtMoney(staffNames.reduce((a, n) => a + staff[n].balance, 0))}</strong></td>
          </tr>`
      : `<tr class="empty-row"><td colspan="5">No sales in this period</td></tr>`;

    // ---- commissions pending approval (item 16) ----
    const commTb = $("opsreport-commission-table").querySelector("tbody");
    const commRows = commissions || [];
    commTb.innerHTML = commRows.length
      ? commRows.map((c) => `<tr>
          <td>${fmtDate(c.trx_date)}</td><td>${escapeHtml(c.staff_name)}</td>
          <td class="num">₱ ${fmtMoney(c.sale_total)}</td><td class="num">${(Number(c.commission_rate) * 100).toFixed(0)}%</td>
          <td class="num">₱ ${fmtMoney(c.commission_amount)}</td>
          <td>${c.status === "approved" ? statusBadge("FULLY PAID") : statusBadge("UNPAID")}${c.needs_review ? ' <span class="badge warn">changed since approval</span>' : ""}</td>
          <td class="row-actions">
            ${currentRole === "admin" && c.status !== "approved" ? `<button class="btn small accent" data-approve-comm="${c.id}">Approve</button>` : ""}
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="7">No fully-paid sales with a staff assigned in this period</td></tr>`;
    commTb.querySelectorAll("[data-approve-comm]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const { data: { user } } = await sb.auth.getUser();
        const { error } = await sb.from("staff_commissions").update({
          status: "approved", approved_at: new Date().toISOString(), approved_by: user?.email || null, needs_review: false,
        }).eq("id", btn.dataset.approveComm);
        if (error) return toast(error.message, true);
        toast("Commission approved");
        loadOpsReport();
      })
    );

    // ---- sales for the period, consolidating repeat payments against the
    // same Xero invoice no. into one line (item 2 + item 17) ----
    const byInvoice = {};
    const noInvoice = [];
    (sales || []).forEach((r) => {
      const key = (r.invoice_no || "").trim();
      if (!key) { noInvoice.push(r); return; }
      if (!byInvoice[key]) {
        byInvoice[key] = { ...r, modes: new Set([r.mode_of_payment || "(not specified)"]) };
      } else {
        const g = byInvoice[key];
        g.total_amount = Number(g.total_amount || 0) + Number(r.total_amount || 0);
        g.amount_received = Number(g.amount_received || 0) + Number(r.amount_received || 0);
        g.balance = Number(g.balance || 0) + Number(r.balance || 0);
        g.modes.add(r.mode_of_payment || "(not specified)");
        if (r.bir_receipt_no) g.bir_receipt_no = g.bir_receipt_no || r.bir_receipt_no;
      }
    });
    const salesDetailRows = [
      ...Object.values(byInvoice).map((g) => ({ ...g, modeLabel: Array.from(g.modes).join(" + ") })),
      ...noInvoice.map((r) => ({ ...r, modeLabel: r.mode_of_payment || "(not specified)" })),
    ].sort((a, b) => (a.trx_date || "").localeCompare(b.trx_date || ""));
    const sdTb = $("opsreport-salesdetail-table").querySelector("tbody");
    sdTb.innerHTML = salesDetailRows.length
      ? salesDetailRows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.tradename || "")}</td>
          <td>${escapeHtml(r.reference_person || (r.is_walkin ? "Walk-in" : ""))}</td><td>${escapeHtml(r.invoice_no || "")}</td>
          <td class="num">₱ ${fmtMoney(r.total_amount)}</td><td class="num">₱ ${fmtMoney(r.amount_received)}</td>
          <td class="num">₱ ${fmtMoney(r.balance)}</td><td>${escapeHtml(r.modeLabel)}</td>
          <td>${(r.bir_receipt_no || "").trim() ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="9">No sales in this period</td></tr>`;

    // ---- expenses for the period (item 2 / earlier "expenses for the day" request) ----
    const edTb = $("opsreport-expdetail-table").querySelector("tbody");
    const expDetailRows = [...(exp || [])].sort((a, b) => (a.trx_date || "").localeCompare(b.trx_date || ""));
    edTb.innerHTML = expDetailRows.length
      ? expDetailRows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.business_name || "")}</td>
          <td>${escapeHtml(r.category || "")}</td><td class="num">₱ ${fmtMoney(r.amount)}</td><td>${escapeHtml(r.mode_of_payment || "")}</td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="5">No expenses in this period</td></tr>`;
  }

  /* =====================================================================
     STAFF (manage who shows up in the Staff dropdown)
     ===================================================================== */
  function initStaffForm() {
    $("staff-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const name = $("staff-name").value.trim();
      if (!name) return;
      const { error } = await sb.from("staff").insert({ name });
      if (error) return toast(error.message, true);
      toast("Staff added");
      $("staff-form").reset();
      loadStaff();
      refreshDatalists();
    });
  }
  async function loadStaff() {
    if (!requireDb()) return;
    const { data: rows, error } = await sb.from("staff").select("*").order("name");
    if (error) return toast(error.message, true);
    const tb = $("staff-table").querySelector("tbody");
    tb.innerHTML = (rows || []).length
      ? rows.map((r) => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td><span class="badge ${r.active ? "good" : "neutral"}">${r.active ? "ACTIVE" : "INACTIVE"}</span></td>
          <td class="row-actions">
            <button class="btn small" data-toggle-staff="${r.id}" data-active="${r.active}">${r.active ? "Deactivate" : "Reactivate"}</button>
            <button class="btn small danger" data-del-staff="${r.id}">Delete</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="3">No staff added yet</td></tr>`;
    tb.querySelectorAll("[data-toggle-staff]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!requireDb()) return;
        const id = btn.dataset.toggleStaff;
        const nowActive = btn.dataset.active !== "true";
        const { error } = await sb.from("staff").update({ active: nowActive }).eq("id", id);
        if (error) return toast(error.message, true);
        toast(nowActive ? "Staff reactivated" : "Staff deactivated");
        loadStaff();
        refreshDatalists();
      })
    );
    tb.querySelectorAll("[data-del-staff]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("staff", btn.dataset.delStaff, () => { loadStaff(); refreshDatalists(); }))
    );
  }

  /* =====================================================================
     INCOME STATEMENT (Revenue from Issued Invoices, less Expenses)
     ===================================================================== */
  let lastIncStmtExpRows = [];
  function initIncomeStatementForm() {
    const y = new Date().getFullYear();
    $("incstmt-from").value = `${y}-01-01`;
    $("incstmt-to").value = todayISO();
    $("incstmt-apply").addEventListener("click", loadIncomeStatement);
    $("incstmt-entity").addEventListener("change", loadIncomeStatement);
    $("incstmt-ytd").addEventListener("click", () => {
      const yy = new Date().getFullYear();
      $("incstmt-from").value = `${yy}-01-01`;
      $("incstmt-to").value = todayISO();
      loadIncomeStatement();
    });
    $("incstmt-export").addEventListener("click", () => {
      if (!lastIncStmtExpRows.length) return toast("Nothing to export yet — run the report first", true);
      downloadCSV("income_statement_expenses.csv", lastIncStmtExpRows, [
        { label: "Category", key: "category" },
        { label: "Amount", key: "amount" },
      ]);
    });
  }

  async function loadIncomeStatement() {
    if (!requireDb()) return;
    if (!$("incstmt-from").value) $("incstmt-from").value = `${new Date().getFullYear()}-01-01`;
    if (!$("incstmt-to").value) $("incstmt-to").value = todayISO();
    const from = $("incstmt-from").value;
    const to = $("incstmt-to").value;
    const entity = $("incstmt-entity").value;

    let invQuery = sb.from("issued_invoices").select("gross_sales,net_sales,vat,cancelled,month_declared,business_entity").gte("month_declared", from).lte("month_declared", to);
    if (entity) invQuery = invQuery.eq("business_entity", entity);
    let expQuery = sb.from("expenses").select("amount,category,business_entity").gte("trx_date", from).lte("trx_date", to);
    if (entity) expQuery = expQuery.eq("business_entity", entity);
    const [{ data: inv, error: iErr }, { data: exp, error: eErr }] = await Promise.all([
      invQuery,
      expQuery,
    ]);
    if (iErr) return toast(iErr.message, true);
    if (eErr) return toast(eErr.message, true);

    const activeInv = (inv || []).filter((r) => !r.cancelled);
    const grossSales = activeInv.reduce((a, r) => a + Number(r.gross_sales || 0), 0);
    const vatOnSales = activeInv.reduce((a, r) => a + Number(r.vat || 0), 0);
    const netSales = activeInv.reduce((a, r) => {
      const rowNet = r.net_sales != null ? Number(r.net_sales) : Number(r.gross_sales || 0) - Number(r.vat || 0);
      return a + rowNet;
    }, 0);
    const totalExpenses = (exp || []).reduce((a, r) => a + Number(r.amount || 0), 0);
    const netIncome = netSales - totalExpenses;

    function card(label, value, cls) {
      return `<div class="stat-card"><div class="label">${label}</div><div class="value ${cls}">₱ ${value}</div></div>`;
    }
    $("incstmt-cards").innerHTML = [
      card("Net sales (revenue)", fmtMoney(netSales), "good"),
      card("Total expenses", fmtMoney(totalExpenses), "bad"),
      card("Net income", fmtMoney(netIncome), netIncome >= 0 ? "good" : "bad"),
    ].join("");

    const rtb = $("incstmt-revenue-table").querySelector("tbody");
    rtb.innerHTML = `
      <tr><td>Gross sales</td><td class="num">₱ ${fmtMoney(grossSales)}</td></tr>
      <tr><td>Less: VAT on sales</td><td class="num">(₱ ${fmtMoney(vatOnSales)})</td></tr>
      <tr><td><strong>Net sales</strong></td><td class="num"><strong>₱ ${fmtMoney(netSales)}</strong></td></tr>
    `;

    const cats = {};
    (exp || []).forEach((r) => {
      const c = r.category || "(uncategorized)";
      cats[c] = (cats[c] || 0) + Number(r.amount || 0);
    });
    const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
    lastIncStmtExpRows = catNames.map((c) => ({ category: c, amount: cats[c] }));
    const etb = $("incstmt-expenses-table").querySelector("tbody");
    etb.innerHTML =
      (catNames.length
        ? catNames.map((c) => `<tr><td>${escapeHtml(c)}</td><td class="num">₱ ${fmtMoney(cats[c])}</td></tr>`).join("")
        : `<tr class="empty-row"><td colspan="2">No expenses in this period</td></tr>`) +
      `<tr><td><strong>Total expenses</strong></td><td class="num"><strong>₱ ${fmtMoney(totalExpenses)}</strong></td></tr>`;
  }

  /* =====================================================================
     REPORTS
     ===================================================================== */
  // "Filed" vs "Pending this quarter" (item 12): a month's VAT belongs to a
  // BIR quarter (Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec). Once the
  // CURRENT quarter has moved past that month's quarter, treat it as
  // already filed/closed; the quarter we're currently in is still open /
  // pending filing. This is a display label only -- it doesn't change what
  // gets exported or what's editable.
  function quarterFilingStatus(monthStr) {
    const [y, m] = monthStr.slice(0, 7).split("-").map(Number);
    const rowQ = Math.ceil(m / 3);
    const now = new Date();
    const curY = now.getFullYear();
    const curQ = Math.ceil((now.getMonth() + 1) / 3);
    if (y < curY || (y === curY && rowQ < curQ)) return { label: "Filed", cls: "good" };
    if (y === curY && rowQ === curQ) return { label: `Pending Q${curQ} ${curY} filing`, cls: "warn" };
    return { label: "Not yet due", cls: "neutral" };
  }
  let lastSummaryRows = [];
  let reportsWired = false;
  async function loadReports() {
    if (!requireDb()) return;
    if (!reportsWired) {
      reportsWired = true;
      $("reports-f-apply").addEventListener("click", loadReports);
      $("reports-f-year").addEventListener("change", loadReports);
      $("reports-f-search").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); loadReports(); }
      });
      $("reports-f-clear").addEventListener("click", () => {
        $("reports-f-year").value = "";
        $("reports-f-search").value = "";
        loadReports();
      });
      $("reports-hist-f-apply").addEventListener("click", loadReports);
      $("reports-hist-f-year").addEventListener("change", loadReports);
      $("reports-hist-f-search").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); loadReports(); }
      });
      $("reports-hist-f-clear").addEventListener("click", () => {
        $("reports-hist-f-year").value = "";
        $("reports-hist-f-search").value = "";
        loadReports();
      });
    }
    const [{ data: sales }, { data: exp }] = await Promise.all([
      sb.from("v_monthly_summary").select("*"),
      sb.from("v_monthly_expenses").select("*"),
    ]);
    const byMonth = {};
    (sales || []).forEach((s) => (byMonth[s.month] = { ...byMonth[s.month], ...s }));
    (exp || []).forEach((e) => (byMonth[e.month] = { ...byMonth[e.month], ...e }));
    let rows = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map((m) => byMonth[m]);

    const summaryYear = $("reports-f-year").value.trim();
    const summarySearch = $("reports-f-search").value.trim().toLowerCase();
    if (summaryYear) rows = rows.filter((r) => r.month.slice(0, 4) === summaryYear);
    if (summarySearch) rows = rows.filter((r) => fmtMonth(r.month.slice(0, 7)).toLowerCase().includes(summarySearch) || r.month.includes(summarySearch));
    lastSummaryRows = rows;

    const tb = $("reports-summary-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => {
          const net = Number(r.net_sales || 0) - Number(r.total_expenses || 0);
          const fs = quarterFilingStatus(r.month);
          return `<tr>
            <td>${fmtMonth(r.month.slice(0, 7))}</td><td class="num">₱ ${fmtMoney(r.gross_sales)}</td>
            <td class="num">₱ ${fmtMoney(r.net_sales)}</td><td class="num">₱ ${fmtMoney(r.vat_on_sales)}</td>
            <td class="num">₱ ${fmtMoney(r.withholding_tax_on_sales)}</td><td class="num">₱ ${fmtMoney(r.vat_expenses)}</td>
            <td class="num">₱ ${fmtMoney(r.non_vat_expenses)}</td><td class="num">₱ ${fmtMoney(r.total_expenses)}</td>
            <td class="num">₱ ${fmtMoney(net)}</td>
            <td><span class="badge ${fs.cls}">${fs.label}</span></td>
          </tr>`;
        }).join("")
      : `<tr class="empty-row"><td colspan="10">Log some issued invoices and expenses to see the summary</td></tr>`;

    let histQuery = sb.from("declarations_history").select("*").order("year", { ascending: false }).order("month", { ascending: false });
    const histYear = $("reports-hist-f-year").value.trim();
    const histSearch = $("reports-hist-f-search").value.trim();
    if (histYear) histQuery = histQuery.eq("year", Number(histYear));
    if (histSearch) histQuery = histQuery.ilike("name", `%${histSearch}%`);
    const { data: hist, error } = await histQuery.limit(500);
    if (!error) {
      const htb = $("reports-history-table").querySelector("tbody");
      htb.innerHTML = (hist || []).length
        ? hist.map((r) => `<tr>
            <td>${r.year || ""}</td><td>${r.month ? fmtMonth(r.month.slice(0, 7)) : ""}</td>
            <td class="num">₱ ${fmtMoney(r.gross_sales)}</td><td class="num">₱ ${fmtMoney(r.net_sales)}</td>
            <td class="num">₱ ${fmtMoney(r.gross_expenses)}</td><td class="num">₱ ${fmtMoney(r.net_expenses)}</td>
          </tr>`).join("")
        : `<tr class="empty-row"><td colspan="6">No historical archive imported</td></tr>`;
    }
  }
  $("reports-export").addEventListener("click", () => {
    if (!lastSummaryRows.length) return toast("Nothing to export yet", true);
    downloadCSV("monthly_vat_summary.csv", lastSummaryRows, [
      { label: "Month", key: "month" }, { label: "Gross Sales", key: "gross_sales" }, { label: "Net Sales", key: "net_sales" },
      { label: "VAT on Sales", key: "vat_on_sales" }, { label: "WTax on Sales", key: "withholding_tax_on_sales" },
      { label: "VAT Expenses", key: "vat_expenses" }, { label: "Non-VAT Expenses", key: "non_vat_expenses" }, { label: "Total Expenses", key: "total_expenses" },
      { label: "Filing Status", get: (r) => quarterFilingStatus(r.month).label },
    ]);
  });

  /* =====================================================================
     BOOT
     ===================================================================== */
  initSalesForm();
  initExpensesForm();
  initPettyCashForm();
  initExpensesImport();
  initExpensesDedupe();
  initBillsForm();
  initInvoicesForm();
  initExpensesReportForm();
  initWithholdingForm();
  initOpsReportForm();
  initStaffForm();
  initIncomeStatementForm();
  initAuthGate();
})();
