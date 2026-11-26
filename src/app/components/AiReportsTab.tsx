import { useState, type FormEvent } from "react";
import { Mic, Volume2, Check, X, FileScan, RefreshCw, BarChart3 } from "lucide-react";
import { formatMinorAmount, speakAloud, todayIso, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";

type Props = Readonly<{ ws: SamaWorkspace; actor: TenantContext; onChanged: () => void }>;

type SpeechRecCtor = new () => {
  lang: string; interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null; start(): void;
};

export function AiReportsTab({ ws, actor, onChanged }: Props) {
  const [cmd, setCmd] = useState("بعت شاشة بمبلغ 100.00 دولار تكلفة 70.00");
  const [ocrText, setOcrText] = useState("فاتورة رقم: INV-101\nالتاريخ: 2026-11-25\nالمورد: شركة الشام\nالإجمالي: 45.00 USD");
  const [spoken, setSpoken] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const startVoice = () => {
    const w = globalThis as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setErr("التعرف الصوتي غير مدعوم في هذا المتصفح؛ اكتب الأمر مباشرة."); return; }
    const rec = new Ctor();
    rec.lang = "ar-SY"; rec.interimResults = false;
    rec.onresult = (ev) => { const txt = ev.results[0]?.[0]?.transcript; if (txt) setCmd(txt); };
    rec.onerror = () => setErr("تعذر التقاط الصوت؛ تأكد من إذن الميكروفون.");
    rec.start();
  };

  const runCommand = (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try {
      const res = ws.ai.processVoiceOrTextCommand(actor, { rawText: cmd, businessDate: todayIso(), source: "voice" });
      setSpoken(res.spokenText); speakAloud(res.spokenText, res.language);
      setMsg(res.proposal ? "تم تجهيز المسودة للمراجعة — اضغط موافقة للترحيل." : res.spokenText); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل تحليل الأمر."); }
  };
  const runOcr = () => {
    setMsg(""); setErr("");
    try {
      const res = ws.ai.prepareProposalFromInvoiceOcr(actor, { rawOcrText: ocrText, intent: "cash_expense", fallbackBusinessDate: todayIso() });
      setSpoken(res.spokenText); setMsg("تم استخراج الفاتورة — راجعها واضغط موافقة."); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل استخراج الفاتورة."); }
  };

  const approve = (id: string) => {
    setMsg(""); setErr("");
    try {
      const res = ws.ai.approveAndExecuteProposal(actor, id, true);
      setSpoken(res.spokenConfirmation); speakAloud(res.spokenConfirmation, res.proposal.language);
      setMsg(res.spokenConfirmation); onChanged();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل الاعتماد."); }
  };

  const reject = (id: string) => {
    setMsg(""); setErr("");
    try { ws.ai.rejectProposal(actor, id, "رفض يدوي"); setMsg("تم رفض المسودة دون ترحيل."); onChanged(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل الرفض."); }
  };

  const flushOffline = () => {
    setMsg(""); setErr("");
    const rep = ws.offline.flush(actor);
    setMsg(`المزامنة: ${rep.syncedCount} ناجحة · ${rep.failedCount} فشلت · ${rep.remainingPending} معلّقة.`); onChanged();
  };

  let proposals: ReturnType<SamaWorkspace["ai"]["listProposals"]> = [];
  let pack: ReturnType<SamaWorkspace["reports"]["generateFinancialStatements"]> | null = null;
  try { proposals = ws.ai.listProposals(actor); } catch { /* restricted */ }
  try { pack = ws.reports.generateFinancialStatements(actor); } catch { /* restricted */ }
  const qPending = ws.offline.listQueue(actor).filter((i) => i.status === "pending" || i.status === "failed").length;
  return (
    <div className="sb-stack">
      {err && <div className="sb-alert err">{err}</div>}
      {msg && <div className="sb-alert ok">{msg}</div>}
      <form className="sb-card" onSubmit={runCommand}>
        <div className="sb-card-head"><strong>المساعد الذكي (صوت عربي / إنجليزي)</strong><button type="button" className="sb-btn-secondary" onClick={startVoice}><Mic size={15} /> تحدث</button></div>
        <div className="sb-form-grid"><input className="sb-span2" value={cmd} onChange={(e) => setCmd(e.target.value)} required /></div>
        <div className="sb-form-grid">
          <button type="submit" className="sb-btn-primary">تجهيز المسودة</button>
          <button type="button" className="sb-btn-secondary" onClick={() => spoken && speakAloud(spoken, "ar")}><Volume2 size={15} /> قراءة النتيجة</button>
        </div>
      </form>

      {proposals.length > 0 && (
        <div className="sb-card">
          <div className="sb-card-head"><strong>مسودات بانتظار موافقتك ({proposals.length})</strong></div>
          <div className="sb-list">
            {proposals.slice(0, 6).map((p) => (
              <div key={p.id} className="sb-row">
                <div><strong>{p.memo}</strong><small dir="ltr">{p.amountText} {p.currency} · {p.status}</small></div>
                {p.status === "pending_approval" ? (
                  <div className="sb-inline">
                    <button type="button" className="sb-btn-primary" onClick={() => approve(p.id)}><Check size={13} /></button>
                    <button type="button" className="sb-btn-danger" onClick={() => reject(p.id)}><X size={13} /></button>
                  </div>
                ) : <span className="sb-tag">{p.status === "executed" ? "مُرحّل" : "مرفوض"}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="sb-card">
        <div className="sb-card-head"><FileScan size={17} /><strong>فاتورة OCR + مزامنة الأوفلاين</strong></div>
        <div className="sb-form-grid"><textarea className="sb-span2" rows={3} value={ocrText} onChange={(e) => setOcrText(e.target.value)} /></div>
        <div className="sb-form-grid">
          <button type="button" className="sb-btn-secondary" onClick={runOcr}>تحليل فاتورة OCR</button>
          <button type="button" className="sb-btn-primary" onClick={flushOffline}><RefreshCw size={14} /> مزامنة ({qPending})</button>
        </div>
      </div>

      {pack && (
        <div className="sb-card">
          <div className="sb-card-head"><BarChart3 size={17} /><strong>التقارير المالية (IFRS)</strong><span className="sb-tag">{pack.allTrialBalancesBalanced ? "متوازن ✓" : "مراجعة"}</span></div>
          {pack.currencies.length === 0 ? <p className="sb-muted">رحّل أول عملية لتظهر القوائم المالية.</p> : (
            <div className="sb-list">
              {pack.currencies.map((cur) => {
                const pnl = pack.incomeStatements[cur], bs = pack.balanceSheets[cur];
                return (
                  <div key={cur} className="sb-row">
                    <div>
                      <strong>{cur} · صافي الربح: <span dir="ltr">{formatMinorAmount(pnl.netProfitMinor, cur)}</span></strong>
                      <small dir="ltr">الإيراد: {formatMinorAmount(pnl.netRevenueMinor, cur)} | الأصول: {formatMinorAmount(bs.totalAssetsMinor, cur)} | {bs.isEquationBalanced ? "متوازنة ✓" : "✕"}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
