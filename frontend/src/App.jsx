import { useEffect, useMemo, useState } from 'react';
import { evaluatePurchase, getBusinessEmailStatus, getCurrentWorkspace, getGmailStatus, getHealth, getMyWorkspaces, getPurchaseById, getSession, getVendors, loginWithGoogle, logout as apiLogout, setSelectedTenantId } from './api/client.js';
import { Button, EmptyState, InlineAlert, LoadingState, Logo, PageHeader, StatusBadge, ThemeControl, formatMoney, go } from './components/ui.jsx';
import VendorImportWizard from './components/VendorImportWizard.jsx';

const STORE = 'mandate.demo.workspace.v1';
const SESSION = 'mandate.demo.session.v1';
const THEME_KEY = 'mandate.theme';

const initialPurchase = {
  productId: 'BRG-6204', quantity: '40', budget: '20000', currency: 'INR',
  maxDeliveryDays: '5', minQualityScore: '70', minReliabilityScore: '70', requireApprovedVendor: true,
};
const initialBusiness = {
  fullName: '', email: '', businessName: '', legalName: '', country: 'India', currency: 'INR',
  industry: '', size: '1–10 employees', website: '', address: '', description: '', phone: '',
  defaultBudget: '', deadline: '5', quality: '70', reliability: '70', approvedOnly: true,
  managerName: '', managerEmail: '', allReview: true, thresholds: false,
};

const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
const saveStore = (data) => { try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* ignore */ } };

/* ================= Landing ================= */
function LandingPage() {
  return (
    <div className="public-page">
      <header className="public-nav wrap">
        <Logo />
        <nav aria-label="Product sections">
          <a href="#product">Product</a>
          <a href="#workflow">Workflow</a>
          <a href="#control">Controls</a>
        </nav>
        <div className="nav-actions">
          <button className="text-button" onClick={() => go('/login')}>Log in</button>
          <Button onClick={() => go('/signup')}>Get started <span aria-hidden="true">→</span></Button>
        </div>
      </header>
      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Procurement, with accountability</div>
            <h1>Smarter purchasing.<br /><em>Your business stays in control.</em></h1>
            <p className="hero-lede">Compare suppliers, apply purchasing rules, and make better buying decisions — with human approval at the center of every payment.</p>
            <div className="hero-actions">
              <Button onClick={() => go('/signup')}>Create your workspace <span aria-hidden="true">→</span></Button>
              <a className="secondary-link" href="#workflow">Explore how it works <span aria-hidden="true">↓</span></a>
            </div>
            <div className="hero-assurance"><span aria-hidden="true">✓</span> AI recommends · Policy validates · Humans decide · Payments locked</div>
          </div>
          <div className="hero-visual" role="img" aria-label="Illustrative preview of a purchase review with supplier comparison">
            <div className="preview-top">
              <div><span className="preview-label">Purchase review · Illustrative preview</span><h3>Industrial bearings</h3><p>Request PR-0248 · Sample data, not live workspace data</p></div>
              <span className="status-pill">Review required</span>
            </div>
            <div className="preview-summary">
              <div><span>Requested quantity</span><strong>40 units</strong></div>
              <div><span>Budget ceiling</span><strong>₹20,000.00</strong></div>
              <div><span>Delivery target</span><strong>Within 5 days</strong></div>
            </div>
            <div className="preview-table">
              <div className="preview-table-head"><span>Supplier</span><span>Est. total</span><span>Delivery</span></div>
              <div className="preview-row recommended"><span><i className="supplier-dot">A</i><b>Northstar Supply<small>Recommendation · not approval</small></b></span><strong>₹17,840</strong><span>3 days</span></div>
              <div className="preview-row"><span><i className="supplier-dot supplier-muted">B</i><b>Meridian Industrial<small>Within budget</small></b></span><strong>₹18,600</strong><span>4 days</span></div>
            </div>
            <div className="preview-footer"><span className="policy-check">✓ Policy checks complete</span><span className="human-review">○ Human approval pending</span></div>
            <div className="preview-note">Illustrative interface · No purchase, approval, or payment has been made</div>
          </div>
        </section>

        <section className="trust-strip"><div className="wrap trust-inner"><span>Built around three principles</span><b>Clear comparisons</b><b>Explicit policy checks</b><b>Human-controlled spend</b></div></section>

        <section id="product" className="section wrap">
          <div className="section-intro">
            <span className="eyebrow">A better way to buy</span>
            <h2>Procurement decisions,<br />without the operational chaos.</h2>
            <p>Bring vendor information, purchasing constraints, and decision records into one considered workflow.</p>
          </div>
          <div className="feature-grid">
            <article><span className="feature-number">01</span><h3>Understand the request</h3><p>Capture the product, quantity, budget, delivery window, and quality requirements in a consistent format.</p><a href="#workflow">Structure every request →</a></article>
            <article><span className="feature-number">02</span><h3>Compare suppliers</h3><p>Evaluate available offers across total cost, delivery, compatibility, quality, and supplier reliability.</p><a href="#workflow">Compare with context →</a></article>
            <article><span className="feature-number">03</span><h3>Apply purchasing rules</h3><p>Validate recommendations against deterministic constraints before a person reviews the decision.</p><a href="#control">Keep policy in control →</a></article>
          </div>
        </section>

        <section id="workflow" className="how-section">
          <div className="wrap">
            <div className="section-intro"><span className="eyebrow">How it works</span><h2>From request to review.<br />Every step stays visible.</h2><p>Three stages. Each has a distinct owner — the requester, the engine, and the reviewer.</p></div>
            <div className="steps-grid steps-grid-3">
              {[['01', 'Define the request', 'Specify the product, quantity, budget, delivery requirements, and constraints. You own this step.'],
                ['02', 'Compare and validate', 'The engine ranks eligible offers and deterministic policy checks validate the result independently.'],
                ['03', 'Review the recommendation', 'An authorized person sees the comparison, the policy outcome, and what remains for human decision. Payment stays locked.']].map((s) => (
                <article key={s[0]}><span>{s[0]}</span><h3>{s[1]}</h3><p>{s[2]}</p></article>
              ))}
            </div>
          </div>
        </section>

        <section id="control" className="control-section wrap">
          <div className="control-copy">
            <span className="eyebrow">Control is a feature</span>
            <h2>Automation should never mean losing control.</h2>
            <p>Mandate separates a recommendation from permission to spend. The current prototype evaluates purchase requests; it does not execute payments.</p>
            <ul>
              <li><span>✓</span> Recommendations are advisory — never approvals.</li>
              <li><span>✓</span> Policy checks are deterministic and independent of rankings.</li>
              <li><span>✓</span> Humans retain approval authority.</li>
              <li><span>✓</span> Payment execution is not enabled in this prototype.</li>
            </ul>
          </div>
          <aside className="control-card">
            <div className="control-card-head"><span className="mini-shield">✓</span><div><b>Decision boundaries</b><small>Designed into the workflow</small></div></div>
            {[['Recommendation', 'Decision engine'], ['Policy validation', 'Deterministic checks'], ['Authorization', 'Human decision']].map((x, i) => (
              <div className="boundary-row" key={x[0]}><span className="boundary-step">0{i + 1}</span><span><b>{x[0]}</b><small>{x[1]}</small></span><span className={i === 2 ? 'boundary-lock' : 'boundary-done'}>{i === 2 ? 'Required' : 'Separate'}</span></div>
            ))}
            <p className="muted-note">Prototype status: payment and approval execution are not enabled.</p>
          </aside>
        </section>

        <section className="cta-section"><div className="wrap cta-inner"><div><span className="eyebrow">A more thoughtful workflow</span><h2>Bring clarity to your<br />purchasing decisions.</h2><p className="muted-note">Start with your business profile and build a workspace around how your team buys.</p></div><Button onClick={() => go('/signup')}>Create your workspace <span aria-hidden="true">→</span></Button></div></section>
      </main>
      <footer className="public-footer wrap">
        <Logo />
        <span>© {new Date().getFullYear()} Mandate · Prototype environment</span>
        <div><a href="#product">Product</a><a href="#workflow">Workflow</a><button onClick={() => go('/login')}>Log in</button><button onClick={() => go('/signup')}>Sign up</button></div>
        <small>Privacy and terms pages are not yet available in this prototype. Sample figures above are illustrative only.</small>
      </footer>
    </div>
  );
}

/* ================= Auth (wired to real Google sign-in; demo form retained for preview only) ================= */
function AuthPage({ mode, onAuth }) {
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '', businessName: '', terms: false });
  const [error, setError] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('error');
      if (code === 'cancelled') return 'Google sign-in was cancelled. Try again when ready.';
      if (code === 'auth_failed') return 'Google sign-in failed. Check configuration and try again.';
      return '';
    } catch { return ''; }
  });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';
  const set = (key, value) => setForm((s) => ({ ...s, [key]: value }));
  function submit(e) {
    e.preventDefault(); setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError('Enter a valid work email address.');
    if (form.password.length < 8) return setError('Use a password with at least 8 characters.');
    if (signup && form.password !== form.confirm) return setError('Your passwords do not match.');
    if (signup && !form.businessName.trim()) return setError('Enter your business name to continue.');
    if (signup && !form.terms) return setError('Please acknowledge the prototype terms notice.');
    setBusy(true);
    window.setTimeout(() => {
      onAuth({ fullName: form.fullName.trim() || form.email.split('@')[0], email: form.email.trim(), businessName: form.businessName.trim() });
      setBusy(false);
    }, 250);
  }
  return (
    <div className="auth-page">
      <header className="auth-top"><Logo /><button className="text-button" onClick={() => go('/')}>← Back to Mandate</button></header>
      <main className="auth-layout">
        <aside className="auth-aside">
          <span className="eyebrow">Purchasing, made clearer</span>
          <h1>Good decisions start with a better process.</h1>
          <p>Keep supplier comparisons, purchasing rules, and human review connected in one workspace.</p>
          <div className="auth-quote"><p>“AI can help you see the options. Your team decides what happens next.”</p></div>
          <div className="auth-aside-foot">A prototype built around responsible purchasing.</div>
        </aside>
        <section className="auth-card" aria-label={signup ? 'Create workspace' : 'Sign in'}>
          <span className="eyebrow">{signup ? 'Get started' : 'Welcome back'}</span>
          <h2>{signup ? 'Create your workspace' : 'Sign in to Mandate'}</h2>
          <p>{signup ? 'Set up your business workspace. You can add procurement settings and vendors next.' : 'Continue to your procurement workspace.'}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            <Button onClick={loginWithGoogle}>Continue with Google <span aria-hidden="true">→</span></Button>
            <small className="muted-note">Secure sign-in via Google. Business data stays isolated per workspace; sign-in alone never grants mailbox access.</small>
          </div>
          <div className="demo-notice" role="note"><span aria-hidden="true">ⓘ</span><span><b>Secure session required for business data</b><small>Google sign-in creates a server-validated session. The demo form below is preview-only and does not grant API access — protected calls return 401 when signed out.</small></span></div>
          <form onSubmit={submit} noValidate>
            {signup ? <label>Full name<input autoComplete="name" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="e.g. Alex Morgan" /></label> : null}
            <label>Work email<input type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} required placeholder="you@company.com" /></label>
            {signup ? <label>Business name<input value={form.businessName} onChange={(e) => set('businessName', e.target.value)} required placeholder="Your company" /></label> : null}
            <label>Password
              <div className="password-wrap">
                <input type={showPassword ? 'text' : 'password'} autoComplete={signup ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => set('password', e.target.value)} minLength={8} required placeholder="At least 8 characters" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword}>{showPassword ? 'Hide' : 'Show'}</button>
              </div>
            </label>
            {signup ? <label>Confirm password<input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} required placeholder="Enter password again" /></label> : null}
            {signup ? <label className="terms-check"><input type="checkbox" checked={form.terms} onChange={(e) => set('terms', e.target.checked)} /><span>I understand this is a demo and no secure account is being created.</span></label> : null}
            {!signup ? <div className="auth-inline"><span>Use a demo identity to continue</span><button type="button" onClick={() => go('/forgot-password')}>Forgot password?</button></div> : null}
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <Button type="submit" disabled={busy}>{busy ? 'Opening workspace…' : signup ? 'Continue to setup' : 'Continue to workspace'} <span aria-hidden="true">→</span></Button>
          </form>
          <div className="auth-switch">{signup ? 'Already have a workspace?' : 'New to Mandate?'} <button onClick={() => go(signup ? '/login' : '/signup')}>{signup ? 'Log in' : 'Create an account'}</button></div>
          <small className="auth-legal">Prototype only — passwords are not stored or sent to a server.</small>
        </section>
      </main>
    </div>
  );
}

function ForgotPassword() {
  return (
    <div className="auth-page">
      <header className="auth-top"><Logo /><button className="text-button" onClick={() => go('/login')}>← Back to login</button></header>
      <section className="simple-message">
        <span className="eyebrow">Account access</span>
        <h2>Password reset isn’t connected yet.</h2>
        <p>This prototype has no authentication server or email delivery. Return to login to continue using demo access. Do not expect a reset email — none will be sent.</p>
        <Button onClick={() => go('/login')}>Return to login</Button>
      </section>
    </div>
  );
}

/* ================= Onboarding ================= */
function Onboarding({ user, onComplete }) {
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState(() => ({
    ...initialBusiness, ...(readStore() || {}),
    fullName: user.fullName || '', email: user.email || '',
    businessName: user.businessName || readStore()?.businessName || '',
    legalName: user.businessName || readStore()?.legalName || '',
  }));
  const [importState, setImportState] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [done, setDone] = useState(false);
  const [stepError, setStepError] = useState('');
  const set = (key, value) => setBusiness((s) => ({ ...s, [key]: value }));
  const steps = ['Business profile', 'Procurement defaults', 'Review preferences', 'Import suppliers', 'Review & finish'];
  const stepHelp = [
    'Tell us a little about the organization using Mandate.',
    'Choose default constraints to prefill future purchase requests. These are conveniences — not server-enforced policy.',
    'Record how your business expects reviews to work. Preferences are not permissions.',
    'Parse your existing supplier sheet and map its columns. You can skip this and import later.',
    'Review what is saved where before opening the dashboard.',
  ];
  function next() {
    setStepError('');
    const required = step === 0 ? ['businessName', 'legalName', 'email', 'country', 'currency', 'industry', 'size'] : step === 1 ? ['deadline', 'quality', 'reliability'] : [];
    const invalid = required.find((k) => !String(business[k] ?? '').trim());
    if (invalid) {
      setStepError('Complete the highlighted required field to continue.');
      document.getElementById(`field-${invalid}`)?.focus();
      return;
    }
    setStep((s) => Math.min(4, s + 1));
  }
  function finish() {
    const profile = {
      ...business,
      vendorImport: importState?.fileName ? {
        fileName: importState.fileName, sheetName: importState.sheetName, rowsRead: importState.rowsRead,
        mode: importResult ? 'backend-import' : 'local-preview',
        importedCount: importResult?.received ?? importResult?.inserted ?? null,
        importedAt: importResult ? new Date().toISOString() : null,
      } : (business.vendorImport || null),
      onboardingComplete: true, completedAt: new Date().toISOString(),
    };
    saveStore(profile); setDone(true); onComplete(profile);
  }
  return (
    <div className="onboarding-page">
      <header className="onboarding-top"><Logo /><div style={{ display: 'flex', gap: 16, alignItems: 'center' }}><span className="demo-chip">Demo workspace</span><button className="text-button" onClick={() => go('/app/dashboard')}>Exit setup</button></div></header>
      <main className="onboarding-main">
        <div className="onboarding-heading"><span className="eyebrow">Workspace setup</span><h1>Let’s set up your business.</h1><p>Configure the basics now. You can refine these preferences later.</p></div>
        <div className="wizard">
          <aside className="wizard-steps" aria-label="Setup steps">
            <span className="wizard-caption">Your setup</span>
            {steps.map((s, i) => (
              <button key={s} className={i === step ? 'wizard-step active' : i < step ? 'wizard-step complete' : 'wizard-step'} onClick={() => i < step && setStep(i)} aria-current={i === step ? 'step' : undefined}>
                <span>{i < step ? '✓' : String(i + 1).padStart(2, '0')}</span><b>{s}</b>
              </button>
            ))}
            <div className="wizard-aside-note"><b>Good to know</b><p>Business details below are saved in this browser for demo use. Vendor offers are saved to the server only when the import API reports success.</p></div>
          </aside>
          <section className="wizard-panel">
            <div className="wizard-panel-head"><span className="eyebrow">Step {String(step + 1).padStart(2, '0')} of 05</span><h2>{steps[step]}</h2><p>{stepHelp[step]}</p></div>
            {stepError ? <div className="form-error" role="alert" style={{ marginBottom: 14 }}>{stepError}</div> : null}
            {step === 0 ? (
              <div className="wizard-fields">
                <label>Business display name *<input id="field-businessName" value={business.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="e.g. Acme Manufacturing" /></label>
                <label>Legal business name *<input id="field-legalName" value={business.legalName} onChange={(e) => set('legalName', e.target.value)} placeholder="Registered business name" /></label>
                <div className="field-pair">
                  <label>Business email *<input id="field-email" type="email" value={business.email} onChange={(e) => set('email', e.target.value)} placeholder="purchasing@company.com" /></label>
                  <label>Country *<select id="field-country" value={business.country} onChange={(e) => set('country', e.target.value)}>{['India', 'United States', 'United Kingdom', 'Singapore', 'Australia', 'Germany', 'Canada', 'Other'].map((v) => <option key={v}>{v}</option>)}</select></label>
                </div>
                <div className="field-pair">
                  <label>Primary currency *<select id="field-currency" value={business.currency} onChange={(e) => set('currency', e.target.value)}>{['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'JPY'].map((v) => <option key={v}>{v}</option>)}</select></label>
                  <label>Industry *<select id="field-industry" value={business.industry} onChange={(e) => set('industry', e.target.value)}><option value="">Select industry</option>{['Manufacturing', 'Retail & wholesale', 'Construction', 'Healthcare', 'Technology', 'Professional services', 'Hospitality', 'Logistics', 'Other'].map((v) => <option key={v}>{v}</option>)}</select></label>
                </div>
                <label>Business size *<select id="field-size" value={business.size} onChange={(e) => set('size', e.target.value)}>{['1–10 employees', '11–50 employees', '51–200 employees', '201–1,000 employees', '1,000+ employees'].map((v) => <option key={v}>{v}</option>)}</select></label>
                <div className="field-pair">
                  <label>Website <small className="field-hint">Optional</small><input value={business.website} onChange={(e) => set('website', e.target.value)} placeholder="https://company.com" /></label>
                  <label>Contact phone <small className="field-hint">Optional</small><input value={business.phone} onChange={(e) => set('phone', e.target.value)} placeholder="Optional" /></label>
                </div>
                <label>Business address <small className="field-hint">Optional</small><input value={business.address} onChange={(e) => set('address', e.target.value)} placeholder="Optional" /></label>
                <label>Business description <small className="field-hint">Optional</small><textarea value={business.description} onChange={(e) => set('description', e.target.value)} rows={3} placeholder="What does your business do? (optional)" /></label>
              </div>
            ) : null}
            {step === 1 ? (
              <div className="wizard-fields">
                <div className="field-pair">
                  <label>Default currency<select value={business.currency} onChange={(e) => set('currency', e.target.value)}>{['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'JPY'].map((v) => <option key={v}>{v}</option>)}</select></label>
                  <label>Default budget ({business.currency}) <small className="field-hint">Prefills the purchase form; not enforced server-side</small><input type="number" min="0" step="0.01" value={business.defaultBudget} onChange={(e) => set('defaultBudget', e.target.value)} placeholder="No default budget" /></label>
                </div>
                <div className="field-pair">
                  <label>Delivery deadline (days) *<input id="field-deadline" type="number" min="0" max="365" value={business.deadline} onChange={(e) => set('deadline', e.target.value)} /></label>
                  <label>Minimum quality (0–100) *<input id="field-quality" type="number" min="0" max="100" value={business.quality} onChange={(e) => set('quality', e.target.value)} /></label>
                </div>
                <label>Minimum supplier reliability (0–100) *<input id="field-reliability" type="number" min="0" max="100" value={business.reliability} onChange={(e) => set('reliability', e.target.value)} /></label>
                <label className="setting-toggle"><span><b>Require approved vendors</b><small>Prefill purchase requests to restrict offers to approved suppliers.</small></span><input type="checkbox" checked={business.approvedOnly} onChange={(e) => set('approvedOnly', e.target.checked)} /></label>
                <div className="notice-box">These are workspace defaults only. The backend evaluates the values sent with each purchase request; this setup does not save or enforce a server-side policy.</div>
              </div>
            ) : null}
            {step === 2 ? (
              <div className="wizard-fields">
                <label>Approval contact name <small className="field-hint">Optional — recorded locally</small><input value={business.managerName} onChange={(e) => set('managerName', e.target.value)} placeholder="Manager or purchasing approver" /></label>
                <label>Approval contact work email <small className="field-hint">Optional — no email will be sent</small><input type="email" value={business.managerEmail} onChange={(e) => set('managerEmail', e.target.value)} placeholder="manager@company.com" /></label>
                <label className="setting-toggle"><span><b>All purchases should be reviewed</b><small>Record your preference for human review before purchasing.</small></span><input type="checkbox" checked={business.allReview} onChange={(e) => set('allReview', e.target.checked)} /></label>
                <label className="setting-toggle"><span><b>Budget-based approval thresholds</b><small>You intend to define thresholds in a future approval workflow.</small></span><input type="checkbox" checked={business.thresholds} onChange={(e) => set('thresholds', e.target.checked)} /></label>
                <div className="notice-box">Approval preferences are recorded for this demo only. Approval endpoints return 501 and no approval emails are sent. A preference is not a permission.</div>
              </div>
            ) : null}
            <div style={{ display: step === 3 ? 'block' : 'none' }}>
              <VendorImportWizard
                onImported={(result, offers, meta) => {
                  setImportResult(result);
                  if (meta?.fileName) setImportState((s) => ({ ...(s || {}), fileName: meta.fileName, sheetName: meta.sheetName, rowsRead: meta.rowsRead }));
                }}
                onStateChange={(patch) => {
                  if (patch?.fileName) {
                    setImportState((s) => ({ ...(s || {}), fileName: patch.fileName, sheetName: patch.sheetName || s?.sheetName, rowsRead: patch.rowsRead ?? s?.rowsRead }));
                  }
                }}
              />
              <div className="notice-box" style={{ marginTop: 14 }}>You can skip this step and import later from <b>Import suppliers</b>. The same workflow is reused here and on the standalone page — there is only one implementation.</div>
              <div style={{ marginTop: 12 }}><Button variant="secondary" onClick={() => setStep(4)}>Skip for now →</Button></div>
            </div>
            {step === 4 ? (
              <div className="review-list">
                <div className="review-item"><span>Business profile</span><div><b>{business.businessName || 'Not provided'}</b><small>{business.industry || 'Industry not selected'} · {business.country} · {business.currency}</small><small>→ Saved in this browser (localStorage).</small></div><button onClick={() => setStep(0)}>Edit</button></div>
                <div className="review-item"><span>Procurement defaults</span><div><b>{business.currency} {business.defaultBudget || 'No budget set'}</b><small>Delivery ≤ {business.deadline} days · Quality {business.quality}/100 · Reliability {business.reliability}/100</small><small>→ Workspace preference only; not server-enforced policy.</small></div><button onClick={() => setStep(1)}>Edit</button></div>
                <div className="review-item"><span>Review preferences</span><div><b>{business.allReview ? 'Human review preferred' : 'Review preference not required'}</b><small>{business.managerName || 'No approver added'} · Demo preference only.</small><small>→ Not persisted to any approval service.</small></div><button onClick={() => setStep(2)}>Edit</button></div>
                <div className="review-item"><span>Vendor spreadsheet</span><div><b>{importState?.fileName || 'Skipped for now'}</b><small>{importResult ? `${importResult.received ?? importResult.inserted ?? ''} offers persisted by the server (backend confirmation).` : importState?.fileName ? 'Previewed but not imported yet.' : 'You can import suppliers later.'}</small><small>→ {importResult ? 'Persisted by the server.' : importState?.fileName ? 'Preview only — not yet in the catalog.' : 'Not configured.'}</small></div><button onClick={() => setStep(3)}>Edit</button></div>
                <div className="notice-box">Business profile and preferences are saved in this browser. Vendor offers are persisted only when the import API reports success. Policy preferences and approvals are not server-side workflows.</div>
              </div>
            ) : null}
            <div className="wizard-actions">
              {step > 0 ? <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>← Back</Button> : <span />}
              {step < 4 ? <Button onClick={next}>Continue <span aria-hidden="true">→</span></Button> : <Button onClick={finish} disabled={done}>{done ? 'Workspace ready' : 'Finish workspace setup'} <span aria-hidden="true">→</span></Button>}
            </div>
          </section>
        </div>
        <p className="wizard-footnote">Your progress stays in this tab until you finish setup. Demo profile data is saved locally in this browser.</p>
      </main>
    </div>
  );
}

/* ================= Purchase desk ================= */
function PurchaseDesk({ defaults }) {
  const [form, setForm] = useState(() => ({
    ...initialPurchase,
    budget: defaults?.defaultBudget || initialPurchase.budget,
    currency: defaults?.currency || initialPurchase.currency,
    maxDeliveryDays: defaults?.deadline || initialPurchase.maxDeliveryDays,
    minQualityScore: defaults?.quality || initialPurchase.minQualityScore,
    minReliabilityScore: defaults?.reliability || initialPurchase.minReliabilityScore,
    requireApprovedVendor: defaults?.approvedOnly ?? initialPurchase.requireApprovedVendor,
  }));
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(null);
  const [filter, setFilter] = useState('all');
  useEffect(() => { getHealth().then(() => setOnline(true)).catch(() => setOnline(false)); }, []);
  const set = (key, value) => setForm((s) => ({ ...s, [key]: value }));

  function classifyError(message) {
    const m = String(message || '').toLowerCase();
    if (m.includes('could not reach') || m.includes('failed to fetch') || m.includes('network')) return 'api-unreachable';
    if (m.includes('invalid') || m.includes('validation')) return 'request-validation';
    if (m.includes('http 500') || m.includes('unexpected server')) return 'server-error';
    return 'unknown';
  }

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(''); setErrorKind(''); setResult(null);
    const qty = Number(form.quantity);
    const budgetNum = Number(form.budget);
    if (!form.productId.trim()) { setError('Enter a product / SKU before evaluating.'); setErrorKind('request-validation'); setBusy(false); return; }
    if (!Number.isInteger(qty) || qty <= 0) { setError('Quantity must be a whole number greater than zero.'); setErrorKind('request-validation'); setBusy(false); return; }
    if (!Number.isFinite(budgetNum) || budgetNum <= 0) { setError('Maximum budget must be a number greater than zero.'); setErrorKind('request-validation'); setBusy(false); return; }
    try {
      const data = await evaluatePurchase({
        productId: form.productId.trim(), quantity: qty, maxTotalMinor: Math.round(budgetNum * 100),
        currency: form.currency, maxDeliveryDays: Number(form.maxDeliveryDays),
        minQualityScore: Number(form.minQualityScore), minReliabilityScore: Number(form.minReliabilityScore),
        requireApprovedVendor: form.requireApprovedVendor,
      });
      setResult(data); setOnline(true);
    } catch (err) {
      const msg = err.message || 'Could not evaluate purchase.';
      setError(msg); setErrorKind(classifyError(msg)); setOnline(false);
    } finally { setBusy(false); }
  }

  const status = result?.decision?.status;
  const policyPassed = result?.policy?.passed;
  const isRecommended = status === 'RECOMMENDED' && policyPassed;
  const ranking = result?.ranking || [];
  const rejected = result?.rejectedOffers || [];
  const visibleRanking = filter === 'eligible' ? ranking : filter === 'rejected' ? [] : ranking;
  const visibleRejected = filter === 'all' || filter === 'rejected' ? rejected : [];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Controlled procurement"
        title="Purchase desk"
        description="Turn a buying request into a policy-checked recommendation. AI recommends, policy validates, and your team decides — payment stays locked."
        actions={<span className={online ? 'api-status online' : online === false ? 'api-status' : 'api-status'}><i aria-hidden="true" />{online ? 'API connected' : online === false ? 'API disconnected' : 'Checking API…'}</span>}
      />
      <div className="metric-row">
        <article><span>Decision engine</span><b>Operational</b><small>Deterministic evaluation</small></article>
        <article><span>Policy guardrails</span><b className="green-text">Checked independently</b><small>Request-specific constraints</small></article>
        <article><span>Payment execution</span><b className="amber-text">Locked</b><small>No approval or payment workflow</small></article>
      </div>
      <div className="purchase-columns">
        <section className="surface" aria-label="Purchase request">
          <div className="surface-head"><div><span className="step-kicker">Step 01 · Request</span><h2>Define purchase request</h2><p>Set your constraints before comparing offers.</p></div></div>
          <form onSubmit={submit} className="purchase-form" noValidate>
            <div><span className="field-label">Product and quantity</span></div>
            <label>Product / SKU<input value={form.productId} onChange={(e) => set('productId', e.target.value)} required placeholder="e.g. BRG-6204" /></label>
            <div className="field-pair">
              <label>Quantity (units)<input type="number" min="1" step="1" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} required /></label>
              <label>Maximum budget ({form.currency}) — total incl. charges<input type="number" min="0.01" step="0.01" value={form.budget} onChange={(e) => set('budget', e.target.value)} required /></label>
            </div>
            <div><span className="field-label">Budget and delivery</span></div>
            <div className="field-pair">
              <label>Delivery within (days)<input type="number" min="0" max="365" value={form.maxDeliveryDays} onChange={(e) => set('maxDeliveryDays', e.target.value)} required /></label>
              <label>Currency<select value={form.currency} onChange={(e) => set('currency', e.target.value)}>{['INR', 'USD', 'EUR', 'GBP'].map((c) => <option key={c}>{c}</option>)}</select></label>
            </div>
            <div className="form-divider">Quality &amp; compliance</div>
            <div className="field-pair">
              <label>Minimum quality (0–100)<input type="number" min="0" max="100" value={form.minQualityScore} onChange={(e) => set('minQualityScore', e.target.value)} required /></label>
              <label>Minimum reliability (0–100)<input type="number" min="0" max="100" value={form.minReliabilityScore} onChange={(e) => set('minReliabilityScore', e.target.value)} required /></label>
            </div>
            <label className="check-setting"><input type="checkbox" checked={form.requireApprovedVendor} onChange={(e) => set('requireApprovedVendor', e.target.checked)} /><span><b>Approved vendors only</b><small>Exclude suppliers not approved by your team.</small></span></label>
            {error ? (
              <div className="form-error" role="alert">
                <b>{errorKind === 'api-unreachable' ? 'API unreachable — not a policy rejection.' : errorKind === 'request-validation' ? 'Request needs attention.' : errorKind === 'server-error' ? 'Server evaluation error.' : 'Could not evaluate.'}</b>
                <div>{error}</div>
                <div className="muted-note" style={{ marginTop: 6 }}>{errorKind === 'api-unreachable' ? 'Check that the backend is running, then retry. Your form entries are preserved.' : 'Correct the highlighted values and retry. Valid entries are preserved.'}</div>
              </div>
            ) : null}
            <Button type="submit" disabled={busy}>{busy ? 'Evaluating vendors…' : 'Evaluate purchase'} <span aria-hidden="true">→</span></Button>
            <p className="form-footnote">Evaluation only. This does not authorize or execute payment.</p>
          </form>
        </section>

        <section className="surface" aria-label="Decision summary" aria-live="polite">
          <div className="surface-head"><div><span className="step-kicker">Step 02 · Decision</span><h2>Decision summary</h2><p>Recommendation, policy outcome, and human next step — kept separate.</p></div></div>
          {!result ? (
            <div className="purchase-empty">
              <div className="empty-illustration" aria-hidden="true">≋</div>
              <h3>Ready when you are</h3>
              <p>Submit a purchase request to compare offers against budget, delivery, quality and vendor rules.</p>
              <ul><li>Cost and delivery ranking</li><li>Independent policy check</li><li>Traceable decision record</li></ul>
            </div>
          ) : (
            <div className="purchase-result">
              <div className={isRecommended ? 'decision-banner good' : 'decision-banner warn'}>
                <b>{isRecommended ? 'Recommendation is policy-compliant' : status === 'NO_ELIGIBLE_OFFER' ? 'No eligible offer found' : status === 'POLICY_REJECTED' ? 'Policy rejected the recommendation' : 'Recommendation needs human review'}</b>
                <p>{result.explanation}</p>
              </div>

              <div className="recommended-offer">
                <span className="step-kicker">Recommendation · not approval</span>
                {result.recommendation ? (
                  <>
                    <h3>{result.recommendation.vendorId}</h3>
                    <p>Offer <code>{result.recommendation.offerId}</code> · Score {result.recommendation.score} · {(result.recommendation.rationale || []).join(' ')}</p>
                    <div><span>Estimated total (incl. shipping, tax, fees)</span><b>{formatMoney(result.recommendation.totalMinor, result.recommendation.currency || form.currency)}</b></div>
                  </>
                ) : (
                  <>
                    <h3>No recommendation</h3>
                    <p>No offer satisfied every hard constraint. See rejected offers below for reasons from the engine — not guesses.</p>
                  </>
                )}
              </div>

              <div className="status-list">
                <div><span><b>Policy validation — deterministic</b><small>{policyPassed ? 'Configured guardrails passed for the recommended offer' : 'One or more checks did not pass; see findings'}</small></span><strong className={policyPassed ? 'pill-good' : 'pill-bad'}>{policyPassed ? 'PASSED' : 'BLOCKED'}</strong></div>
                <div><span><b>Human decision — required</b><small>{result.authorization?.requiresHumanApproval ? 'An authorized person must review before anything else happens' : 'No approval action available in this prototype'}</small></span><strong className="pill-wait">REVIEW REQUIRED</strong></div>
                <div><span><b>Payment execution — locked</b><small>Not enabled in this prototype; never a “Pay now” action</small></span><strong className="pill-wait">LOCKED</strong></div>
              </div>

              {result.policy?.violations?.length ? (
                <div className="result-findings"><b>Policy findings (from server)</b>{result.policy.violations.map((v, i) => <p key={v.code || i}><code>{v.code}</code> — {v.message}</p>)}</div>
              ) : null}
              {result.uncertainties?.length ? (
                <div className="result-findings"><b>Things to verify</b>{result.uncertainties.map((v, i) => <p key={i}>{v.message || String(v)}</p>)}</div>
              ) : null}
              <div className="purchase-id"><span>Purchase ID</span><code>{result.purchaseId}</code><button type="button" onClick={() => navigator.clipboard?.writeText(result.purchaseId)}>Copy</button><button type="button" className="text-button" onClick={() => go('/app/purchases')}>Open in history →</button></div>

              <h3 className="comparison-title">Offer comparison</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }} role="group" aria-label="Filter offers">
                {[['all', 'All'], ['eligible', 'Eligible'], ['rejected', 'Rejected']].map(([k, label]) => (
                  <button key={k} type="button" className={filter === k ? 'button button-secondary' : 'button button-quiet'} style={filter === k ? { borderColor: 'var(--primary)' } : undefined} onClick={() => setFilter(k)} aria-pressed={filter === k}>{label} {k === 'eligible' ? `(${ranking.length})` : k === 'rejected' ? `(${rejected.length})` : ''}</button>
                ))}
              </div>
              {visibleRanking.length ? (
                <div className="offer-table-wrap">
                  <table className="data-table">
                    <thead><tr><th>#</th><th>Supplier / offer</th><th>Total</th><th>Delivery</th><th>Quality · Reliability</th></tr></thead>
                    <tbody>
                      {visibleRanking.map((row) => (
                        <tr key={row.offerId} style={result.recommendation?.offerId === row.offerId ? { background: 'var(--primary-soft)' } : undefined}>
                          <td className="num">{row.rank}{row.tied ? ' = ' : ''}</td>
                          <td><b>{row.vendorId}</b> {result.recommendation?.offerId === row.offerId ? <StatusBadge tone="info">Recommended</StatusBadge> : null}<small className="cell-sub"><code>{row.offerId}</code></small></td>
                          <td className="num">{formatMoney(row.cost?.totalMinor, row.cost?.currency || form.currency)}<small className="cell-sub">unit {formatMoney(row.cost?.unitPriceMinor, row.cost?.currency || form.currency)}</small></td>
                          <td className="num">{row.criteria?.deliveryDays ?? '—'}d</td>
                          <td className="num">{row.criteria?.qualityScore ?? '—'} · {row.criteria?.reliabilityScore ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="muted-note">No eligible offers for this filter.</p>}
              {visibleRejected.length ? (
                <div className="offer-table-wrap" style={{ marginTop: 12 }}>
                  <table className="data-table">
                    <thead><tr><th>Rejected offer</th><th>Reason (from engine)</th></tr></thead>
                    <tbody>
                      {visibleRejected.map((r, i) => (
                        <tr key={`${r.offerId}-${i}`}><td><code>{r.offerId}</code><small className="cell-sub">{r.vendorId}</small></td><td>{(r.reasons || []).map((x, j) => <div key={j}><code>{x.code}</code> — {x.message}</div>)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          )}
          <div className="safety-note"><b>AI recommends. Your team authorizes.</b><p>Payment execution remains disabled in this prototype. Approval actions are not connected.</p></div>
        </section>
      </div>
      <div className="two-panel">
        <section className="surface"><h3>Policy guardrails</h3><p>Hard constraints checked independently of ranking.</p><div className="guardrail-list">{['Budget ceiling', 'SKU compatibility', 'Inventory quantity', 'Approved supplier', 'Delivery deadline', 'Quality & reliability'].map((x) => <span key={x}>✓ &nbsp; {x}</span>)}</div></section>
        <section className="surface"><h3>Audit trail</h3><p>{result ? `${result.auditEvents?.length || 0} events recorded for this evaluation.` : 'Each evaluation creates traceable decision events.'}</p>{result?.auditEvents?.length ? result.auditEvents.map((ev, i) => <div className="audit-event" key={ev.eventId || ev.requestId || i}><i aria-hidden="true" /><span><b>{String(ev.eventType || 'Event').replaceAll('_', ' ')}</b><small>{ev.timestamp ? new Date(ev.timestamp).toLocaleString() : 'Recorded'}</small></span></div>) : <div className="audit-flow">Evaluation requested <span aria-hidden="true">→</span> Offers compared <span aria-hidden="true">→</span> Policy validated</div>}</section>
      </div>
      <p className="page-footnote">Decision records are held in memory and reset when the server restarts. No payment is executed.</p>
    </div>
  );
}

/* ============ Workspace security status (read-only display, no redesign) ============ */
function WorkspaceSecurityStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [current, gmail] = await Promise.all([
          getCurrentWorkspace().catch(() => null),
          getGmailStatus().catch(() => null),
        ]);
        if (!alive) return;
        setStatus({ current, gmail });
      } catch { /* display-only; backend remains authoritative */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!status?.current) return null;
  const tenant = status.current.tenant;
  const verified = tenant?.businessEmailVerifiedAt ? `verified ${new Date(tenant.businessEmailVerifiedAt).toLocaleDateString()}` : 'not verified';
  const gmailLabel = !status.gmail ? '' : status.gmail.enabled === false ? 'Gmail connection: not configured' : status.gmail.connected ? `Gmail: connected (${status.gmail.mailboxEmail || 'mailbox'})` : 'Gmail: disconnected';
  return (
    <p className="muted-note" aria-live="polite">
      Workspace: {tenant?.businessName || 'current'} · Business email {tenant?.businessEmail || 'not set'} ({verified})
      {gmailLabel ? ` · ${gmailLabel}` : ''} · Role: {status.current.membership?.role || 'member'}
    </p>
  );
}

/* ================= Dashboard ================= */
function Dashboard({ profile, onStartPurchase, permissions }) {
  const canImport = !permissions || permissions.includes('vendors:import');
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    getVendors().then((data) => { if (alive) { setCatalog(data); setLoading(false); } })
      .catch((e) => { if (alive) { setCatalogError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);
  const count = Array.isArray(catalog) ? catalog.length : null;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Workspace overview"
        title={`Welcome${profile?.fullName ? `, ${profile.fullName.split(' ')[0]}` : ''}.`}
        description={`The starting point for procurement at ${profile?.businessName || 'your business'}. Every figure below comes from a real source — nothing is invented.`}
        actions={<Button onClick={onStartPurchase}>New purchase request <span aria-hidden="true">→</span></Button>}
      />
      <div className="dashboard-callout">
        <div><span className="eyebrow">Your first step</span><h2>Turn your next purchase into a considered decision.</h2><p>Define a request, compare available offers, and inspect the policy outcome before your team makes a decision.</p><Button onClick={onStartPurchase}>Open purchase desk <span aria-hidden="true">→</span></Button></div>
        <div className="callout-index" aria-hidden="true">01 <span>/ 03</span></div>
      </div>
      <div className="dashboard-grid">
        <section className="surface"><span className="step-kicker">Workspace setup</span><h3>Business profile</h3><p>{profile?.industry || 'Industry not set'} · {profile?.country || 'Country not set'} · {profile?.currency || 'Currency not set'}</p><div className="setup-progress" role="img" aria-label={profile?.onboardingComplete ? 'Profile setup complete' : 'Profile started'}><span style={{ width: profile?.onboardingComplete ? '100%' : '35%' }} /></div><small>{profile?.onboardingComplete ? 'Profile setup complete (saved in this browser)' : 'Profile started'}</small><div style={{ marginTop: 10 }}><button className="inline-link" onClick={() => go('/app/settings/business')}>View business settings →</button></div></section>
        <section className="surface">
          <span className="step-kicker">Supplier catalog · live from API</span>
          <h3>{loading ? 'Reading catalog…' : count > 0 ? `${count} offers in catalog` : 'Bring in your suppliers'}</h3>
          {loading ? <LoadingState rows={2} label="Reading supplier catalog…" /> : catalogError ? <InlineAlert tone="error" title="Catalog unavailable">{catalogError} <div style={{ marginTop: 8 }}><Button variant="secondary" onClick={() => window.location.reload()}>Retry</Button></div></InlineAlert> : <p>{count > 0 ? `Source: GET /api/vendors · ${count} active offers available to the decision engine.` : 'No offers returned by GET /api/vendors. Import a spreadsheet to populate the catalog.'}</p>}
          <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}><button className="inline-link" onClick={() => go('/app/vendors')}>Open catalog →</button><button className="inline-link" onClick={() => go('/app/vendors/import')}>Import suppliers →</button></div>
          {profile?.vendorImport ? <small>Last import: {profile.vendorImport.fileName} ({profile.vendorImport.mode === 'backend-import' ? 'confirmed by server' : 'preview only'}).</small> : null}
        </section>
        <section className="surface"><span className="step-kicker">Purchasing policies</span><h3>Defaults at a glance</h3><div className="compact-facts"><span>Default delivery<b>{profile?.deadline || '5'} days</b></span><span>Minimum quality<b>{profile?.quality || '70'}/100</b></span><span>Approved vendors<b>{profile?.approvedOnly ? 'Required' : 'Optional'}</b></span></div><small>Workspace preferences — request constraints are evaluated per purchase, not stored as server policy.</small><div style={{ marginTop: 10 }}><button className="inline-link" onClick={() => go('/app/policies')}>Review policy defaults →</button></div></section>
      </div>
      <div className="honest-banner" role="note"><span aria-hidden="true">ⓘ</span><p><b>Prototype data, clearly labeled.</b> Catalog counts come from the live API. Purchases and audit events are stored in memory and reset on restart. Approvals and payments are not implemented.</p></div>
      <WorkspaceSecurityStatus />
      {!canImport ? <p className="muted-note">Vendor import is disabled for your role. Contact a workspace owner for access — this button is hidden by permission, enforced by the server.</p> : null}
    </div>
  );
}

/* ================= Catalog ================= */
function CatalogPage() {
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyApproved, setOnlyApproved] = useState(false);
  const load = () => {
    setLoading(true); setError('');
    getVendors().then((data) => { setOffers(data); setLoading(false); }).catch((e) => { setError(e.message); setLoading(false); });
  };
  useEffect(load, []);
  const filtered = useMemo(() => {
    if (!Array.isArray(offers)) return [];
    const q = query.trim().toLowerCase();
    return offers.filter((o) => {
      if (onlyApproved && !o.vendorApproved) return false;
      if (!q) return true;
      return [o.vendorName, o.vendorId, o.productId, o.offerId].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [offers, query, onlyApproved]);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Supplier catalog"
        title="Supplier catalog"
        description="The offers the system actually knows about — read live from GET /api/vendors. Supplier-level fields and offer-level fields are shown separately."
        actions={<Button onClick={() => go('/app/vendors/import')}>Import suppliers <span aria-hidden="true">→</span></Button>}
      />
      <section className="surface">
        <div className="lookup-row">
          <label className="field"><span className="field-label">Search loaded offers</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Vendor, SKU, or offer ID" /></label>
          <label className="check-setting" style={{ minWidth: 220 }}><input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} /><span><b>Approved only</b></span></label>
        </div>
        {loading ? <LoadingState label="Reading supplier catalog…" rows={4} /> : error ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <InlineAlert tone="error" title="Catalog could not be loaded">{error}</InlineAlert>
            <div><Button variant="secondary" onClick={load}>Retry</Button></div>
          </div>
        ) : !offers.length ? (
          <EmptyState folio="01" title="No supplier offers yet" description="The catalog endpoint returned zero offers. Import a spreadsheet to populate the catalog, then return here to inspect what the decision engine will use." action={<Button onClick={() => go('/app/vendors/import')}>Import suppliers →</Button>} />
        ) : filtered.length === 0 ? (
          <EmptyState folio="02" title="No matches in loaded data" description="No loaded offer matches the current search and filter. This filter runs client-side over the loaded catalog only." action={<Button variant="secondary" onClick={() => { setQuery(''); setOnlyApproved(false); }}>Clear search</Button>} />
        ) : (
          <>
            <p className="muted-note">{filtered.length} of {offers.length} loaded offers shown · Source: GET /api/vendors · Prices use tabular numerals, right-aligned.</p>
            <div className="table-scroll" tabIndex={0}>
              <table className="data-table">
                <thead><tr><th>Supplier</th><th>SKU / offer</th><th>Unit price</th><th>Charges</th><th>Avail.</th><th>Delivery</th><th>Approval</th><th>Quality · Rel.</th></tr></thead>
                <tbody>
                  {filtered.map((o) => (
                    <tr key={o.offerId}>
                      <td><b>{o.vendorName}</b><small className="cell-sub">{o.vendorId}</small></td>
                      <td><code>{o.productId}</code><small className="cell-sub"><code>{o.offerId}</code></small></td>
                      <td className="num">{formatMoney(o.unitPriceMinor, o.currency)}<small className="cell-sub">{o.currency}</small></td>
                      <td className="num"><small className="cell-sub">ship {formatMoney(o.shippingMinor, o.currency)} · tax {formatMoney(o.taxMinor, o.currency)} · fees {formatMoney(o.feesMinor, o.currency)}</small></td>
                      <td className="num">{o.availableQuantity}</td>
                      <td className="num">{o.deliveryDays}d</td>
                      <td>{o.vendorApproved ? <StatusBadge tone="ok">Approved</StatusBadge> : <StatusBadge tone="warn">Not approved</StatusBadge>}</td>
                      <td className="num">{o.qualityScore ?? '—'} · {o.reliabilityScore ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ================= Import page ================= */
function ImportPage({ onImported }) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Supplier catalog"
        title="Import suppliers"
        description="Upload a spreadsheet, map its columns, review every row, then confirm the database write. Supported formats and the file-size limit are shown at the upload step."
        meta={<StatusBadge tone="info">Upsert key: offerId (vendor ID + product)</StatusBadge>}
      />
      <section className="surface">
        <VendorImportWizard onImported={onImported} />
        <div className="notice-box" style={{ marginTop: 16 }}>This is the same workflow used inside workspace setup — one implementation, two entry points. A successful response confirms offers were saved by the backend; recommendations still depend on the decision engine and its current catalog.</div>
      </section>
    </div>
  );
}

/* ================= History ================= */
function HistoryPage() {
  const [id, setId] = useState('');
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function lookup(e) {
    e?.preventDefault();
    setBusy(true); setError(''); setRecord(null);
    try {
      const data = await getPurchaseById(id);
      setRecord(data);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Purchasing activity"
        title="Purchase history"
        description="Look up a purchase by its ID. There is no list endpoint yet, so this page does not fake a history table."
        actions={<Button onClick={() => go('/app/purchases/new')}>New purchase request <span aria-hidden="true">→</span></Button>}
      />
      <section className="surface">
        <InlineAlert tone="info" title="Honest limitation">The backend supports <code>GET /api/purchases/:purchaseId</code> but no list endpoint. Records are held in memory and reset when the server restarts. A recommendation is never shown as a payment.</InlineAlert>
        <form onSubmit={lookup} className="lookup-row">
          <label className="field"><span className="field-label">Purchase ID (e.g. purchase_abc123…)</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="Paste a purchase ID from the purchase desk" /></label>
          <Button type="submit" disabled={busy || !id.trim()}>{busy ? 'Looking up…' : 'Look up'}</Button>
        </form>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        {!record && !error ? <EmptyState folio="03" title="No record loaded" description="Evaluate a purchase on the purchase desk, copy its purchase ID, and paste it here to inspect the stored decision, policy outcome, and audit events." action={<Button variant="secondary" onClick={() => go('/app/purchases/new')}>Open purchase desk</Button>} /> : null}
        {record ? (
          <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <StatusBadge tone={record.decision?.status === 'RECOMMENDED' ? 'ok' : 'warn'}>{record.decision?.status || 'Unknown'}</StatusBadge>
              <StatusBadge tone={record.policy?.passed ? 'ok' : 'error'}>{record.policy?.passed ? 'Policy passed' : 'Policy blocked'}</StatusBadge>
              <StatusBadge tone="warn">Payment locked</StatusBadge>
            </div>
            <div className="confirm-list">
              <li><span>Purchase ID</span><b><code>{record.purchaseId}</code></b></li>
              <li><span>Product · Qty</span><b>{record.request?.productId} · {record.request?.quantity}</b></li>
              <li><span>Recommendation</span><b>{record.recommendation ? `${record.recommendation.vendorId} (${record.recommendation.offerId}) · ${formatMoney(record.recommendation.totalMinor, record.recommendation.currency)}` : 'None'}</b></li>
              <li><span>Explanation</span><b style={{ fontWeight: 400 }}>{record.explanation}</b></li>
            </div>
            {(record.policy?.violations || []).length ? <div className="result-findings"><b>Policy findings</b>{record.policy.violations.map((v, i) => <p key={i}><code>{v.code}</code> — {v.message}</p>)}</div> : null}
            {(record.auditEvents || []).length ? <div><h3 style={{ fontSize: 15 }}>Audit events ({record.auditEvents.length})</h3>{record.auditEvents.map((ev, i) => <div className="audit-event" key={i}><i aria-hidden="true" /><span><b>{String(ev.eventType || '').replaceAll('_', ' ')}</b><small>{ev.timestamp ? new Date(ev.timestamp).toLocaleString() : 'Recorded'}</small></span></div>)}</div> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* ================= Policies ================= */
function PoliciesPage({ profile }) {
  const rows = [
    ['Budget default', profile?.defaultBudget ? formatMoney(Number(profile.defaultBudget) * 100, profile.currency) : 'No default budget', 'Workspace preference', 'Prefills the purchase form in this browser.'],
    ['Approved vendors only', profile?.approvedOnly ? 'On' : 'Off', 'Request default', 'Sent with each evaluation when enabled.'],
    ['Delivery deadline', `${profile?.deadline || 5} days`, 'Request default', 'Sent with each evaluation.'],
    ['Minimum quality', `${profile?.quality || 70}/100`, 'Request default', 'Sent with each evaluation.'],
    ['Minimum reliability', `${profile?.reliability || 70}/100`, 'Request default', 'Sent with each evaluation.'],
    ['Human review preference', profile?.allReview ? 'Preferred' : 'Not required', 'Not enforced by backend', 'A recorded intention. Approval endpoints return 501.'],
  ];
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Policy controls" title="Policy controls" description="Configured preferences are not enforced policy. The backend validates the constraints sent with each purchase request — there is no separate persisted policy model." />
      <section className="surface">
        <InlineAlert tone="info" title="Where rules are evaluated">Request constraints (budget, delivery, quality, approval) are checked deterministically during <code>POST /api/purchases/evaluate</code>. Onboarding values below prefill the form; they do not change server enforcement.</InlineAlert>
        <div className="policy-table">
          {rows.map(([k, v, scope, where]) => <div key={k}><b>{k}</b><span>{v}</span><small title={where}>{scope}</small></div>)}
        </div>
        <p className="muted-note">Editing is read-only here because no policy save endpoint exists. Use workspace setup to edit local preferences.</p>
        <Button variant="secondary" onClick={() => go('/app/onboarding')}>Edit preferences</Button>
      </section>
    </div>
  );
}

/* ================= Audit ================= */
function AuditPage() {
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Traceability" title="Audit trail" description="Events only from real sources. There is no global audit listing endpoint, so this page does not synthesize events." />
      <section className="surface">
        <InlineAlert tone="info" title="Current source of truth">Audit events are created during purchase evaluation and stored on the purchase record (in memory). They are visible in the purchase-desk result panel and on the history lookup — not in a separate global feed.</InlineAlert>
        <div className="audit-placeholder"><span className="step-kicker">01</span><div><b>Purchase evaluation events</b><p className="muted-note">Evaluate a request to generate events, then inspect them alongside the recommendation and policy outcome.</p></div><Button variant="secondary" onClick={() => go('/app/purchases/new')}>Open purchase desk</Button></div>
        <p className="muted-note" style={{ marginTop: 12 }}>No immutability or compliance certification is implied — the store resets on server restart.</p>
      </section>
    </div>
  );
}

/* ================= Settings ================= */
function SettingsPage({ profile, theme, onThemeChange }) {
  const [notice, setNotice] = useState('');
  const [verifyStatus, setVerifyStatus] = useState(null);
  const [gmailStatus, setGmailStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const current = await getCurrentWorkspace().catch(() => null);
        if (!alive || !current?.tenant) return;
        const business = await getBusinessEmailStatus(current.tenant.tenantId).catch(() => null);
        const gmail = await getGmailStatus().catch(() => null);
        if (!alive) return;
        setVerifyStatus(business);
        setGmailStatus(gmail);
      } catch { /* read-only display */ }
    })();
    return () => { alive = false; };
  }, []);
  const fields = [
    ['Business name', profile?.businessName], ['Legal name', profile?.legalName], ['Business email', profile?.email],
    ['Country', profile?.country], ['Primary currency', profile?.currency], ['Industry', profile?.industry],
    ['Business size', profile?.size], ['Website', profile?.website || 'Not provided'],
    ['Default budget', profile?.defaultBudget ? `${profile.currency} ${profile.defaultBudget}` : 'Not set'],
    ['Delivery default', `${profile?.deadline || 5} days`],
    ['Approval contact', profile?.managerName || 'Not configured'], ['Approval email', profile?.managerEmail || 'Not configured'],
  ];
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Workspace configuration" title="Workspace settings" description="Business identity, procurement defaults, review preferences, team access, and interface theme — each labeled by where it is actually stored." actions={<span className="demo-chip">Local demo data</span>} />
      <section className="surface">
        <span className="step-kicker">Business identity · saved in this browser</span>
        <div className="settings-grid">{fields.map(([k, v]) => <div key={k}><span>{k}</span><b>{v || 'Not provided'}</b></div>)}</div>
        <div className="notice-box">There is no server-side business profile API yet. “Edit workspace setup” reopens local onboarding — it does not write to the server.</div>
        {verifyStatus ? <p className="muted-note">Server verification: {verifyStatus.businessEmail || 'no business email'} · {verifyStatus.verifiedAt ? `verified ${new Date(verifyStatus.verifiedAt).toLocaleString()} (${verifyStatus.verificationMethod || 'verified'})` : 'not verified — a typed address never proves ownership'}.</p> : <p className="muted-note">Server verification: checking… (sign in with Google and select a workspace to see status).</p>}
        {gmailStatus && gmailStatus.enabled !== false ? <p className="muted-note">Gmail mailbox: {gmailStatus.connected ? `connected (${gmailStatus.mailboxEmail || ''})` : 'disconnected'}. Sign-in never grants mailbox access; connection requires separate consent.</p> : <p className="muted-note">Gmail mailbox: not configured for this deployment.</p>}
        <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}><Button onClick={() => go('/app/onboarding')}>Edit workspace setup</Button></div>
      </section>
      <section className="surface">
        <span className="step-kicker">Review preferences · local preference, not permission</span>
        <p className="muted-note">Human review: {profile?.allReview ? 'preferred' : 'not required'} · Thresholds workflow: {profile?.thresholds ? 'intended' : 'not configured'}. Approval endpoints are not implemented.</p>
      </section>
      <section className="surface">
        <span className="step-kicker">Team · not connected</span>
        <h3>Team management isn’t available yet</h3>
        <p className="muted-note">This prototype has no account service, invitations, or server-side roles. No team changes can be made here.</p>
        <Button variant="secondary" onClick={() => setNotice('Team management will be available after authentication and organization APIs are implemented.')}>Why is this unavailable?</Button>
        {notice ? <div className="notice-box" style={{ marginTop: 12 }}>{notice}</div> : null}
      </section>
      <section className="surface">
        <span className="step-kicker">Theme and interface</span>
        <p className="muted-note">Light, dark, or follow your operating system. Your choice persists after reload; System follows OS changes live.</p>
        <ThemeControl value={theme} onChange={onThemeChange} />
      </section>
    </div>
  );
}

function ApprovalsPage() {
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Human review" title="Approvals" description="Approval actions are intentionally unavailable until the backend workflow is implemented." actions={<span className="locked-chip">Locked</span>} />
      <section className="surface empty-feature">
        <span className="large-lock" aria-hidden="true">⌑</span>
        <h2>No approval workflow connected</h2>
        <p className="muted-note">Purchase recommendations can be evaluated, but approval endpoints return 501. This page will not mark a purchase as approved or authorize payment.</p>
        <Button variant="secondary" onClick={() => go('/app/purchases/new')}>Evaluate a purchase</Button>
      </section>
    </div>
  );
}

/* ================= Shell ================= */
function AppShell({ page, profile, user, onSignOut, theme, onThemeChange, children, apiOnline }) {
  const groups = [
    {
      label: 'Buy', items: [
        ['dashboard', 'Overview', '⌂', '/app/dashboard'],
        ['purchase', 'Purchase desk', '→', '/app/purchases/new'],
        ['history', 'Purchase history', '≡', '/app/purchases'],
      ],
    },
    {
      label: 'Supply', items: [
        ['vendors', 'Supplier catalog', '◇', '/app/vendors'],
        ['import', 'Import suppliers', '⇪', '/app/vendors/import'],
      ],
    },
    {
      label: 'Govern', items: [
        ['policies', 'Policy controls', '☷', '/app/policies'],
        ['audit', 'Audit trail', '≋', '/app/audit'],
        ['business', 'Workspace settings', '⚙', '/app/settings/business'],
      ],
    },
  ];
  const [mobileOpen, setMobileOpen] = useState(false);
  const active = page;
  const titles = { dashboard: 'Overview', purchase: 'Purchase desk', history: 'Purchase history', vendors: 'Supplier catalog', import: 'Import suppliers', policies: 'Policy controls', approvals: 'Approvals', audit: 'Audit trail', business: 'Workspace settings' };
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);
  return (
    <div className="app-shell">
      <aside className={mobileOpen ? 'app-sidebar mobile-open' : 'app-sidebar'} aria-label="Primary navigation">
        <div className="sidebar-brand"><Logo light /><button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button></div>
        <div className="workspace-label">Workspace</div>
        <div className="workspace-card"><span className="workspace-avatar">{(profile?.businessName || 'M').slice(0, 1).toUpperCase()}</span><span><b>{profile?.businessName || 'Demo workspace'}</b><small>Local demo environment</small></span><span className="workspace-chevron" aria-hidden="true">⌄</span></div>
        <nav className="app-nav">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map(([key, label, icon, path]) => (
                <button key={key} className={active === key ? 'app-nav-link active' : 'app-nav-link'} aria-current={active === key ? 'page' : undefined} onClick={() => { go(path); setMobileOpen(false); }}>
                  <span className="nav-icon" aria-hidden="true">{icon}</span>{label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="prototype-status"><span aria-hidden="true" />Prototype mode<small>Payments disabled · {apiOnline ? 'API connected' : 'API status unknown'}</small></div>
          <div className="sidebar-user"><span className="user-avatar">{(user?.fullName || 'D').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span><span><b>{user?.fullName || 'Demo user'}</b><small>{user?.email || 'Local session'}</small></span><button aria-label="Sign out" title="Sign out" onClick={onSignOut}>↪</button></div>
        </div>
      </aside>
      {mobileOpen ? <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" /> : null}
      <div className="app-main">
        <header className="app-topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button>
          <div className="breadcrumbs" aria-label="Breadcrumb"><span>Workspace</span><b aria-hidden="true">/</b><strong>{titles[page] || 'Overview'}</strong></div>
          <div className="topbar-right">
            <ThemeControl value={theme} onChange={onThemeChange} />
            <span className="demo-chip">Demo</span>
            <button className="topbar-user" onClick={() => go('/app/settings/business')} title="Business settings">{(profile?.businessName || 'M').slice(0, 1).toUpperCase()}</button>
          </div>
        </header>
        <main className="app-content">{children}</main>
        <footer className="app-footer"><span>Mandate · Procurement workspace</span><span>Prototype — recommendation is not approval; payment execution locked</span></footer>
      </div>
    </div>
  );
}

/* ================= App (API-validated session; demo local kept for preview only) ================= */
export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [serverUser, setServerUser] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [demoUser, setDemoUser] = useState(() => { try { return JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch { return null; } });
  const [workspaces, setWorkspaces] = useState([]);
  const [permissions, setPermissions] = useState(null);
  const [profile, setProfile] = useState(() => readStore());
  const [theme, setTheme] = useState(() => { try { const t = localStorage.getItem(THEME_KEY); return ['light', 'dark', 'system'].includes(t) ? t : 'system'; } catch { return 'system'; } });
  const [apiOnline, setApiOnline] = useState(false);
  const user = serverUser || demoUser;
  const isServerSession = Boolean(serverUser);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
      root.dataset.theme = resolved; root.style.colorScheme = resolved;
    };
    apply();
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (theme === 'system') apply(); };
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [theme]);

  useEffect(() => {
    getHealth().then(() => setApiOnline(true)).catch(() => setApiOnline(false));
  }, [path]);

  // API-validated session replaces local-storage authority for server data.
  useEffect(() => {
    let alive = true;
    setSessionLoading(true);
    (async () => {
      try {
        try {
          const params = new URLSearchParams(window.location.search);
          if (params.get('auth') === 'success') {
            const clean = window.location.pathname;
            window.history.replaceState({}, '', clean);
            setPath(clean);
          }
        } catch { /* ignore */ }
        const session = await getSession();
        if (!alive) return;
        if (session?.authenticated && session.user) {
          setServerUser({
            fullName: session.user.displayName || session.user.email.split('@')[0],
            email: session.user.email,
            userId: session.user.userId,
          });
          setSessionError('');
          try {
            const mine = await getMyWorkspaces().catch(() => null);
            const list = mine?.memberships || [];
            if (alive) setWorkspaces(list);
            if (list.length > 0) {
              const currentSelected = (() => { try { return localStorage.getItem('mandate.selected.tenant.v1') || ''; } catch { return ''; } })();
              if (!currentSelected) setSelectedTenantId(list[0].tenantId);
            }
            const current = await getCurrentWorkspace().catch(() => null);
            if (alive && current) setPermissions(current.permissions || current.membership?.permissions || null);
          } catch { /* workspace display-only */ }
        } else {
          setServerUser(null);
        }
      } catch (e) {
        if (alive) setSessionError(e.message || 'Session check failed.');
      } finally {
        if (alive) setSessionLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    const onNavigate = (e) => { const next = e.detail || '/'; window.history.pushState({}, '', next); setPath(next); window.scrollTo(0, 0); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('mandate:navigate', onNavigate);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('mandate:navigate', onNavigate); };
  }, []);

  function authenticate(nextUser) {
    // Demo preview only — does not grant server access. Server data requires Google sign-in.
    localStorage.setItem(SESSION, JSON.stringify(nextUser));
    setDemoUser(nextUser);
    const saved = readStore();
    if (saved) { const merged = { ...saved, fullName: nextUser.fullName, email: nextUser.email }; setProfile(merged); go('/app/dashboard'); }
    else { setProfile(null); go('/app/onboarding'); }
  }
  function complete(profileData) { setProfile(profileData); saveStore(profileData); go('/app/dashboard'); }
  async function signOut() {
    try { await apiLogout(); } catch { /* session may already be expired */ }
    try { localStorage.removeItem(SESSION); } catch { /* ignore */ }
    setDemoUser(null);
    setServerUser(null);
    setWorkspaces([]);
    setPermissions(null);
    setSelectedTenantId('');
    go('/');
  }
  function handleImported(result) {
    setProfile((prev) => {
      if (!prev) return prev;
      const next = { ...prev, vendorImport: { ...(prev.vendorImport || {}), mode: 'backend-import', importedCount: result?.received ?? result?.inserted ?? null, importedAt: new Date().toISOString() } };
      saveStore(next);
      return next;
    });
  }

  if (path === '/login' || path === '/signup') return <AuthPage key={path} mode={path === '/signup' ? 'signup' : 'login'} onAuth={authenticate} />;
  if (path === '/forgot-password') return <ForgotPassword />;
  if (path === '/') return <LandingPage />;
  if (sessionLoading) {
    return (
      <div className="auth-page">
        <main className="simple-message" aria-live="polite">
          <span className="eyebrow">Checking session</span>
          <h2>Validating your session…</h2>
          <p className="muted-note">Sessions are validated server-side. Local preview data never grants API access.</p>
          <LoadingState rows={2} label="Checking session…" />
        </main>
      </div>
    );
  }
  if (!user) return <LandingPage />;
  if (path === '/app/onboarding') return <Onboarding key={profile?.onboardingComplete ? 'edit' : 'new'} user={user} onComplete={complete} />;

  const page = path === '/app' || path === '/app/dashboard' ? 'dashboard'
    : path === '/app/purchases/new' ? 'purchase'
      : path === '/app/purchases' ? 'history'
        : path === '/app/vendors' ? 'vendors'
          : path === '/app/vendors/import' ? 'import'
            : path === '/app/policies' ? 'policies'
              : path === '/app/approvals' ? 'approvals'
                : path === '/app/audit' ? 'audit'
                  : path === '/app/settings/business' || path === '/app/settings/team' ? 'business' : 'dashboard';

  const sessionBanner = !isServerSession ? (
    <div className="wrap" style={{ paddingTop: 12 }}>
      <div className="notice-box" role="note">
        {sessionError ? `Signed out — ${sessionError} ` : 'Demo preview — server data requires Google sign-in. '}
        <button className="inline-link" onClick={() => go('/login')}>Sign in with Google →</button>
        {workspaces.length > 1 ? (
          <span style={{ marginLeft: 12 }}>
            Workspace:{' '}
            <select
              aria-label="Select workspace"
              value={(() => { try { return localStorage.getItem('mandate.selected.tenant.v1') || ''; } catch { return ''; } })()}
              onChange={(e) => { setSelectedTenantId(e.target.value); window.location.reload(); }}
            >
              {workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>{w.businessName || w.tenantId} ({w.role})</option>)}
            </select>
          </span>
        ) : null}
      </div>
    </div>
  ) : (workspaces.length > 1 ? (
    <div className="wrap" style={{ paddingTop: 12 }}>
      <p className="muted-note">
        Workspace:{' '}
        <select
          aria-label="Select workspace"
          value={(() => { try { return localStorage.getItem('mandate.selected.tenant.v1') || ''; } catch { return ''; } })()}
          onChange={(e) => { setSelectedTenantId(e.target.value); window.location.reload(); }}
        >
          {workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>{w.businessName || w.tenantId} ({w.role})</option>)}
        </select>
      </p>
    </div>
  ) : null);

  return (
    <>
      {sessionBanner}
      <AppShell page={page} profile={profile} user={user} onSignOut={signOut} theme={theme} onThemeChange={setTheme} apiOnline={apiOnline}>
      {page === 'dashboard' ? <Dashboard profile={profile} permissions={permissions} onStartPurchase={() => go('/app/purchases/new')} />
        : page === 'purchase' ? <PurchaseDesk defaults={profile} />
          : page === 'vendors' ? <CatalogPage />
            : page === 'import' ? <ImportPage onImported={handleImported} />
              : page === 'history' ? <HistoryPage />
                : page === 'policies' ? <PoliciesPage profile={profile} />
                  : page === 'audit' ? <AuditPage />
                    : page === 'approvals' ? <ApprovalsPage />
                      : <SettingsPage profile={profile} theme={theme} onThemeChange={setTheme} />}
      </AppShell>
    </>
  );
}
