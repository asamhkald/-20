import { RotateCcw } from "lucide-react";
import { formatMinorAmount, newOperationKey, todayIso, type SamaWorkspace } from "../../services";
import type { TenantContext } from "../../core/tenant";

type Props = Readonly<{ ws: SamaWorkspace; actor: TenantContext; onDone: (ok: string, err?: string) => void }>;

export function JournalList({ ws, actor, onDone }: Props) {
  let snap;
  try { snap = ws.accounting.getSnapshot(actor); } catch { return null; }

  const doReverse = (id: string) => {
    try {
      ws.accounting.reverseEntryOrGroup(actor, id, newOperationKey(), todayIso());
      onDone("تم إنشاء قيد عكسي موثّق دون حذف القيد الأصلي.");
    } catch (e) { onDone("", e instanceof Error ? e.message : "فشل العكس."); }
  };

  return (
    <div className="sb-card">
      <div className="sb-card-head"><strong>سجل القيود المرحّلة</strong><span className="sb-tag">{snap.entries.length}</span></div>
      {snap.entries.length === 0 ? <p className="sb-muted">لا توجد قيود مرحّلة بعد.</p> : (
        <div className="sb-list">
          {[...snap.entries].reverse().slice(0, 15).map((je) => {
            const isRev = Boolean(je.reversalOfId);
            const reversed = snap.reversedIds.has(je.id);
            const l = je.lines[0];
            return (
              <div key={je.id} className={`sb-row${reversed ? " muted" : ""}`}>
                <div>
                  <strong>{je.entryNumber}</strong> · {je.memo}
                  <small dir="ltr">{je.businessDate} · {l ? formatMinorAmount(l.debitMinor || l.creditMinor, l.currency) : ""}</small>
                </div>
                {!isRev && !reversed
                  ? <button type="button" className="sb-btn-danger" onClick={() => doReverse(je.id)}><RotateCcw size={13} /> عكس</button>
                  : <span className="sb-tag">{isRev ? "قيد عكسي" : "معكوس"}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
