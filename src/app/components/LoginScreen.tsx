import { useState, type FormEvent } from "react";
import { Lock, Mail, ShieldCheck, ExternalLink, FlaskConical } from "lucide-react";
import { createSandboxSession, isCloudAuthConfigured, signInCloud, type ActiveUserSession } from "../../services";

type Props = Readonly<{ onAuthenticated: (session: ActiveUserSession) => void }>;

export function LoginScreen({ onAuthenticated }: Props) {
  const cloudReady = isCloudAuthConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); setErr(""); setLoading(true);
    try { onAuthenticated(await signInCloud(email, password)); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : "فشل تسجيل الدخول؛ تحقق من البيانات."); }
    finally { setLoading(false); }
  };
  return (
    <div className="sb-login-wrap" dir="rtl">
      <div className="sb-login-card">
        <div className="sb-login-head">
          <span className="sb-login-logo">S</span>
          <h1>سما للأعمال</h1>
          <p>تسجيل الدخول الآمن والتحقق من الصلاحيات عبر الخادم</p>
        </div>
        {!cloudReady && <div className="sb-alert warn">أضف مفاتيح Supabase في GitHub Secrets لتفعيل الدخول السحابي، أو استخدم الوضع التجريبي المعزول الآن.</div>}
        {err && <div className="sb-alert err">{err}</div>}
        <form className="sb-stack" onSubmit={handleSubmit}>
          <label className="sb-input-row"><Mail size={16} /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="البريد الإلكتروني" dir="ltr" required disabled={!cloudReady || loading} /></label>
          <label className="sb-input-row"><Lock size={16} /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="كلمة المرور" dir="ltr" required disabled={!cloudReady || loading} /></label>
          <button type="submit" className="sb-btn-primary" disabled={!cloudReady || loading}><ShieldCheck size={16} /> {loading ? "جارٍ التحقق..." : "تسجيل الدخول السحابي"}</button>
        </form>
        <div className="sb-login-foot">
          <button type="button" className="sb-btn-secondary" onClick={() => onAuthenticated(createSandboxSession())}><FlaskConical size={15} /> الدخول للوضع التجريبي المعزول</button>
          <a className="sb-legacy-text" href="./app/index.html"><ExternalLink size={14} /> فتح التطبيق السابق (المحفوظ)</a>
        </div>
      </div>
    </div>
  );
}
