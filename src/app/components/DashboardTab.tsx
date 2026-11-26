import { CheckCircle2, ArrowLeftRight, ShoppingBag, Wrench, Sparkles, WifiOff } from "lucide-react";
import { formatMinorAmount, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";

type Props = Readonly<{
  ws: SamaWorkspace; actor: TenantContext; offlineMode: boolean;
  onNavigate: (tab: "cashboxes" | "commerce" | "services" | "ai") => void;
}>;

export function DashboardTab({ ws, actor, offlineMode, onNavigate }: Props) {
  let err = "", balanced = true, entryCount = 0;
  let usdBal = 0n, sypBal = 0n, usdProfit = 0n, sypProfit = 0n;
  try {
    const snap = ws.accounting.getSnapshot(actor);
    const pack = ws.reports.generateFinancialStatements(actor);
    usdBal = ws.accounting.getCashboxStatement(actor, "cb-usd").currentBalanceMinor;
    sypBal = ws.accounting.getCashboxStatement(actor, "cb-syp").currentBalanceMinor;
    usdProfit = pack.incomeStatements.USD?.netProfitMinor ?? 0n;
    sypProfit = pack.incomeStatements.SYP?.netProfitMinor ?? 0n;
    balanced = pack.allTrialBalancesBalanced;
    entryCount = snap.entries.length;
  } catch (e) { err = e instanceof Error ? e.message : "غير مصرح بعرض الأرصدة المالية لهذا الدور."; }

  const pending = ws.offline.listQueue(actor).filter((i) => i.status === "pending" || i.status === "failed").length;

  return (
    <div className="sb-stack">
      <div className="sb-hero">
        <div className="sb-hero-top">
          <div><span className="sb-badge">Sama Business · v2.0</span><h2>لوحة التحكم المالية</h2></div>
          <span className={`sb-pill ${balanced ? "ok" : "err"}`}><CheckCircle2 size={14} /> {balanced ? "ميزان متوازن" : "مراجعة"}</span>
        </div>
        {err ? <div className="sb-alert err">{err}</div> : (
          <div className="sb-kpi-grid">
            <div className="sb-kpi"><span>صندوق الدولار (USD)</span><strong dir="ltr">{formatMinorAmount(usdBal, "USD")}</strong><small>صافي الربح: <b dir="ltr">{formatMinorAmount(usdProfit, "USD")}</b></small></div>
            <div className="sb-kpi"><span>صندوق الليرة (SYP)</span><strong dir="ltr">{formatMinorAmount(sypBal, "SYP")}</strong><small>صافي الربح: <b dir="ltr">{formatMinorAmount(sypProfit, "SYP")}</b></small></div>
          </div>
        )}
      </div>
      {offlineMode && <div className="sb-alert warn"><WifiOff size={16} /> وضع الأوفلاين نشط — بانتظار المزامنة: <b>{pending}</b></div>}
      <div className="sb-quick-grid">
        <button type="button" className="sb-quick-btn" onClick={() => onNavigate("cashboxes")}><ArrowLeftRight size={19} /><span>الصناديق والصرف</span></button>
        <button type="button" className="sb-quick-btn" onClick={() => onNavigate("commerce")}><ShoppingBag size={19} /><span>المبيعات والمخزون</span></button>
        <button type="button" className="sb-quick-btn" onClick={() => onNavigate("services")}><Wrench size={19} /><span>الصيانة والاتصالات</span></button>
        <button type="button" className="sb-quick-btn" onClick={() => onNavigate("ai")}><Sparkles size={19} /><span>الذكي والتقارير</span></button>
      </div>
      <div className="sb-card">
        <div className="sb-card-head"><strong>الحالة المحاسبية</strong><span className="sb-tag">{entryCount} قيد مرحّل</span></div>
        <p className="sb-muted">الأرصدة محسوبة حصراً من القيود المزدوجة بـ BigInt دون كسور عائمة، مع حماية منع التكرار والقيود العكسية.</p>
      </div>
    </div>
  );
}
