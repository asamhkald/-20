import { useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowUpRight, BadgeCheck, BookOpenCheck, Boxes,
  Briefcase, Building2, BarChart3, ChevronDown, CircleHelp,
  CreditCard, FileText, Globe, Layers3, Menu, Search, ShieldCheck,
  ShoppingBag, Users, Wallet, Wrench, X,
} from "lucide-react";
import { MODULES } from "../core/module-registry";

type Language = "en" | "ar";

const iconByModule: Record<string, typeof Wallet> = {
  finance: Wallet,
  sales: ShoppingBag,
  inventory: Boxes,
  procurement: ArrowDownLeft,
  crm: Users,
  people: Briefcase,
  operations: Wrench,
  telecom: CreditCard,
  reports: BarChart3,
};

const copy = {
  en: {
    overview: "Overview", modules: "Modules", foundation: "Foundation", help: "Help center",
    workspace: "WORKSPACE", premium: "BUSINESS OPERATING SYSTEM", headline: "A clearer view of your entire business.",
    subhead: "One modular platform for finance, commerce, inventory and day-to-day operations — designed to grow with every business.",
    search: "Search modules…", allModules: "All modules", roadmap: "Product roadmap", activePhase: "CURRENT BUILD",
    phaseZero: "Enterprise · v1.1 IFRS + RBAC", foundations: "The core we are building first", foundationsSub: "Reliable financial rules, secure company boundaries and a database model that can scale.",
    accounting: "Accounting engine", accountingDesc: "Exact money arithmetic, balanced journal validation and reversal-first correction rules.",
    security: "Security boundaries", securityDesc: "Tenant context and role rules are prepared; server and database enforcement still require integration.",
    data: "Data integrity", dataDesc: "A safe migration path that keeps your current application and its records untouched.",
    ready: "Domain foundation", planned: "Planned phase", phase: "PHASE", moduleHeader: "A module for every part of work", moduleSub: "Start with the essentials. Add specialist capabilities without tangling the core.",
    next: "Next delivery", nextTitle: "Connect the real business data safely", nextDesc: "The next integration step requires the complete source project and a schema-only database export. No live database changes are made in this build.",
    sourceNeeded: "Full source + schema required", protected: "Original project preserved", protectedDesc: "The uploaded original archive remains unchanged inside the legacy folder.",
    noResults: "No modules match your search.", footer: "A modular foundation for businesses everywhere.", language: "العربية", preview: "Enterprise v1.1",
    liveApp: "Open live system", liveAppShort: "Live App", liveBadge: "Live",
    liveHeroCta: "Launch Sama Enterprise Workspace", liveHeroNote: "Arabic Voice AI · BigInt Exact Math · Hidden UUID",
  },
  ar: {
    overview: "نظرة عامة", modules: "الوحدات", foundation: "الأساس التقني", help: "مركز المساعدة",
    workspace: "مساحة العمل", premium: "نظام تشغيل الأعمال", headline: "رؤية أوضح لكل تفاصيل أعمالك.",
    subhead: "منصة موحدة قابلة للتوسع للمحاسبة والتجارة والمخزون والتشغيل اليومي، ومهيأة لخدمة مختلف أنواع الأعمال.",
    search: "ابحث عن وحدة…", allModules: "جميع الوحدات", roadmap: "خطة التطوير", activePhase: "مرحلة البناء الحالية",
    phaseZero: "النسخة العالمية · v1.1 (IFRS + RBAC)", foundations: "النواة التي نبدأ ببنائها", foundationsSub: "قواعد مالية دقيقة، وحدود آمنة لكل شركة، ونموذج بيانات قابل للتوسع.",
    accounting: "المحرك المحاسبي", accountingDesc: "حسابات مالية دقيقة، والتحقق من توازن القيود، وتصحيحها بقيود عكسية.",
    security: "حدود الأمان والصلاحيات", securityDesc: "تم إعداد سياق الشركات وقواعد الأدوار؛ ويبقى ربط التحقق الفعلي في الخادم وقاعدة البيانات.",
    data: "سلامة البيانات", dataDesc: "مسار ترحيل آمن يحافظ على تطبيقك الحالي وسجلاته دون المساس بها.",
    ready: "أساس برمجي", planned: "ضمن خطة المرحلة", phase: "المرحلة", moduleHeader: "وحدة مستقلة لكل جزء من أعمالك", moduleSub: "ابدأ بالأساسيات، ثم أضف القدرات المتخصصة دون خلط منطق الأنظمة.",
    next: "التسليم التالي", nextTitle: "ربط بيانات العمل الفعلية بأمان", nextDesc: "تتطلب خطوة الربط التالية المشروع الكامل وتصديراً لمخطط قاعدة البيانات فقط. لم تُنفّذ أي تغييرات على قاعدة بيانات حية في هذه النسخة.",
    sourceNeeded: "يلزم المشروع الكامل ومخطط القاعدة", protected: "المشروع الأصلي محفوظ", protectedDesc: "الأرشيف الأصلي المرفوع محفوظ كما هو داخل مجلد legacy.",
    noResults: "لا توجد وحدات تطابق البحث.", footer: "أساس تقني مرن لمختلف الأعمال حول العالم.", language: "English", preview: "الإصدار العالمي v1.1",
    liveApp: "الدخول للبرنامج العامل", liveAppShort: "البرنامج العامل", liveBadge: "مباشر",
    liveHeroCta: "الدخول إلى نظام Sama Enterprise العالمي", liveHeroNote: "إدخال صوتي بالعربية · دقة BigInt · أرقام UUID مخفية",
  },
} as const;

export function App() {
  const [language, setLanguage] = useState<Language>("ar");
  const [query, setQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isArabic = language === "ar";
  const t = copy[language];
  const filteredModules = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return MODULES;
    return MODULES.filter((module) =>
      [module.name, module.nameAr, module.description, module.descriptionAr]
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [query]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = isArabic ? "rtl" : "ltr";
  }, [language, isArabic]);

  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <main className={`app-shell${isArabic ? " is-rtl" : ""}`} dir={isArabic ? "rtl" : "ltr"}>
      <aside className={`sidebar${mobileMenuOpen ? " sidebar-open" : ""}`}>
        <a className="brand" href="#home" onClick={closeMenu} aria-label="Sama Business home">
          <span className="brand-symbol">S<span>.</span></span>
          <span className="brand-copy"><strong>SAMA</strong><small>BUSINESS</small></span>
        </a>
        <div className="workspace-label">{t.workspace}</div>
        <nav className="side-nav" aria-label={t.workspace}>
          <a className="nav-link selected" href="#home" onClick={closeMenu}><Layers3 size={17} />{t.overview}</a>
          <a className="nav-link" href="#modules" onClick={closeMenu}><Boxes size={17} />{t.modules}<span className="nav-count">{MODULES.length}</span></a>
          <a className="nav-link" href="#foundation" onClick={closeMenu}><BookOpenCheck size={17} />{t.foundation}</a>
          <a className="nav-link nav-link-live" href="./app/index.html" onClick={closeMenu}><Wallet size={17} />{t.liveApp}<span className="nav-live-badge">{t.liveBadge}</span></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help"><CircleHelp size={17} /><span>{t.help}</span><ChevronDown size={14} /></div>
          <div className="profile-row">
            <div className="profile-avatar">SB</div>
            <div className="profile-copy"><strong>Sama Business</strong><small>{t.preview}</small></div>
            <span className="online-dot" aria-label="Preview mode" />
          </div>
        </div>
      </aside>

      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={closeMenu} />}

      <section className="main-area" id="home">
        <header className="topbar">
          <button className="mobile-menu-button" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>{t.overview}</span><span className="crumb-slash">/</span><strong>Sama Business</strong></div>
          <div className="topbar-actions">
            <a className="launch-button" href="./app/index.html">{t.liveAppShort}<ArrowUpRight size={15} /></a>
            <span className="preview-pill"><span />{t.preview}</span>
            <button className="language-button" onClick={() => setLanguage(isArabic ? "en" : "ar")}><Globe size={16} />{t.language}</button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="hero-panel">
            <div className="hero-copy">
              <div className="hero-eyebrow"><span className="eyebrow-line" />{t.premium}</div>
              <h1>{t.headline}</h1>
              <p>{t.subhead}</p>
              <div className="hero-tags"><span><Building2 size={14} />Multi-company</span><span><Globe size={14} />Arabic / English</span><span><ShieldCheck size={14} />Security-first</span></div>
              <div className="hero-actions">
                <a className="hero-cta" href="./app/index.html">{t.liveHeroCta}<ArrowUpRight size={17} /></a>
                <span className="hero-cta-note">{t.liveHeroNote}</span>
              </div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="hero-emblem"><Activity size={36} strokeWidth={1.4} /></div>
              <div className="float-card float-card-one"><span className="float-icon"><BarChart3 size={15} /></span><span><b>Modular</b><small>Architecture</small></span></div>
              <div className="float-card float-card-two"><span className="float-icon mint"><BadgeCheck size={15} /></span><span><b>Integrity</b><small>By design</small></span></div>
            </div>
          </section>

          <section className="section-block" id="foundation">
            <div className="section-heading">
              <div><div className="section-kicker">{t.activePhase}</div><h2>{t.foundations}</h2><p>{t.foundationsSub}</p></div>
              <span className="phase-chip">{t.phaseZero}</span>
            </div>
            <div className="foundation-grid">
              <article className="foundation-card"><div className="foundation-icon blue"><BookOpenCheck size={19} /></div><div className="foundation-title">{t.accounting}</div><p>{t.accountingDesc}</p><div className="foundation-foot"><span className="status-dot" />{t.ready}</div></article>
              <article className="foundation-card"><div className="foundation-icon purple"><ShieldCheck size={19} /></div><div className="foundation-title">{t.security}</div><p>{t.securityDesc}</p><div className="foundation-foot"><span className="status-dot" />{t.ready}</div></article>
              <article className="foundation-card"><div className="foundation-icon amber"><FileText size={19} /></div><div className="foundation-title">{t.data}</div><p>{t.dataDesc}</p><div className="foundation-foot"><span className="status-dot muted" />{t.protected}</div></article>
            </div>
          </section>

          <section className="section-block modules-section" id="modules">
            <div className="section-heading module-heading">
              <div><div className="section-kicker">{t.allModules}</div><h2>{t.moduleHeader}</h2><p>{t.moduleSub}</p></div>
              <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search} aria-label={t.search} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}</label>
            </div>
            <div className="module-grid">
              {filteredModules.map((module) => {
                const Icon = iconByModule[module.id] ?? Layers3;
                return <article className="module-card" key={module.id}>
                  <div className="module-top"><div className={`module-icon module-${module.id}`}><Icon size={19} strokeWidth={1.8} /></div><span className="module-phase">{t.phase} {String(module.phase).padStart(2, "0")}</span></div>
                  <h3>{isArabic ? module.nameAr : module.name}</h3>
                  <p>{isArabic ? module.descriptionAr : module.description}</p>
                  <div className="module-card-footer"><span className="planned-mark" />{t.planned}<ArrowUpRight size={15} /></div>
                </article>;
              })}
            </div>
            {filteredModules.length === 0 && <div className="empty-state"><Search size={20} /><span>{t.noResults}</span></div>}
          </section>

          <section className="delivery-panel">
            <div className="delivery-icon"><ShieldCheck size={22} /></div>
            <div className="delivery-copy"><div className="section-kicker">{t.next}</div><h3>{t.nextTitle}</h3><p>{t.nextDesc}</p><strong>{t.sourceNeeded}</strong></div>
            <div className="delivery-decoration" aria-hidden="true"><div /><div /><div /></div>
          </section>

          <footer className="page-footer"><span>© {new Date().getFullYear()} Sama Business</span><span>{t.footer}</span><span className="footer-protected"><ShieldCheck size={13} />{t.protectedDesc}</span></footer>
        </div>
      </section>
    </main>
  );
}
