'use strict';

import React, { useEffect, useState } from 'react';
import { PageHeader, Button, InlineAlert, LoadingState, StatusBadge } from './components/ui.jsx';
import { go } from './components/ui.jsx';
import { interpretPurchaseRequest, explainPurchase, listPurchases, getPurchaseById, createPaypalOrder, capturePaypalOrder, getPaypalStatus } from './api/client.js';
import { useVendorNames } from './App.jsx';

const STEP_FORM = 'form';
const STEP_DETAIL = 'detail';

function ApprovalsPage({ profile, onNavigate }) {
  const vendorNames = useVendorNames();
  const [step, setStep] = useState(STEP_FORM);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { purchaseId, step }
  const [approvePayload, setApprovePayload] = useState(null);
  const [rejectPayload, setRejectPayload] = useState(null);

  // Load pending approvals for the current user's workspace
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    // We need the user's tenant; get it from the session or assume the current workspace.
    // For now, list purchases and filter those requiring approval.
    listPurchases()
      .then((records) => {
        if (!alive) return;
        // Filter to those with requiresHumanApproval and no approval recorded yet
        const needingApproval = records.filter((r) => {
          const recApproval = r.approval || {};
          const needs = r.authorization?.requiresHumanApproval && !recApproval.approvedAt;
          return needs;
        });
        setPending(needingApproval[0] || null);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.message || 'Could not load pending approvals.');
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // Approve action
  async function handleApprove(purchaseId) {
    setPending(null);
    setApprovePayload({ purchaseId, step: 'confirm' });
  }

  async function confirmApprove(purchaseId) {
    try {
      const data = await fetch(`/api/approvals/purchase/${purchaseId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rationale: 'Human reviewer approved the recommendation.' }),
      });
      const result = await data.json();
      if (!data.ok) throw new Error(result.error?.message || 'Approval failed.');
      // Refresh the pending list
      setError('');
      // Navigate back or stay
      go('/app/purchases');
    } catch (err) {
      setError(err.message || 'Approval could not be completed.');
    } finally {
      setApprovePayload(null);
    }
  }

  // Reject action
  async function handleReject(purchaseId) {
    setPending(null);
    setRejectPayload({ purchaseId, step: 'confirm' });
  }

  async function confirmReject(purchaseId) {
    try {
      const data = await fetch(`/api/approvals/purchase/${purchaseId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rationale: 'Human reviewer rejected the recommendation.' }),
      });
      const result = await data.json();
      if (!data.ok) throw new Error(result.error?.message || 'Rejection failed.');
      setError('');
      go('/app/purchases');
    } catch (err) {
      setError(err.message || 'Rejection could not be completed.');
    } finally {
      setRejectPayload(null);
    }
  }

  if (step === STEP_FORM) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Approval queue"
          title="Purchase approvals"
          description="Review and act on pending purchase recommendations."
        />
        {loading ? (
          <LoadingState rows={4} label="Loading pending approvals…" />
        ) : error ? (
          <InlineAlert tone="error" title="Could not load approvals">
            {error} <Button variant="secondary" onClick={() => setError('')}>Clear</Button>
          </InlineAlert>
        ) : !pending ? (
          <div className="empty-state folio" title="No pending approvals">
            <span className="empty-folio" aria-hidden="true">≋</span>
            <h3>No pending purchase approvals</h3>
            <p>All purchase evaluations are either approved, rejected, or do not require human review.</p>
            <Button onClick={() => go('/app/purchases/new')}>New purchase request →</Button>
          </div>
        ) : (
          <div className="surface">
            <div className="surface-head">
              <div>
                <span className="step-kicker">Purchase pending approval</span>
                <h2>Review recommendation for <code>{pending?.purchaseId}</code></h2>
              </div>
            </div>
            <p className="muted-note">
              This purchase has been evaluated and requires human review before payment may proceed.
            </p>

            {/* Show purchase details summary */}
            {pending && (
              <div className="surface-content">
                <h3>Purchase details</h3>
                <p><strong>Product</strong>: {pending.request?.productId}</p>
                <p><strong>Quantity</strong>: {pending.request?.quantity}</p>
                <p><strong>Budget</strong>: {pending.request?.currency} {Number(pending.request?.maxTotalMinor) / 100}</p>
                <p><strong>Delivery</strong>: ≤ {pending.request?.maxDeliveryDays} days</p>
                <p><strong>Quality minimum</strong>: {pending.request?.minQualityScore ?? 'Any'}/100</p>
                <p><strong>Reliability minimum</strong>: {pending.request?.minReliabilityScore ?? 'Any'}/100</p>
                <p><strong>Approved vendors only</strong>: {pending.request?.requireApprovedVendor ? 'Yes' : 'No'}</p>
              </div>
            )}

            <div className="purchase-result">
              <div className={pending.decision?.status === 'RECOMMENDED' && pending.policy?.passed ? 'decision-banner good' : 'decision-banner warn'}>
                <b>{pending.decision?.status === 'RECOMMENDED' && pending.policy?.passed ? 'Recommendation is policy-compliant' : 'Recommendation needs human review'}</b>
                <p>{pending.explanation}</p>
              </div>

              {pending.recommendation ? (
                <div className="recommended-offer">
                  <span className="step-kicker">Recommendation · not approval</span>
                  <h3>{vendorNames.get(pending.recommendation.offerId) || pending.recommendation.vendorId}</h3>
                  <p>Offer <code>{pending.recommendation.offerId}</code> · Score {pending.recommendation.score}</p>
                  <div><span>Estimated total (incl. shipping, tax, fees)</span><b>{formatMoney(pending.recommendation.totalMinor, pending.recommendation.currency)}</b></div>
                </div>
              ) : (
                <p>No recommendation.</p>
              )}

              <div className="status-list">
                <div><span><b>Policy validation — deterministic</b><small>{pending.policy?.passed ? 'Configured guardrails passed for the recommended offer' : 'One or more checks did not pass; see findings'}</small></span><strong className={pending.policy?.passed ? 'pill-good' : 'pill-bad'}>{pending.policy?.passed ? 'PASSED' : 'BLOCKED'}</strong></div>
                <div><span><b>Human decision — required</b><small>{pending.authorization?.requiresHumanApproval ? 'An authorized person must review before anything else happens' : 'No approval action available in this prototype'}</small></span><strong className="pill-wait">REVIEW REQUIRED</strong></div>
                <div><span><b>PayPal payment</b><small>Order can be created after approval; capture requires PayPal user approval</small></span><strong className="pill-good">ENABLED</strong></div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <Button onClick={() => setStep(STEP_DETAIL)} variant="primary">
                Review and act on approval
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Detail step: show approve/reject forms
  if (step === STEP_DETAIL && pending) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Approval queue"
          title="Purchase approval"
          description="Approve or reject a purchase recommendation."
        />
        {error ? (
          <InlineAlert tone="error" title="Error">
            {error} <Button variant="secondary" onClick={() => setError('')}>Clear</Button>
          </InlineAlert>
        ) : null}
        <div className="surface">
          <div className="surface-head">
            <div>
              <span className="step-kicker">Approve/reject purchase</span>
              <h2>Purchase <code>{pending.purchaseId}</code></h2>
            </div>
          </div>
          <p className="muted-note">
            {pending.decision?.status === 'RECOMMENDED' && pending.policy?.passed ? 'The deterministic engine recommended this offer and policy passed. Your review is required.' : 'The engine found no eligible offer, or policy blocked the recommendation.'}
          </p>

          <form onSubmit={async (e) => {
            e.preventDefault();
            if (approvePayload?.purchaseId === pending.purchaseId) {
              await confirmApprove(pending.purchaseId);
            } else if (rejectPayload?.purchaseId === pending.purchaseId) {
              await confirmReject(pending.purchaseId);
            }
          }}>
            <div className="form-fields">
              <div>
                <label>Action
                  <select
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'approve') {
                        setApprovePayload({ purchaseId: pending.purchaseId, step: 'confirm' });
                      } else if (val === 'reject') {
                        setRejectPayload({ purchaseId: pending.purchaseId, step: 'confirm' });
                      }
                    }}
                  >
                    <option value="">Select action</option>
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </select>
                </label>
                <textarea
                  rows={3}
                  placeholder="Rationale for your decision (e.g. 'Approved — meets all constraints and team policy')"
                  onChange={(e) => {
                    if (e.target.value && !approvePayload) {
                      setApprovePayload({ purchaseId: pending.purchaseId, step: 'confirm', rationale: e.target.value });
                    } else if (e.target.value && !rejectPayload) {
                      setRejectPayload({ purchaseId: pending.purchaseId, step: 'confirm', rationale: e.target.value });
                    }
                  }}
                  defaultValue={approvePayload?.rationale || rejectPayload?.rationale || ''}
                />
              </div>

              {approvePayload && approvePayload.purchaseId === pending.purchaseId ? (
                <div>
                  <h4>Approve confirmation</h4>
                  <p>Are you sure you want to <b>approve</b> this recommendation?</p>
                  <p><small>Rationale: {approvePayload.rationale || '—'}</small></p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Button type="submit" disabled={!approvePayload.rationale}>Approve</Button>
                    <Button type="button" variant="secondary" onClick={() => {
                      setApprovePayload(null);
                    }}>Cancel
                  </div>
                </div>
              ) : null}

              {pending.approval?.approvedAt && (
                <div style={{ marginTop: 12 }}>
                  <Button onClick={() => createPaypalOrder(pending.purchaseId)} variant="primary">
                    Create PayPal Order
                  </Button>
                </div>
              )}

              {rejectPayload && rejectPayload.purchaseId === pending.purchaseId ? (
                <div>
                  <h4>Reject confirmation</h4>
                  <p>Are you sure you want to <b>reject</b> this recommendation?</p>
                  <p><small>Rationale: {rejectPayload.rationale || '—'}</small></p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Button type="submit" disabled={!rejectPayload.rationale}>Reject</Button>
                    <Button type="button" variant="secondary" onClick={() => {
                      setRejectPayload(null);
                    }}>Cancel
                  </div>
                </div>
              ) : null}
            </div>
          </form>
        </div>
      </div>
    );
  }

  return null;
}

// Helper: format money minor to major using currency exponent
function formatMoney(minor, currency) {
  const value = Number(minor || 0);
  const code = String(currency || 'INR').toUpperCase();
  const exponent = 2; // simplified; in real use import from currency.js
  const amount = exponent === 0 ? value : value / 10 ** exponent;
  try {
    const locale = code === 'INR' ? 'en-IN' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(exponent)}`;
  }
}

export default function Approvals({ profile, onNavigate }) {
  // This component is rendered by the router; the actual page logic is in the hook above.
  // Kept for router compatibility.
  return <></>;
}