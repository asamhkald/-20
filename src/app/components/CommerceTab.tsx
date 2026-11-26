import { useState, type FormEvent } from "react";
import { PackagePlus, ShoppingBag, Users, RotateCcw } from "lucide-react";
import { formatMinorAmount, newOperationKey, parseTextToMinor, todayIso, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";

type Props = Readonly<{ ws: SamaWorkspace; actor: TenantContext; onChanged: () => void }>;

export function CommerceTab({ ws, actor, onChanged }: Props) {
  const [pName, setPName] = useState("");
  const [pCost, setPCost] = useState("50.00");
  const [pSale, setPSale] = useState("80.00");
  const [pQty, setPQty] = useState("5");
  const [pCur, setPCur] = useState<"USD" | "SYP">("USD");
  const [cName, setCName] = useState("");
  const [selProd, setSelProd] = useState("");
  const [selQty, setSelQty] = useState("1");
  const [payMode, setPayMode] = useState<"cash" | "credit">("cash");
  const [selCust, setSelCust] = useState("");
  const [colAmt, setColAmt] = useState("20.00");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  let catalog: ReturnType<SamaWorkspace["inventory"]["listCatalog"]> = [];
  let customers: ReturnType<SamaWorkspace["crm"]["listParties"]> = [];
  let invoices: ReturnType<SamaWorkspace["sales"]["listInvoices"]> = [];
  try { catalog = ws.inventory.listCatalog(actor); } catch { /* restricted */ }
  try { customers = ws.crm.listParties(actor, "customer"); } catch { /* restricted */ }
  try { invoices = ws.sales.listInvoices(actor); } catch { /* restricted */ }

  const addProductAndStock = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const costMinor = parseTextToMinor(pCost, pCur), saleMinor = parseTextToMinor(pSale, pCur);
      const qty = Number.parseInt(pQty, 10);
      const prod = ws.inventory.createProduct(actor, { name: pName, currency: pCur, costMinor, saleMinor });
      if (qty > 0) {
        const supp = ws.crm.listParties(actor, "supplier")[0] ?? ws.crm.registerParty(actor, { name: "مورد افتراضي", type: "supplier" });
        ws.procurement.postPurchaseBill(actor, {
          idempotencyKey: newOperationKey(), businessDate: todayIso(), paymentMode: "credit",
          currency: pCur, warehouseId: ws.defaultWarehouseId, supplierId: supp.id,
          items: [{ productId: prod.id, quantity: qty, unitCostMinor: costMinor }],
        });
      }
      setPName(""); setSelProd(prod.id); setMsg(`تم إضافة "${prod.name}" وتوريد ${qty} قطعة.`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل إضافة الصنف."); }
  };

  const addCustomer = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const c = ws.crm.registerParty(actor, { name: cName, type: "customer" });
      setCName(""); setSelCust(c.id); setMsg(`تم تسجيل العميل "${c.name}".`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل تسجيل العميل."); }
  };
  const postSale = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const prodId = selProd || catalog[0]?.id || "";
      const prod = catalog.find((p) => p.id === prodId);
      if (!prod) throw new Error("أضف صنفاً أولاً قبل البيع.");
      const inv = ws.sales.postSaleInvoice(actor, {
        idempotencyKey: newOperationKey(), businessDate: todayIso(), paymentMode: payMode,
        currency: prod.currency, warehouseId: ws.defaultWarehouseId,
        cashboxId: payMode === "cash" ? (prod.currency === "SYP" ? "cb-syp" : "cb-usd") : undefined,
        customerId: payMode === "credit" ? (selCust || customers[0]?.id) : undefined,
        items: [{ productId: prod.id, quantity: Number.parseInt(selQty, 10) || 1 }],
      });
      setMsg(`تم ترحيل الفاتورة ${inv.invoiceNumber} بنجاح.`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل ترحيل الفاتورة."); }
  };

  const collectDebt = (custId: string) => {
    setMsg(""); setErr("");
    try {
      const res = ws.crm.collectCustomerPayment(actor, {
        idempotencyKey: newOperationKey(), businessDate: todayIso(),
        customerId: custId, cashboxId: "cb-usd", amountText: colAmt,
      });
      setMsg(`تم التحصيل · المتبقي: ${formatMinorAmount(res.remainingDebtMinor, "USD")}`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل التحصيل."); }
  };

  const reverseInv = (invId: string) => {
    setMsg(""); setErr("");
    try {
      ws.sales.reverseSaleInvoice(actor, invId, newOperationKey(), todayIso());
      setMsg("تم عكس الفاتورة وإعادة المخزون والذمة ذرياً."); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل العكس."); }
  };

  return (
    <div className="sb-stack">
      {err && <div className="sb-alert err">{err}</div>}
      {msg && <div className="sb-alert ok">{msg}</div>}
      <form className="sb-card" onSubmit={addProductAndStock}>
        <div className="sb-card-head"><PackagePlus size={17} /><strong>إضافة صنف وتوريد مخزون</strong></div>
        <div className="sb-form-grid">
          <input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="اسم الصنف (مثال: شاشة A16)" required />
          <select value={pCur} onChange={(e) => setPCur(e.target.value as "USD" | "SYP")}><option value="USD">دولار ($)</option><option value="SYP">ليرة سورية</option></select>
          <input value={pCost} onChange={(e) => setPCost(e.target.value)} placeholder="سعر الجملة" dir="ltr" required />
          <input value={pSale} onChange={(e) => setPSale(e.target.value)} placeholder="سعر المبيع" dir="ltr" required />
          <input value={pQty} onChange={(e) => setPQty(e.target.value)} placeholder="الكمية" dir="ltr" required />
        </div>
        <button type="submit" className="sb-btn-secondary">حفظ الصنف وتوريد الكمية</button>
      </form>
      <form className="sb-card" onSubmit={postSale}>
        <div className="sb-card-head"><ShoppingBag size={17} /><strong>فاتورة بيع سريعة (POS)</strong></div>
        <div className="sb-form-grid">
          <select value={selProd || catalog[0]?.id || ""} onChange={(e) => setSelProd(e.target.value)}>
            {catalog.length === 0 ? <option value="">لا توجد أصناف</option> : catalog.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (متوفر: {ws.inventory.getStockQuantity(actor.tenantId, ws.defaultWarehouseId, p.id)} | مبيع: {formatMinorAmount(p.saleMinor, p.currency)}{p.costMinor !== null ? ` | جملة: ${formatMinorAmount(p.costMinor, p.currency)}` : " | الجملة مخفية"})
              </option>
            ))}
          </select>
          <input value={selQty} onChange={(e) => setSelQty(e.target.value)} placeholder="الكمية" dir="ltr" required />
          <select value={payMode} onChange={(e) => setPayMode(e.target.value as "cash" | "credit")}><option value="cash">بيع نقدي</option><option value="credit">بيع آجل (دين)</option></select>
          {payMode === "credit" && (
            <select value={selCust || customers[0]?.id || ""} onChange={(e) => setSelCust(e.target.value)}>
              {customers.length === 0 ? <option value="">سجّل عميلاً أولاً</option> : customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        <button type="submit" className="sb-btn-primary">ترحيل الفاتورة</button>
      </form>

      <div className="sb-card">
        <div className="sb-card-head"><Users size={17} /><strong>العملاء وتحصيل الديون</strong></div>
        <form className="sb-form-grid" onSubmit={addCustomer}>
          <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="اسم العميل الجديد" required />
          <button type="submit" className="sb-btn-secondary">تسجيل عميل</button>
        </form>
        <div className="sb-list">
          {customers.map((c) => {
            const usd = ws.crm.getPartyBalance(actor, c.id).balancesByCurrency.USD ?? 0n;
            return (
              <div key={c.id} className="sb-row">
                <div><strong>{c.name}</strong><small dir="ltr">الدين: {formatMinorAmount(usd, "USD")}</small></div>
                {usd > 0n && <div className="sb-inline"><input className="sb-mini-in" value={colAmt} onChange={(e) => setColAmt(e.target.value)} dir="ltr" /><button type="button" className="sb-btn-secondary" onClick={() => collectDebt(c.id)}>تحصيل</button></div>}
              </div>
            );
          })}
        </div>
      </div>

      {invoices.length > 0 && (
        <div className="sb-card">
          <div className="sb-card-head"><strong>الفواتير المرحّلة ({invoices.length})</strong></div>
          <div className="sb-list">
            {invoices.slice(0, 8).map((inv) => (
              <div key={inv.id} className={`sb-row${inv.status === "reversed" ? " muted" : ""}`}>
                <div><strong>{inv.invoiceNumber}</strong> · {inv.paymentMode === "cash" ? "نقدي" : "آجل"}<small dir="ltr">{formatMinorAmount(inv.totalMinor, inv.currency)}</small></div>
                {inv.status === "posted" ? <button type="button" className="sb-btn-danger" onClick={() => reverseInv(inv.id)}><RotateCcw size={13} /> عكس</button> : <span className="sb-tag">معكوسة</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
