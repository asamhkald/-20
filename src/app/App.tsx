import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Cloud, ExternalLink, Home, LogOut, RefreshCw, ShoppingBag, Sparkles, Wifi, WifiOff, Wrench } from "lucide-react";
import type { TenantRole } from "../core/tenant";
import {
  createSamaWorkspace, loadCloudWorkspace, makeActor, restoreCloudSession,
  saveCloudWorkspace, sessionToActor, signOutCloud, type ActiveUserSession, type SamaWorkspace,
} from "../services";
import { LoginScreen } from "./components/LoginScreen";
import { DashboardTab } from "./components/DashboardTab";
import { CashboxesTab } from "./components/CashboxesTab";
import { CommerceTab } from "./components/CommerceTab";
import { ServicesTab } from "./components/ServicesTab";
import { AiReportsTab } from "./components/AiReportsTab";

type TabId = "dashboard" | "cashboxes" | "commerce" | "services" | "ai";
type SyncStatus = "idle" | "loading" | "saving" | "saved" | "error";

export function App() {
  const [session, setSession] = useState<ActiveUserSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sandboxRole, setSandboxRole] = useState<TenantRole>("owner");
  const [tab, setTab] = useState<TabId>("dashboard");
  const [offlineMode, setOfflineMode] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncErr, setSyncErr] = useState("");
  const [, setTick] = useState(0);

  const tenantId = session?.verified.tenantId ?? "sama-main-shop";
  const [ws, setWs] = useState<SamaWorkspace>(() => createSamaWorkspace(tenantId));
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const cloudVerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const actor = useMemo(() => {
    if (!session) return makeActor(tenantId, "owner");
    return session.mode === "cloud" ? sessionToActor(session) : makeActor(tenantId, sandboxRole);
  }, [session, tenantId, sandboxRole]);

  useEffect(() => {
    document.documentElement.lang = "ar"; document.documentElement.dir = "rtl";
    let active = true;
    restoreCloudSession().then((restored) => {
      if (active) { if (restored) setSession(restored); setCheckingSession(false); }
    });
    return () => { active = false; };
  }, []);

  const pullFromCloud = useCallback(async (targetTenant: string, curActor: ReturnType<typeof makeActor>) => {
    setSyncStatus("loading"); setSyncErr("");
    try {
      const fresh = createSamaWorkspace(targetTenant);
      const res = await loadCloudWorkspace(fresh, curActor);
      wsRef.current = res.workspace; cloudVerRef.current = res.version;
      setWs(res.workspace); setSyncStatus(res.loadedFromCloud ? "saved" : "idle");
      setTick((t) => t + 1);
    } catch (ex) {
      setSyncStatus("error"); setSyncErr(ex instanceof Error ? ex.message : "تعذر جلب البيانات السحابية.");
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    if (session.mode === "cloud") { void pullFromCloud(session.verified.tenantId, sessionToActor(session)); }
    else {
      const fresh = createSamaWorkspace(session.verified.tenantId);
      wsRef.current = fresh; cloudVerRef.current = null; setWs(fresh); setSyncStatus("idle"); setSyncErr("");
    }
  }, [session, pullFromCloud]);
  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    if (!session || session.mode !== "cloud" || offlineMode) return;
    setSyncStatus("saving"); setSyncErr("");
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const res = await saveCloudWorkspace(wsRef.current, actor, cloudVerRef.current);
        cloudVerRef.current = res.version; setSyncStatus("saved");
      } catch (ex) {
        const m = ex instanceof Error ? ex.message : "فشل الحفظ السحابي.";
        setSyncStatus("error");
        setSyncErr(m.includes("SYNC_CONFLICT") ? "تم تعديل البيانات من جهاز آخر — اضغط تحديث لجلب آخر نسخة." : m);
      }
    });
  }, [session, offlineMode, actor]);

  const handleSignOut = async () => {
    if (session?.mode === "cloud") await signOutCloud();
    setSession(null); cloudVerRef.current = null; setTab("dashboard"); setSyncErr("");
  };

  if (checkingSession) return <div className="sb-login-wrap" dir="rtl"><div className="sb-card"><strong>جارٍ التحقق من الجلسة...</strong></div></div>;
  if (!session) return <LoginScreen onAuthenticated={(s) => { setSession(s); setSandboxRole(s.verified.role); }} />;

  const syncLabel = syncStatus === "loading" ? "جارٍ الجلب..." : syncStatus === "saving" ? "جارٍ الحفظ..." : syncStatus === "saved" ? "محفوظ سحابياً ✓" : syncStatus === "error" ? "خطأ مزامنة" : "سحابي جاهز";
  return (
    <div className="sb-app" dir="rtl">
      <header className="sb-topbar">
        <div className="sb-brand">
          <span className="sb-logo">S</span>
          <div><strong>{session.verified.organization.legalName}</strong><small>{session.mode === "cloud" ? `${syncLabel} · ${actor.role}` : "وضع تجريبي معزول"}</small></div>
        </div>
        <div className="sb-top-actions">
          {session.mode === "sandbox" ? (
            <select className="sb-role-select" value={sandboxRole} onChange={(e) => setSandboxRole(e.target.value as TenantRole)} aria-label="الدور">
              <option value="owner">المالك</option><option value="accountant">محاسب</option><option value="cashier">كاشير</option><option value="sales">مبيعات</option><option value="technician">فني</option>
            </select>
          ) : (
            <button type="button" className="sb-net-btn" onClick={() => void pullFromCloud(session.verified.tenantId, actor)} title="تحديث من السحابة">
              {syncStatus === "loading" || syncStatus === "saving" ? <RefreshCw size={15} /> : <Cloud size={15} />}
            </button>
          )}
          <button type="button" className={`sb-net-btn${offlineMode ? " off" : ""}`} onClick={() => setOfflineMode((v) => !v)}>{offlineMode ? <WifiOff size={15} /> : <Wifi size={15} />}</button>
          <a className="sb-legacy-link" href="./app/index.html" title="التطبيق السابق"><ExternalLink size={15} /></a>
          <button type="button" className="sb-net-btn" onClick={handleSignOut} title="تسجيل الخروج"><LogOut size={15} /></button>
        </div>
      </header>
      <main className="sb-content">
        {syncErr && (
          <div className="sb-alert err" style={{ marginBottom: 12, justifyContent: "space-between" }}>
            <span>{syncErr}</span>
            {session.mode === "cloud" && <button type="button" className="sb-btn-secondary" onClick={() => void pullFromCloud(session.verified.tenantId, actor)}>تحديث الآن</button>}
          </div>
        )}
        {syncStatus === "loading" ? <div className="sb-card"><strong>جارٍ تحميل بياناتك السحابية...</strong></div> : (
          <>
            {tab === "dashboard" && <DashboardTab ws={ws} actor={actor} offlineMode={offlineMode} onNavigate={setTab} />}
            {tab === "cashboxes" && <CashboxesTab ws={ws} actor={actor} offlineMode={offlineMode} onChanged={refresh} />}
            {tab === "commerce" && <CommerceTab ws={ws} actor={actor} onChanged={refresh} />}
            {tab === "services" && <ServicesTab ws={ws} actor={actor} onChanged={refresh} />}
            {tab === "ai" && <AiReportsTab ws={ws} actor={actor} onChanged={refresh} />}
          </>
        )}
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
