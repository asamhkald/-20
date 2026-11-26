import { useState, type FormEvent } from "react";
import { ArrowLeftRight, PlusCircle } from "lucide-react";
import { newOperationKey, todayIso, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";
import { JournalList } from "./JournalList";

type Props = Readonly<{ ws: SamaWorkspace; actor: TenantContext; offlineMode: boolean; onChanged: () => void }>;

export function CashboxesTab({ ws, actor, offlineMode, onChanged }: Props) {
  const [kind, setKind] = useState<"opening" | "sale" | "expense">("opening");
  const [boxId, setBoxId] = useState("cb-usd");
  const [amount, setAmount] = useState("100.00");
  const [memo, setMemo] = useState("");
  const [fxFrom, setFxFrom] = useState("cb-usd");
  const [fxTo, setFxTo] = useState("cb-syp");
  const [fxAmt, setFxAmt] = useState("50.00");
  const [fxRate, setFxRate] = useState("115.00");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const runOp = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const date = todayIso(), key = newOperationKey(), cur = boxId === "cb-syp" ? "SYP" : "USD";
      if (offlineMode && kind !== "opening") {
        ws.offline.enqueue(actor, kind === "sale"
          ? { kind: "cash_sale", businessDate: date, currency: cur, cashboxId: boxId, saleAmountText: amount, memo: memo || "بيع أوفلاين" }
          : { kind: "cash_expense", businessDate: date, cashboxId: boxId, amountText: amount, memo: memo || "مصروف أوفلاين" }, key);
        setMsg("حُفظت في طابور الأوفلاين للمزامنة لاحقاً.");
      } else if (kind === "opening") {
        ws.accounting.postOpeningBalance(actor, { idempotencyKey: key, businessDate: date, cashboxId: boxId, amountText: amount, memo: memo || "رصيد افتتاحي" });
        setMsg("تم ترحيل الرصيد الافتتاحي.");
      } else if (kind === "sale") {
        ws.accounting.postCashSale(actor, { idempotencyKey: key, businessDate: date, currency: cur, cashboxId: boxId, saleAmountText: amount, memo: memo || "بيع نقدي" });
        setMsg("تم ترحيل البيع النقدي.");
      } else {
        ws.accounting.postCashExpense(actor, { idempotencyKey: key, businessDate: date, cashboxId: boxId, amountText: amount, memo: memo || "مصروف نقدي" });
        setMsg("تم ترحيل المصروف النقدي.");
      }
      setMemo(""); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشلت العملية."); }
  };
  const runFx = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const date = todayIso(), fCur = fxFrom === "cb-syp" ? "SYP" : "USD", tCur = fxTo === "cb-syp" ? "SYP" : "USD";
      ws.accounting.transferBetweenCashboxes(actor, {
        idempotencyKey: newOperationKey(), businessDate: date, fromCashboxId: fxFrom, toCashboxId: fxTo, amountText: fxAmt,
        fxQuote: fCur !== tCur ? { fromCurrency: fCur, toCurrency: tCur, rateText: fxRate, effectiveDate: date, source: "سعر السوق" } : undefined,
      });
      setMsg("تم تنفيذ التحويل الموثّق."); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل التحويل."); }
  };

  return (
    <div className="sb-stack">
      {err && <div className="sb-alert err">{err}</div>}
      {msg && <div className="sb-alert ok">{msg}</div>}
      <form className="sb-card" onSubmit={runOp}>
        <div className="sb-card-head"><PlusCircle size={17} /><strong>حركة صندوق سريعة</strong></div>
        <div className="sb-form-grid">
          <select value={kind} onChange={(e) => setKind(e.target.value as "opening" | "sale" | "expense")}>
            <option value="opening">رصيد افتتاحي</option><option value="sale">قبض بيع نقدي</option><option value="expense">مصروف نقدي</option>
          </select>
          <select value={boxId} onChange={(e) => setBoxId(e.target.value)}>
            <option value="cb-usd">صندوق الدولار ($)</option><option value="cb-syp">صندوق الليرة</option><option value="cb-wallet-usd">المحفظة ($)</option>
          </select>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="المبلغ" dir="ltr" required />
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="البيان" />
        </div>
        <button type="submit" className="sb-btn-primary">ترحيل العملية</button>
      </form>
      <form className="sb-card" onSubmit={runFx}>
        <div className="sb-card-head"><ArrowLeftRight size={17} /><strong>تحويل بين الصناديق / تصريف عملة</strong></div>
        <div className="sb-form-grid">
          <select value={fxFrom} onChange={(e) => setFxFrom(e.target.value)}><option value="cb-usd">من: الدولار</option><option value="cb-syp">من: الليرة</option><option value="cb-wallet-usd">من: المحفظة</option></select>
          <select value={fxTo} onChange={(e) => setFxTo(e.target.value)}><option value="cb-syp">إلى: الليرة</option><option value="cb-usd">إلى: الدولار</option><option value="cb-wallet-usd">إلى: المحفظة</option></select>
          <input value={fxAmt} onChange={(e) => setFxAmt(e.target.value)} placeholder="المبلغ" dir="ltr" required />
          <input value={fxRate} onChange={(e) => setFxRate(e.target.value)} placeholder="سعر الصرف" dir="ltr" />
        </div>
        <button type="submit" className="sb-btn-secondary">تنفيذ التحويل</button>
      </form>
      <JournalList ws={ws} actor={actor} onDone={(ok, er) => { setMsg(ok); setErr(er ?? ""); onChanged(); }} />
    </div>
  );
}
