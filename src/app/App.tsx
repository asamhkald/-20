import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ExternalLink, Home, ShoppingBag, Sparkles, Wifi, WifiOff, Wrench } from "lucide-react";
import type { TenantRole } from "../core/tenant";
import { createSamaWorkspace, makeActor } from "../services";
import { DashboardTab } from "./components/DashboardTab";
import { CashboxesTab } from "./components/CashboxesTab";
import { CommerceTab } from "./components/CommerceTab";
import { ServicesTab } from "./components/ServicesTab";
import { AiReportsTab } from "./components/AiReportsTab";

type TabId = "dashboard" | "cashboxes" | "commerce" | "services" | "ai";

export function App() {
  const ws = useMemo(() => createSamaWorkspace("sama-main-shop"), []);
  const [role, setRole] = useState<TenantRole>("owner");
  const [tab, setTab] = useState<TabId>("dashboard");
  const [offlineMode, setOfflineMode] = useState(false);
  const [, setTick] = useState(0);
  const actor = useMemo(() => makeActor(ws.tenantId, role), [ws.tenantId, role]);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => { document.documentElement.lang = "ar"; document.documentElement.dir = "rtl"; }, []);

  return (
    <div className="sb-app" dir="rtl">
      <header className="sb-topbar">
        <div className="sb-brand"><span className="sb-logo">S</span><div><strong>سما للأعمال</strong><small>Sama Business ERP</small></div></div>
        <div className="sb-top-actions">
          <select className="sb-role-select" value={role} onChange={(e) => setRole(e.target.value as TenantRole)} aria-label="الدور">
            <option value="owner">المالك</option><option value="accountant">محاسب</option><option value="cashier">كاشير</option><option value="sales">مبيعات</option><option value="technician">فني</option>
          </select>
          <button type="button" className={`sb-net-btn${offlineMode ? " off" : ""}`} onClick={() => setOfflineMode((v) => !v)}>{offlineMode ? <WifiOff size={15} /> : <Wifi size={15} />}</button>
          <a className="sb-legacy-link" href="./app/index.html" title="التطبيق السابق"><ExternalLink size={15} /></a>
        </div>
      </header>
      <main className="sb-content">
        {tab === "dashboard" && <DashboardTab ws={ws} actor={actor} offlineMode={offlineMode} onNavigate={setTab} />}
        {tab === "cashboxes" && <CashboxesTab ws={ws} actor={actor} offlineMode={offlineMode} onChanged={refresh} />}
        {tab === "commerce" && <CommerceTab ws={ws} actor={actor} onChanged={refresh} />}
        {tab === "services" && <ServicesTab ws={ws} actor={actor} onChanged={refresh} />}
        {tab === "ai" && <AiReportsTab ws={ws} actor={actor} onChanged={refresh} />}
      </main>
      <nav className="sb-bottom-nav" aria-label="التنقل">
        <button type="button" className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}><Home size={19} /><span>الرئيسية</span></button>
        <button type="button" className={tab === "cashboxes" ? "active" : ""} onClick={() => setTab("cashboxes")}><ArrowLeftRight size={19} /><span>الصناديق</span></button>
        <button type="button" className={tab === "commerce" ? "active" : ""} onClick={() => setTab("commerce")}><ShoppingBag size={19} /><span>المبيعات</span></button>
        <button type="button" className={tab === "services" ? "active" : ""} onClick={() => setTab("services")}><Wrench size={19} /><span>الصيانة</span></button>
        <button type="button" className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}><Sparkles size={19} /><span>الذكي</span></button>
      </nav>
    </div>
  );
}
