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

  // ---------------------------------------------------------------- nav
  const views = ["dashboard", "sales", "expenses", "receivables", "bills", "opsreport", "invoices", "withholding", "rental", "reports"];
  const titles = {
    dashboard: "Dashboard", sales: "Daily Sales", expenses: "Daily Expenses", receivables: "Receivables",
    bills: "Bill Tracker", opsreport: "Daily Operations Report", invoices: "Issued Invoices", withholding: "2307 Register", rental: "Rental Income", reports: "Reports",
  };
  const loaded = {};
  const loaders = {
    dashboard: loadDashboard, sales: loadSales, expenses: loadExpenses, receivables: loadReceivables,
    bills: loadBills, opsreport: loadOpsReport, invoices: loadInvoices, withholding: loadWithholding, rental: loadRental, reports: loadReports,
  };

  function showView(name) {
    views.forEach((v) => {
      $("view-" + v).classList.toggle("active", v === name);
    });
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $("view-title").textContent = titles[name];
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
  function initSalesForm() {
    $("sales-date").value = todayISO();
    $("sales-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("sales-id").value;
      const payload = {
        trx_date: $("sales-date").value,
        tradename: $("sales-tradename").value.trim(),
        quote_no: $("sales-quote").value.trim() || null,
        reference_person: $("sales-staff").value.trim() || null,
        total_amount: Number($("sales-total").value || 0),
        amount_received: Number($("sales-received").value || 0),
        mode_of_payment: $("sales-mode").value.trim() || null,
        invoice_no: $("sales-invoice").value.trim() || null,
        bir_receipt_no: $("sales-bir").value.trim() || null,
        is_walkin: $("sales-walkin").checked,
        description: $("sales-description").value.trim() || null,
        remarks: $("sales-remarks").value.trim() || null,
      };
      let error;
      if (id) {
        ({ error } = await sb.from("sales").update(payload).eq("id", id));
      } else {
        ({ error } = await sb.from("sales").insert(payload));
      }
      if (error) return toast(error.message, true);
      toast(id ? "Sale updated" : "Sale saved");
      resetSalesForm();
      loadSales();
      loadDashboard.dirty = true;
    });
    $("sales-cancel-edit").addEventListener("click", resetSalesForm);
    $("sales-f-apply").addEventListener("click", loadSales);
    $("sales-f-clear").addEventListener("click", () => {
      ["sales-f-from", "sales-f-to", "sales-f-search"].forEach((id) => ($(id).value = ""));
      $("sales-f-status").value = "";
      loadSales();
    });
    $("sales-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchSalesRows();
      downloadCSV("sales.csv", rows, [
        { label: "Date", key: "trx_date" }, { label: "Tradename", key: "tradename" },
        { label: "Staff", key: "reference_person" }, { label: "Total", key: "total_amount" },
        { label: "Received", key: "amount_received" }, { label: "Balance", key: "balance" },
        { label: "Status", key: "status" }, { label: "Mode", key: "mode_of_payment" },
        { label: "Invoice No", key: "invoice_no" }, { label: "Remarks", key: "remarks" },
      ]);
    });
  }
  function resetSalesForm() {
    $("sales-form").reset();
    $("sales-id").value = "";
    $("sales-date").value = todayISO();
    $("sales-received").value = "0";
    $("sales-form-title").textContent = "Log a sale";
    $("sales-cancel-edit").style.display = "none";
  }
  async function fetchSalesRows() {
    let q = sb.from("v_sales_status").select("*").order("trx_date", { ascending: false });
    const from = $("sales-f-from").value, to = $("sales-f-to").value, status = $("sales-f-status").value, search = $("sales-f-search").value.trim();
    if (from) q = q.gte("trx_date", from);
    if (to) q = q.lte("trx_date", to);
    if (status) q = q.eq("status", status);
    if (search) q = q.ilike("tradename", `%${search}%`);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  async function loadSales() {
    if (!requireDb()) return;
    const rows = await fetchSalesRows();
    const tb = $("sales-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.tradename)}</td><td>${escapeHtml(r.reference_person || "")}</td>
          <td class="num">₱ ${fmtMoney(r.total_amount)}</td><td class="num">₱ ${fmtMoney(r.amount_received)}</td>
          <td class="num">₱ ${fmtMoney(r.balance)}</td><td>${statusBadge(r.status)}</td>
          <td>${escapeHtml(r.mode_of_payment || "")}</td><td>${escapeHtml(r.invoice_no || "")}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-sale="${r.id}">Edit</button>
            <button class="btn small danger" data-del-sale="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="10">No sales match these filters</td></tr>`;

    tb.querySelectorAll("[data-edit-sale]").forEach((btn) =>
      btn.addEventListener("click", () => editSale(rows.find((r) => String(r.id) === btn.dataset.editSale)))
    );
    tb.querySelectorAll("[data-del-sale]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("sales", btn.dataset.delSale, loadSales))
    );
  }
  function editSale(r) {
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
    $("sales-bir").value = r.bir_receipt_no || "";
    $("sales-walkin").checked = !!r.is_walkin;
    $("sales-description").value = r.description || "";
    $("sales-remarks").value = r.remarks || "";
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
    $("expenses-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("expenses-id").value;
      const payload = {
        trx_date: $("expenses-date").value,
        business_scope: $("expenses-scope").value,
        tax_type: $("expenses-taxtype").value,
        tin: $("expenses-tin").value.trim() || null,
        business_name: $("expenses-business").value.trim(),
        amount: Number($("expenses-amount").value || 0),
        category: $("expenses-category").value.trim() || null,
        mode_of_payment: $("expenses-mode").value.trim() || null,
        invoice_no: $("expenses-invoice").value.trim() || null,
        particulars: $("expenses-particulars").value.trim() || null,
        remarks: $("expenses-remarks").value.trim() || null,
      };
      let error;
      if (id) ({ error } = await sb.from("expenses").update(payload).eq("id", id));
      else ({ error } = await sb.from("expenses").insert(payload));
      if (error) return toast(error.message, true);
      toast(id ? "Expense updated" : "Expense saved");
      resetExpensesForm();
      loadExpenses();
    });
    $("expenses-cancel-edit").addEventListener("click", resetExpensesForm);
    $("expenses-f-apply").addEventListener("click", loadExpenses);
    $("expenses-f-clear").addEventListener("click", () => {
      ["expenses-f-from", "expenses-f-to", "expenses-f-category", "expenses-f-search"].forEach((id) => ($(id).value = ""));
      loadExpenses();
    });
    $("expenses-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchExpensesRows();
      downloadCSV("expenses.csv", rows, [
        { label: "Date", key: "trx_date" }, { label: "Business", key: "business_name" },
        { label: "Category", key: "category" }, { label: "Tax Type", key: "tax_type" },
        { label: "Amount", key: "amount" }, { label: "Mode", key: "mode_of_payment" },
        { label: "TIN", key: "tin" }, { label: "Particulars", key: "particulars" },
      ]);
    });
  }
  function resetExpensesForm() {
    $("expenses-form").reset();
    $("expenses-id").value = "";
    $("expenses-date").value = todayISO();
    $("expenses-form-title").textContent = "Log an expense";
    $("expenses-cancel-edit").style.display = "none";
  }
  async function fetchExpensesRows() {
    let q = sb.from("expenses").select("*").order("trx_date", { ascending: false });
    const from = $("expenses-f-from").value, to = $("expenses-f-to").value, cat = $("expenses-f-category").value.trim(), search = $("expenses-f-search").value.trim();
    if (from) q = q.gte("trx_date", from);
    if (to) q = q.lte("trx_date", to);
    if (cat) q = q.ilike("category", `%${cat}%`);
    if (search) q = q.ilike("business_name", `%${search}%`);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  async function loadExpenses() {
    if (!requireDb()) return;
    const rows = await fetchExpensesRows();
    const tb = $("expenses-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.trx_date)}</td><td>${escapeHtml(r.business_name)}</td><td>${escapeHtml(r.category || "")}</td>
          <td>${escapeHtml(r.tax_type || "")}</td><td class="num">₱ ${fmtMoney(r.amount)}</td><td>${escapeHtml(r.mode_of_payment || "")}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-exp="${r.id}">Edit</button>
            <button class="btn small danger" data-del-exp="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="7">No expenses match these filters</td></tr>`;
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
    $("expenses-particulars").value = r.particulars || "";
    $("expenses-remarks").value = r.remarks || "";
    $("expenses-form-title").textContent = "Edit expense";
    $("expenses-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* =====================================================================
     RECEIVABLES
     ===================================================================== */
  async function loadReceivables() {
    if (!requireDb()) return;
    const { data, error } = await sb.from("v_sales_status").select("*").neq("balance", 0).order("trx_date", { ascending: true }).limit(500);
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
  }
  async function loadBills() {
    if (!requireDb()) return;
    const period = $("bills-period").value || monthISO();
    const { data: billers, error } = await sb.from("billers").select("*").eq("active", true).order("name");
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
  function initInvoicesForm() {
    $("invoices-month").value = monthISO();
    $("invoices-date").value = todayISO();
    $("invoices-gross").addEventListener("input", () => {
      const gross = Number($("invoices-gross").value || 0);
      if (gross > 0) {
        const net = gross / 1.12;
        $("invoices-net").placeholder = net.toFixed(2);
        $("invoices-vat").placeholder = (gross - net).toFixed(2);
      }
    });
    $("invoices-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const gross = Number($("invoices-gross").value || 0);
      const net = $("invoices-net").value ? Number($("invoices-net").value) : gross / 1.12;
      const vat = $("invoices-vat").value ? Number($("invoices-vat").value) : gross - net;
      const wtax = Number($("invoices-wtax").value || 0);
      const id = $("invoices-id").value;
      const payload = {
        month_declared: $("invoices-month").value + "-01",
        invoice_date: $("invoices-date").value || null,
        invoice_no: $("invoices-invoiceno").value.trim(),
        tin: $("invoices-tin").value.trim() || null,
        customer_name: $("invoices-customer").value.trim(),
        gross_sales: gross,
        net_sales: net,
        vat: vat,
        ewt_tax_rate: $("invoices-ewtrate").value ? Number($("invoices-ewtrate").value) : null,
        withholding_tax: wtax,
        total_due: gross - wtax,
        with_2307: $("invoices-with2307").checked,
        cancelled: $("invoices-cancelled").checked,
        remarks: $("invoices-remarks").value.trim() || null,
      };
      let error;
      if (id) ({ error } = await sb.from("issued_invoices").update(payload).eq("id", id));
      else ({ error } = await sb.from("issued_invoices").insert(payload));
      if (error) return toast(error.message, true);
      toast(id ? "Invoice updated" : "Invoice saved");
      resetInvoicesForm();
      loadInvoices();
    });
    $("invoices-cancel-edit").addEventListener("click", resetInvoicesForm);
    $("invoices-f-apply").addEventListener("click", loadInvoices);
    $("invoices-f-clear").addEventListener("click", () => {
      $("invoices-f-month").value = "";
      $("invoices-f-search").value = "";
      loadInvoices();
    });
    $("invoices-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchInvoicesRows();
      downloadCSV("issued_invoices.csv", rows, [
        { label: "Month", key: "month_declared" }, { label: "Date", key: "invoice_date" },
        { label: "Invoice No", key: "invoice_no" }, { label: "TIN", key: "tin" }, { label: "Customer", key: "customer_name" },
        { label: "Gross", key: "gross_sales" }, { label: "Net", key: "net_sales" }, { label: "VAT", key: "vat" },
        { label: "Withholding Tax", key: "withholding_tax" }, { label: "With 2307", key: "with_2307" },
      ]);
    });
  }
  function resetInvoicesForm() {
    $("invoices-form").reset();
    $("invoices-id").value = "";
    $("invoices-month").value = monthISO();
    $("invoices-date").value = todayISO();
    $("invoices-form-title").textContent = "Log an issued invoice";
    $("invoices-cancel-edit").style.display = "none";
  }
  async function fetchInvoicesRows() {
    let q = sb.from("issued_invoices").select("*").order("month_declared", { ascending: false });
    const month = $("invoices-f-month").value, search = $("invoices-f-search").value.trim();
    if (month) q = q.eq("month_declared", month + "-01");
    if (search) q = q.ilike("customer_name", `%${search}%`);
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
          <td>${escapeHtml(r.invoice_no || "")}${r.cancelled ? ' <span class="badge bad">CANCELLED</span>' : ""}</td>
          <td>${escapeHtml(r.customer_name)}</td><td class="num">₱ ${fmtMoney(r.gross_sales)}</td>
          <td class="num">₱ ${fmtMoney(r.net_sales)}</td><td class="num">₱ ${fmtMoney(r.vat)}</td>
          <td class="num">₱ ${fmtMoney(r.withholding_tax)}</td><td>${r.with_2307 ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-inv="${r.id}">Edit</button>
            <button class="btn small danger" data-del-inv="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="10">No invoices match these filters</td></tr>`;
    tb.querySelectorAll("[data-edit-inv]").forEach((btn) =>
      btn.addEventListener("click", () => editInvoice(rows.find((r) => String(r.id) === btn.dataset.editInv)))
    );
    tb.querySelectorAll("[data-del-inv]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("issued_invoices", btn.dataset.delInv, loadInvoices))
    );
  }
  function editInvoice(r) {
    if (!r) return;
    $("invoices-id").value = r.id;
    $("invoices-month").value = (r.month_declared || "").slice(0, 7);
    $("invoices-date").value = r.invoice_date || "";
    $("invoices-invoiceno").value = r.invoice_no || "";
    $("invoices-tin").value = r.tin || "";
    $("invoices-customer").value = r.customer_name || "";
    $("invoices-gross").value = r.gross_sales;
    $("invoices-net").value = r.net_sales ?? "";
    $("invoices-vat").value = r.vat ?? "";
    $("invoices-ewtrate").value = r.ewt_tax_rate ?? "";
    $("invoices-wtax").value = r.withholding_tax ?? 0;
    $("invoices-with2307").checked = !!r.with_2307;
    $("invoices-cancelled").checked = !!r.cancelled;
    $("invoices-remarks").value = r.remarks || "";
    $("invoices-form-title").textContent = "Edit invoice";
    $("invoices-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    $("withholding-f-clear").addEventListener("click", () => {
      $("withholding-f-year").value = "";
      $("withholding-f-quarter").value = "";
      loadWithholding();
    });
    $("withholding-export").addEventListener("click", async () => {
      if (!requireDb()) return;
      const rows = await fetchWithholdingRows();
      downloadCSV("withholding_2307.csv", rows, [
        { label: "Year", key: "year" }, { label: "Quarter", key: "quarter" }, { label: "Month", key: "month" },
        { label: "TIN", key: "tin" }, { label: "Payee", key: "payee_name" }, { label: "ATC", key: "atc" },
        { label: "Income Payment", key: "income_payment" }, { label: "Tax Withheld", key: "tax_withheld" }, { label: "Issued", key: "issued" },
      ]);
    });
  }
  function resetWithholdingForm() {
    $("withholding-form").reset();
    $("withholding-id").value = "";
    $("withholding-year").value = new Date().getFullYear();
    $("withholding-form-title").textContent = "Log a 2307";
    $("withholding-cancel-edit").style.display = "none";
  }
  async function fetchWithholdingRows() {
    let q = sb.from("withholding_2307").select("*").order("year", { ascending: false }).order("quarter", { ascending: false });
    const year = $("withholding-f-year").value, qtr = $("withholding-f-quarter").value;
    if (year) q = q.eq("year", Number(year));
    if (qtr) q = q.eq("quarter", qtr);
    const { data, error } = await q.limit(1000);
    if (error) { toast(error.message, true); return []; }
    return data || [];
  }
  async function loadWithholding() {
    if (!requireDb()) return;
    const rows = await fetchWithholdingRows();
    const tb = $("withholding-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${r.year || ""}</td><td>${escapeHtml(r.quarter || "")}</td><td>${r.month ? fmtMonth(r.month.slice(0, 7)) : ""}</td>
          <td>${escapeHtml(r.payee_name)}</td><td>${escapeHtml(r.atc || "")}</td>
          <td class="num">₱ ${fmtMoney(r.income_payment)}</td><td class="num">₱ ${fmtMoney(r.tax_withheld)}</td>
          <td>${r.issued ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-wh="${r.id}">Edit</button>
            <button class="btn small danger" data-del-wh="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="9">No 2307s match these filters</td></tr>`;
    tb.querySelectorAll("[data-edit-wh]").forEach((btn) =>
      btn.addEventListener("click", () => editWithholding(rows.find((r) => String(r.id) === btn.dataset.editWh)))
    );
    tb.querySelectorAll("[data-del-wh]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("withholding_2307", btn.dataset.delWh, loadWithholding))
    );
  }
  function editWithholding(r) {
    if (!r) return;
    $("withholding-id").value = r.id;
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
     RENTAL INCOME (QAP)
     ===================================================================== */
  function initRentalForm() {
    $("rental-year").value = new Date().getFullYear();
    $("rental-month").value = monthISO();
    $("rental-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireDb()) return;
      const id = $("rental-id").value;
      const payload = {
        year: Number($("rental-year").value),
        month_declared: $("rental-month").value + "-01",
        room_no: $("rental-room").value.trim() || null,
        tin: $("rental-tin").value.trim() || null,
        tenant_name: $("rental-tenant").value.trim(),
        atc: $("rental-atc").value.trim() || null,
        gross: Number($("rental-gross").value || 0),
        net_taxable: $("rental-nettaxable").value ? Number($("rental-nettaxable").value) : null,
        vat: $("rental-vat").value ? Number($("rental-vat").value) : null,
        tax_withheld: $("rental-taxwithheld").value ? Number($("rental-taxwithheld").value) : null,
        net: $("rental-net").value ? Number($("rental-net").value) : null,
        rent_period: $("rental-period").value.trim() || null,
        date_of_payment: $("rental-datepaid").value || null,
        mode_of_payment: $("rental-mode").value.trim() || null,
      };
      let error, savedId = id ? Number(id) : null;
      if (id) {
        ({ error } = await sb.from("rental_income").update(payload).eq("id", id));
      } else {
        const res = await sb.from("rental_income").insert(payload).select("id").single();
        error = res.error;
        savedId = res.data?.id ?? null;
      }
      if (error) return toast(error.message, true);
      if (savedId) await syncRentalWithholding(savedId, payload);
      const suffix = Number(payload.tax_withheld) > 0 ? " — 2307 synced" : "";
      toast((id ? "Rental income updated" : "Rental income saved") + suffix);
      resetRentalForm();
      loadRental();
    });
    $("rental-cancel-edit").addEventListener("click", resetRentalForm);
  }

  function quarterOf(monthStr) {
    // monthStr like "2026-09" or "2026-09-01"
    const m = Number(monthStr.slice(5, 7));
    return `Q${Math.floor((m - 1) / 3) + 1}`;
  }

  // Every rental payment with tax actually withheld implies a 2307 the
  // tenant issued — keep one withholding_2307 row in sync with each
  // rental_income row instead of asking for the same numbers twice.
  async function syncRentalWithholding(rentalId, payload) {
    const taxWithheld = Number(payload.tax_withheld || 0);
    if (taxWithheld > 0) {
      const whPayload = {
        rental_income_id: rentalId,
        year: payload.year,
        quarter: quarterOf(payload.month_declared),
        month: payload.month_declared,
        tin: payload.tin,
        payee_name: payload.tenant_name,
        atc: payload.atc,
        income_payment: payload.gross,
        tax_withheld: taxWithheld,
        invoice_ref: payload.rent_period,
      };
      const { error } = await sb.from("withholding_2307").upsert(whPayload, { onConflict: "rental_income_id" });
      if (error) toast("Rental income saved, but the linked 2307 failed: " + error.message, true);
    } else {
      // No tax withheld (any more) — remove a previously auto-generated 2307 for this rental row, if any.
      await sb.from("withholding_2307").delete().eq("rental_income_id", rentalId);
    }
  }
  function resetRentalForm() {
    $("rental-form").reset();
    $("rental-id").value = "";
    $("rental-year").value = new Date().getFullYear();
    $("rental-month").value = monthISO();
    $("rental-form-title").textContent = "Log rental income";
    $("rental-cancel-edit").style.display = "none";
  }
  async function loadRental() {
    if (!requireDb()) return;
    const [{ data: rows, error }, { data: whLinks }] = await Promise.all([
      sb.from("rental_income").select("*").order("month_declared", { ascending: false }).limit(500),
      sb.from("withholding_2307").select("rental_income_id").not("rental_income_id", "is", null),
    ]);
    if (error) return toast(error.message, true);
    const has2307 = new Set((whLinks || []).map((w) => w.rental_income_id));
    const tb = $("rental-table").querySelector("tbody");
    tb.innerHTML = (rows || []).length
      ? rows.map((r) => `<tr>
          <td>${r.year || ""}</td><td>${r.month_declared ? fmtMonth(r.month_declared.slice(0, 7)) : ""}</td>
          <td>${escapeHtml(r.room_no || "")}</td><td>${escapeHtml(r.tenant_name)}</td>
          <td class="num">₱ ${fmtMoney(r.gross)}</td><td class="num">₱ ${fmtMoney(r.tax_withheld)}</td>
          <td class="num">₱ ${fmtMoney(r.net)}</td><td>${escapeHtml(r.rent_period || "")}</td>
          <td>${has2307.has(r.id) ? statusBadge("FULLY PAID") : statusBadge("N/A")}</td>
          <td class="row-actions">
            <button class="btn small" data-edit-rent="${r.id}">Edit</button>
            <button class="btn small danger" data-del-rent="${r.id}">Del</button>
          </td>
        </tr>`).join("")
      : `<tr class="empty-row"><td colspan="10">No rental income logged yet</td></tr>`;
    tb.querySelectorAll("[data-edit-rent]").forEach((btn) =>
      btn.addEventListener("click", () => editRental(rows.find((r) => String(r.id) === btn.dataset.editRent)))
    );
    tb.querySelectorAll("[data-del-rent]").forEach((btn) =>
      btn.addEventListener("click", () => deleteRow("rental_income", btn.dataset.delRent, loadRental))
    );
  }
  function editRental(r) {
    if (!r) return;
    $("rental-id").value = r.id;
    $("rental-year").value = r.year || "";
    $("rental-month").value = r.month_declared ? r.month_declared.slice(0, 7) : "";
    $("rental-room").value = r.room_no || "";
    $("rental-tin").value = r.tin || "";
    $("rental-tenant").value = r.tenant_name || "";
    $("rental-atc").value = r.atc || "";
    $("rental-gross").value = r.gross;
    $("rental-nettaxable").value = r.net_taxable ?? "";
    $("rental-vat").value = r.vat ?? "";
    $("rental-taxwithheld").value = r.tax_withheld ?? "";
    $("rental-net").value = r.net ?? "";
    $("rental-period").value = r.rent_period || "";
    $("rental-datepaid").value = r.date_of_payment || "";
    $("rental-mode").value = r.mode_of_payment || "";
    $("rental-form-title").textContent = "Edit rental income";
    $("rental-cancel-edit").style.display = "inline-block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* =====================================================================
     DAILY OPERATIONS REPORT (cash/sales summary + staff performance)
     ===================================================================== */
  function initOpsReportForm() {
    $("opsreport-from").value = todayISO();
    $("opsreport-to").value = todayISO();
    $("opsreport-apply").addEventListener("click", loadOpsReport);
    $("opsreport-today").addEventListener("click", () => {
      $("opsreport-from").value = todayISO();
      $("opsreport-to").value = todayISO();
      loadOpsReport();
    });
  }

  async function loadOpsReport() {
    if (!requireDb()) return;
    if (!$("opsreport-from").value) $("opsreport-from").value = todayISO();
    if (!$("opsreport-to").value) $("opsreport-to").value = todayISO();
    const from = $("opsreport-from").value;
    const to = $("opsreport-to").value;

    const [{ data: sales, error: sErr }, { data: exp, error: eErr }] = await Promise.all([
      sb.from("sales").select("trx_date,total_amount,amount_received,balance,mode_of_payment,reference_person").gte("trx_date", from).lte("trx_date", to),
      sb.from("expenses").select("trx_date,amount,mode_of_payment").gte("trx_date", from).lte("trx_date", to),
    ]);
    if (sErr) return toast(sErr.message, true);
    if (eErr) return toast(eErr.message, true);

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
        }).join("")
      : `<tr class="empty-row"><td colspan="4">No transactions in this period</td></tr>`;

    // ---- staff performance ----
    const staff = {};
    (sales || []).forEach((r) => {
      const name = r.reference_person || "(unassigned)";
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
        }).join("")
      : `<tr class="empty-row"><td colspan="5">No sales in this period</td></tr>`;
  }

  /* =====================================================================
     REPORTS
     ===================================================================== */
  let lastSummaryRows = [];
  async function loadReports() {
    if (!requireDb()) return;
    const [{ data: sales }, { data: exp }] = await Promise.all([
      sb.from("v_monthly_summary").select("*"),
      sb.from("v_monthly_expenses").select("*"),
    ]);
    const byMonth = {};
    (sales || []).forEach((s) => (byMonth[s.month] = { ...byMonth[s.month], ...s }));
    (exp || []).forEach((e) => (byMonth[e.month] = { ...byMonth[e.month], ...e }));
    const rows = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map((m) => byMonth[m]);
    lastSummaryRows = rows;

    const tb = $("reports-summary-table").querySelector("tbody");
    tb.innerHTML = rows.length
      ? rows.map((r) => {
          const net = Number(r.net_sales || 0) - Number(r.total_expenses || 0);
          return `<tr>
            <td>${fmtMonth(r.month.slice(0, 7))}</td><td class="num">₱ ${fmtMoney(r.gross_sales)}</td>
            <td class="num">₱ ${fmtMoney(r.net_sales)}</td><td class="num">₱ ${fmtMoney(r.vat_on_sales)}</td>
            <td class="num">₱ ${fmtMoney(r.withholding_tax_on_sales)}</td><td class="num">₱ ${fmtMoney(r.vat_expenses)}</td>
            <td class="num">₱ ${fmtMoney(r.non_vat_expenses)}</td><td class="num">₱ ${fmtMoney(r.total_expenses)}</td>
            <td class="num">₱ ${fmtMoney(net)}</td>
          </tr>`;
        }).join("")
      : `<tr class="empty-row"><td colspan="9">Log some issued invoices and expenses to see the summary</td></tr>`;

    const { data: hist, error } = await sb.from("declarations_history").select("*").order("year", { ascending: false }).order("month", { ascending: false }).limit(500);
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
    ]);
  });

  /* =====================================================================
     BOOT
     ===================================================================== */
  initSalesForm();
  initExpensesForm();
  initBillsForm();
  initInvoicesForm();
  initWithholdingForm();
  initRentalForm();
  initOpsReportForm();
  if (sb) {
    loadDashboard();
    refreshDatalists();
  }
})();
