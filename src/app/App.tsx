import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ExternalLink, Home, LogOut, ShoppingBag, Sparkles, Wifi, WifiOff, Wrench } from "lucide-react";
import type { TenantRole } from "../core/tenant";
import {
  createSamaWorkspace, makeActor, restoreCloudSession, sessionToActor, signOutCloud, type ActiveUserSession,
} from "../services";
import { LoginScreen } from "./components/LoginScreen";
import { DashboardTab } from "./components/DashboardTab";
import { CashboxesTab } from "./components/CashboxesTab";
import { CommerceTab } from "./components/CommerceTab";
import { ServicesTab } from "./components/ServicesTab";
import { AiReportsTab } from "./components/AiReportsTab";

type TabId = "dashboard" | "cashboxes" | "commerce" | "services" | "ai";

export function App() {
  const [session, setSession] = useState<ActiveUserSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sandboxRole, setSandboxRole] = useState<TenantRole>("owner");
  const [tab, setTab] = useState<TabId>("dashboard");
  const [offlineMode, setOfflineMode] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    document.documentElement.lang = "ar"; document.documentElement.dir = "rtl";
    let active = true;
    restoreCloudSession().then((restored) => {
      if (active) { if (restored) setSession(restored); setCheckingSession(false); }
    });
    return () => { active = false; };
  }, []);

  const tenantId = session?.verified.tenantId ?? "sama-main-shop";
  const ws = useMemo(() => createSamaWorkspace(tenantId), [tenantId]);
  const actor = useMemo(() => {
    if (!session) return makeActor(tenantId, "owner");
    return session.mode === "cloud" ? sessionToActor(session) : makeActor(tenantId, sandboxRole);
  }, [session, tenantId, sandboxRole]);
  const refresh = () => setTick((t) => t + 1);
  const handleSignOut = async () => {
    if (session?.mode === "cloud") await signOutCloud();
    setSession(null); setTab("dashboard");
  };

  if (checkingSession) return <div className="sb-login-wrap" dir="rtl"><div className="sb-card"><strong>جارٍ التحقق من الجلسة...</strong></div></div>;
  if (!session) return <LoginScreen onAuthenticated={(s) => { setSession(s); setSandboxRole(s.verified.role); }} />;

  return (
    <div className="sb-app" dir="rtl">
      <header className="sb-topbar">
        <div className="sb-brand">
          <span className="sb-logo">S</span>
          <div><strong>{session.verified.organization.legalName}</strong><small>{session.mode === "cloud" ? `سحابي · ${actor.role}` : "وضع تجريبي معزول"}</small></div>
        </div>
        <div className="sb-top-actions">
          {session.mode === "sandbox" ? (
            <select className="sb-role-select" value={sandboxRole} onChange={(e) => setSandboxRole(e.target.value as TenantRole)} aria-label="الدور">
              <option value="owner">المالك</option><option value="accountant">محاسب</option><option value="cashier">كاشير</option><option value="sales">مبيعات</option><option value="technician">فني</option>
            </select>
          ) : <span className="sb-tag">{actor.role}</span>}
          <button type="button" className={`sb-net-btn${offlineMode ? " off" : ""}`} onClick={() => setOfflineMode((v) => !v)}>{offlineMode ? <WifiOff size={15} /> : <Wifi size={15} />}</button>
          <a className="sb-legacy-link" href="./app/index.html" title="التطبيق السابق"><ExternalLink size={15} /></a>
          <button type="button" className="sb-net-btn" onClick={handleSignOut} title="تسجيل الخروج"><LogOut size={15} /></button>
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
