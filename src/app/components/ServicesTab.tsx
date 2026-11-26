import { useState, type FormEvent } from "react";
import { Smartphone, Wrench, RotateCcw } from "lucide-react";
import { formatMinorAmount, newOperationKey, parseTextToMinor, todayIso, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";

type Props = Readonly<{ ws: SamaWorkspace; actor: TenantContext; onChanged: () => void }>;

export function ServicesTab({ ws, actor, onChanged }: Props) {
  const [cust, setCust] = useState("");
  const [model, setModel] = useState("");
  const [issue, setIssue] = useState("");
  const [fee, setFee] = useState("25.00");
  const [wId, setWId] = useState(ws.syriatelWalletId);
  const [faceAmt, setFaceAmt] = useState("20000");
  const [priceAmt, setPriceAmt] = useState("19000");
  const [pkgName, setPkgName] = useState("باقة المريخ");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  let orders: ReturnType<SamaWorkspace["repairs"]["listOrders"]> = [];
  try { orders = ws.repairs.listOrders(actor); } catch { /* restricted */ }

  const wallets = [
    ws.telecom.getWallet(ws.tenantId, ws.syriatelWalletId),
    ws.telecom.getWallet(ws.tenantId, ws.mtnWalletId),
    ws.telecom.getWallet(ws.tenantId, ws.shamCashWalletId),
  ];

  const createTicket = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const o = ws.repairs.createRepairOrder(actor, {
        customerName: cust, deviceModel: model, issueDescription: issue,
        currency: "USD", serviceFeeMinor: parseTextToMinor(fee, "USD"), warrantyDays: 14,
      });
      setCust(""); setModel(""); setIssue(""); setMsg(`تم استلام جهاز الصيانة ${o.ticketNumber}.`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل تسجيل الصيانة."); }
  };

  const deliverTicket = (id: string) => {
    setMsg(""); setErr("");
    try {
      ws.repairs.deliverRepairOrder(actor, { orderId: id, idempotencyKey: newOperationKey(), businessDate: todayIso(), paymentMode: "cash", cashboxId: "cb-usd" });
      setMsg("تم تسليم الجهاز وقبض الأجرة محاسبياً."); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل التسليم."); }
  };
  const reverseTicket = (id: string) => {
    setMsg(""); setErr("");
    try {
      ws.repairs.reverseDeliveredRepair(actor, id, newOperationKey(), todayIso());
      setMsg("تم عكس تذكرة الصيانة بالكامل."); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل العكس."); }
  };

  const recharge = () => {
    setMsg(""); setErr("");
    try {
      const w = ws.telecom.getWallet(ws.tenantId, wId);
      ws.telecom.rechargeWallet(actor, {
        idempotencyKey: newOperationKey(), businessDate: todayIso(), walletId: w.id,
        faceAmountMinor: parseTextToMinor(faceAmt, w.currency), purchaseCostMinor: parseTextToMinor(priceAmt, w.currency),
        paymentMode: "cash", cashboxId: w.currency === "SYP" ? "cb-syp" : "cb-usd",
      });
      setMsg(`تم شحن ${w.label} بنجاح.`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل الشحن."); }
  };

  const sellTopup = () => {
    setMsg(""); setErr("");
    try {
      const w = ws.telecom.getWallet(ws.tenantId, wId);
      const rec = ws.telecom.postTopupSale(actor, {
        idempotencyKey: newOperationKey(), businessDate: todayIso(), walletId: w.id,
        faceAmountMinor: parseTextToMinor(faceAmt, w.currency), chargedMinor: parseTextToMinor(priceAmt, w.currency),
        paymentMode: "cash", cashboxId: w.currency === "SYP" ? "cb-syp" : "cb-usd", packageName: pkgName,
      });
      setMsg(`تم التحويل · الربح: ${formatMinorAmount(rec.grossProfitMinor, rec.currency)}`); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل التحويل."); }
  };

  return (
    <div className="sb-stack">
      {err && <div className="sb-alert err">{err}</div>}
      {msg && <div className="sb-alert ok">{msg}</div>}
      <form className="sb-card" onSubmit={createTicket}>
        <div className="sb-card-head"><Wrench size={17} /><strong>استلام جهاز صيانة جديد</strong></div>
        <div className="sb-form-grid">
          <input value={cust} onChange={(e) => setCust(e.target.value)} placeholder="اسم الزبون" required />
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="موديل الجهاز" required />
          <input value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="العطل" required />
          <input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="الأجرة ($)" dir="ltr" required />
        </div>
        <button type="submit" className="sb-btn-primary">تسجيل أمر صيانة</button>
      </form>
      {orders.length > 0 && (
        <div className="sb-card">
          <div className="sb-card-head"><strong>أوامر الصيانة ({orders.length})</strong></div>
          <div className="sb-list">
            {orders.map((o) => (
              <div key={o.id} className={`sb-row${o.status === "reversed" ? " muted" : ""}`}>
                <div><strong>{o.ticketNumber}</strong> · {o.deviceModel} ({o.customerName})<small>{o.issueDescription} · <b dir="ltr">{formatMinorAmount(o.serviceFeeMinor, o.currency)}</b></small></div>
                {o.status === "received" || o.status === "completed" ? (
                  <button type="button" className="sb-btn-secondary" onClick={() => deliverTicket(o.id)}>تسليم وقبض</button>
                ) : o.status === "delivered" ? (
                  <button type="button" className="sb-btn-danger" onClick={() => reverseTicket(o.id)}><RotateCcw size={13} /> عكس</button>
                ) : <span className="sb-tag">معكوس</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sb-card">
        <div className="sb-card-head"><Smartphone size={17} /><strong>محافظ رصيد الاتصالات (WAC)</strong></div>
        <div className="sb-list">
          {wallets.map((w) => (
            <div key={w.id} className="sb-row">
              <strong>{w.label}</strong>
              <span className="sb-tag" dir="ltr">{formatMinorAmount(w.faceBalanceMinor, w.currency)}</span>
            </div>
          ))}
        </div>
        <div className="sb-form-grid">
          <select value={wId} onChange={(e) => setWId(e.target.value)}>{wallets.map((w) => <option key={w.id} value={w.id}>{w.label} ({w.currency})</option>)}</select>
          <input value={pkgName} onChange={(e) => setPkgName(e.target.value)} placeholder="الباقة (المريخ / الزهرة)" />
          <input value={faceAmt} onChange={(e) => setFaceAmt(e.target.value)} placeholder="الرصيد الاسمي" dir="ltr" />
          <input value={priceAmt} onChange={(e) => setPriceAmt(e.target.value)} placeholder="التكلفة أو سعر المبيع" dir="ltr" />
        </div>
        <div className="sb-form-grid">
          <button type="button" className="sb-btn-secondary" onClick={recharge}>شحن جملة للمحفظة</button>
          <button type="button" className="sb-btn-primary" onClick={sellTopup}>تحويل رصيد للزبون</button>
        </div>
      </div>
    </div>
  );
}
