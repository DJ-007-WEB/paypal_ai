import React from 'react';

export function formatMoney(minor, currency = 'INR') {
  const value = Number(minor || 0);
  try {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    // JPY and other zero-decimal currencies still arrive as minor units per backend contract.
    // Intl handles the display; value is divided by 100 for 2-decimal currencies.
    const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP'].includes(String(currency).toUpperCase());
    const amount = zeroDecimal ? value : value / 100;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${(value / 100).toFixed(2)}`;
  }
}

export function Logo({ light = false, onNavigate }) {
  return (
    <a
      className={`logo${light ? ' logo-light' : ''}`}
      href="/"
      onClick={(e) => {
        e.preventDefault();
        onNavigate ? onNavigate('/') : window.dispatchEvent(new CustomEvent('mandate:navigate', { detail: '/' }));
      }}
    >
      <span className="logo-mark" aria-hidden="true">M</span>
      <span className="logo-word">mandate</span>
      <span className="logo-folio" aria-hidden="true">№</span>
    </a>
  );
}

export function go(path) {
  window.dispatchEvent(new CustomEvent('mandate:navigate', { detail: path }));
}

export function Button({ children, variant = 'primary', ...props }) {
  return (
    <button className={`button button-${variant}`} {...props}>
      {children}
    </button>
  );
}

export function PageHeader({ eyebrow, title, description, actions, meta }) {
  return (
    <div className="page-title-row">
      <div className="page-title-copy">
        {eyebrow ? <span className="eyebrow"><span className="eyebrow-rule" aria-hidden="true" />{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="page-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function StatusBadge({ tone = 'neutral', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function InlineAlert({ tone = 'info', title, children, role = 'status' }) {
  return (
    <div className={`alert alert-${tone}`} role={role}>
      <div className="alert-body">
        {title ? <b>{title}</b> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action, folio = '—' }) {
  return (
    <div className="empty-state">
      <span className="empty-folio" aria-hidden="true">{folio}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', rows = 3 }) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row"><span /><span /><span /></div>
      ))}
      <span className="loading-label">{label}</span>
    </div>
  );
}

export function TextField({ label, hint, error, id, ...props }) {
  const fieldId = id || `field-${String(label || 'input').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label className="field" htmlFor={fieldId}>
      <span className="field-label">{label}</span>
      <input id={fieldId} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined} {...props} />
      {hint && !error ? <small id={`${fieldId}-hint`} className="field-hint">{hint}</small> : null}
      {error ? <small id={`${fieldId}-error`} className="field-error" role="alert">{error}</small> : null}
    </label>
  );
}

export function SelectField({ label, hint, error, id, children, ...props }) {
  const fieldId = id || `field-${String(label || 'select').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label className="field" htmlFor={fieldId}>
      <span className="field-label">{label}</span>
      <select id={fieldId} aria-invalid={error ? 'true' : undefined} {...props}>{children}</select>
      {hint && !error ? <small className="field-hint">{hint}</small> : null}
      {error ? <small className="field-error" role="alert">{error}</small> : null}
    </label>
  );
}

export function ThemeControl({ value, onChange }) {
  return (
    <label className="theme-control">
      <span className="theme-control-label">Theme</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Interface theme"
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}

export function MoneyValue({ minor, currency }) {
  return <span className="money">{formatMoney(minor, currency)}</span>;
}

export function ScoreValue({ value }) {
  if (value === null || value === undefined || value === '') return <span className="score">—</span>;
  return <span className="score">{Number(value)}/100</span>;
}

export function ConfirmDialog({ title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel, busy = false }) {
  return (
    <div className="dialog-scrim" role="presentation" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{description}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
