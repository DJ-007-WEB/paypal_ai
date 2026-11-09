import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, Button, InlineAlert, LoadingState, StatusBadge, EmptyState, formatMoney, go } from '../components/ui.jsx';
import {
  capturePaypalOrder,
  cancelPaypalOrder,
  createPaypalOrder,
  decidePurchase,
  listPurchases,
} from '../api/client.js';

function isPending(record) {
  return Boolean(record?.authorization?.requiresHumanApproval)
    && (record.approvalStatus || 'PENDING') === 'PENDING'
    && record.paymentStatus !== 'COMPLETED';
}

function isApprovedUnpaid(record) {
  return record?.approvalStatus === 'APPROVED' && record?.paymentStatus !== 'COMPLETED';
}

function isCompleted(record) {
  return record?.paymentStatus === 'COMPLETED';
}

function purchaseTitle(record) {
  return record?.request?.productId || record?.purchaseId || 'Purchase';
}

function OfferSummary({ record }) {
  const recommendation = record?.recommendation;
  if (!recommendation) return <p className="muted-note">No recommendation was stored for this purchase.</p>;
  return (
    <div className="recommended-offer">
      <span className="step-kicker">Recommendation · not payment</span>
      <h3>{recommendation.vendorId || 'Recommended supplier'}</h3>
      <p>Offer <code>{recommendation.offerId}</code> · score {recommendation.score}</p>
      <div>
        <span>Total (incl. shipping, tax, fees)</span>
        <b>{formatMoney(recommendation.totalMinor, recommendation.currency)}</b>
      </div>
    </div>
  );
}

function PurchaseMeta({ record }) {
  return (
    <div className="status-list">
      <div>
        <span><b>Budget ceiling</b><small>Requested maximum, not the payment amount</small></span>
        <strong>{formatMoney(record?.request?.maxTotalMinor, record?.request?.currency)}</strong>
      </div>
      <div>
        <span><b>Quantity · delivery</b><small>Stored request constraints</small></span>
        <strong>{record?.request?.quantity ?? '—'} · ≤ {record?.request?.maxDeliveryDays ?? '—'} days</strong>
      </div>
      <div>
        <span><b>Policy validation</b><small>Deterministic guardrails</small></span>
        <strong className={record?.policy?.passed ? 'pill-good' : 'pill-bad'}>{record?.policy?.passed ? 'PASSED' : 'BLOCKED'}</strong>
      </div>
      <div>
        <span><b>Payment</b><small>PayPal Sandbox · verified capture only</small></span>
        <strong className={isCompleted(record) ? 'pill-good' : 'pill-wait'}>{record?.paymentStatus || 'NONE'}</strong>
      </div>
    </div>
  );
}

export default function ApprovalsPage({ permissions = null }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [decision, setDecision] = useState(null); // { record, action }
  const [rationale, setRationale] = useState('');
  const returnHandled = useRef(false);

  const canApprove = !Array.isArray(permissions) || permissions.includes('purchases:approve');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await listPurchases();
      setRecords(Array.isArray(list) ? list : []);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      setError(err.message || 'Could not load purchase approvals.');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // Handle PayPal return/cancel. PayPal appends its order token to the return URL.
  useEffect(() => {
    if (returnHandled.current) return;
    returnHandled.current = true;
    let alive = true;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const mode = params.get('paypal');
      if (!mode) {
        await load();
        return;
      }
      const token = params.get('token') || '';
      const clean = `${window.location.pathname}`;
      window.history.replaceState({}, '', clean);

      const list = await load();
      if (!alive) return;
      let pending = null;
      try { pending = JSON.parse(sessionStorage.getItem('mandate.paypal.pending') || 'null'); } catch { pending = null; }
      const storedMatch = token && pending && pending.orderId === token && pending.purchaseId
        ? { purchaseId: pending.purchaseId, payment: { paypal: { orderId: token } } }
        : null;
      const match = storedMatch || (token
        ? list.find((r) => r?.payment?.paypal?.orderId === token)
        : null);
      try { sessionStorage.removeItem('mandate.paypal.pending'); } catch { /* ignore */ }
      if (!match) {
        setNotice(mode === 'cancel'
          ? 'PayPal checkout was cancelled. No payment was captured.'
          : 'PayPal returned without a matching purchase. No payment was captured.');
        return;
      }
      if (mode === 'cancel') {
        try {
          await cancelPaypalOrder(match.purchaseId);
          setNotice('PayPal checkout was cancelled. The stored order is marked cancelled; no payment was captured.');
        } catch (err) {
          setError(err.message || 'The order could not be marked cancelled. No payment was captured.');
        }
        await load();
        return;
      }
      setBusyId(match.purchaseId);
      try {
        const result = await capturePaypalOrder(match.purchaseId, token);
        if (result?.captureStatus === 'COMPLETED' || result?.paymentStatus === 'COMPLETED') {
          setNotice(`PayPal Sandbox confirmed the capture of ${formatMoney(result.amountMinor, result.currency)}.`);
        } else {
          setError('PayPal did not confirm a completed capture. The purchase was not marked paid.');
        }
      } catch (err) {
        setError(err.message || 'PayPal capture could not be verified. The purchase was not marked paid.');
      } finally {
        setBusyId('');
        await load();
      }
    })();
    return () => { alive = false; };
  }, [load]);

  async function submitDecision() {
    if (!decision) return;
    if (!rationale.trim()) {
      setError('A short rationale is required for the approval decision.');
      return;
    }
    setBusyId(decision.record.purchaseId);
    setError('');
    try {
      await decidePurchase(decision.record.purchaseId, decision.action, rationale.trim());
      setNotice(decision.action === 'approve'
        ? 'Purchase approved. A PayPal Sandbox order can now be created.'
        : 'Purchase rejected. No payment can be created.');
      setDecision(null);
      setRationale('');
      await load();
    } catch (err) {
      setError(err.message || 'The decision could not be recorded.');
    } finally {
      setBusyId('');
    }
  }

  async function startPayment(record) {
    setBusyId(record.purchaseId);
    setError('');
    setNotice('');
    try {
      const data = await createPaypalOrder(record.purchaseId);
      if (!data?.approvalUrl) throw new Error('PayPal did not return an approval URL. No payment was started.');
      try {
        sessionStorage.setItem('mandate.paypal.pending', JSON.stringify({
          purchaseId: record.purchaseId,
          orderId: data.paypalOrderId || null,
        }));
      } catch { /* session storage is a convenience; server state remains authoritative */ }
      window.location.assign(data.approvalUrl);
    } catch (err) {
      setError(err.message || 'PayPal checkout could not be started.');
      setBusyId('');
    }
  }

  const pending = records.filter(isPending);
  const approved = records.filter(isApprovedUnpaid);
  const completed = records.filter(isCompleted).slice(0, 5);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Approval queue"
        title="Purchase approvals"
        description="Review recommendations, record a human decision, then pay through PayPal Sandbox. Recommendation is not approval; payment is never marked complete until PayPal verifies the capture."
        actions={<Button variant="secondary" onClick={() => go('/app/purchases')}>Purchase history</Button>}
      />

      {error ? (
        <InlineAlert tone="error" title="Action not completed">
          {error} <Button variant="secondary" onClick={() => setError('')}>Clear</Button>
        </InlineAlert>
      ) : null}
      {notice ? (
        <InlineAlert tone="success" title="Payment status">
          {notice} <Button variant="secondary" onClick={() => setNotice('')}>Clear</Button>
        </InlineAlert>
      ) : null}
      {!canApprove ? (
        <InlineAlert tone="info" title="Read-only view">
          Your workspace role can view approvals but not record decisions or start payments.
        </InlineAlert>
      ) : null}

      {loading ? <LoadingState rows={4} label="Loading purchase approvals…" /> : null}

      {!loading && pending.length === 0 && approved.length === 0 && completed.length === 0 ? (
        <EmptyState
          folio="05"
          title="Nothing awaiting approval"
          description="Evaluate a purchase request on the purchase desk. Recommendations that require human review appear here."
          action={<Button onClick={() => go('/app/purchases/new')}>Open purchase desk →</Button>}
        />
      ) : null}

      {pending.length > 0 ? (
        <section className="surface">
          <div className="surface-head">
            <div>
              <span className="step-kicker">Awaiting human review</span>
              <h2>{pending.length} purchase{pending.length === 1 ? '' : 's'} need a decision</h2>
            </div>
            <StatusBadge tone="warning">REVIEW REQUIRED</StatusBadge>
          </div>
          <div className="surface-content page-stack">
            {pending.map((record) => (
              <article key={record.purchaseId} className="surface" style={{ padding: 16 }}>
                <div className="surface-head" style={{ padding: 0, border: 0 }}>
                  <div>
                    <h3>{purchaseTitle(record)}</h3>
                    <small className="muted-note">Purchase <code>{record.purchaseId}</code> · {record.explanation}</small>
                  </div>
                </div>
                <OfferSummary record={record} />
                <PurchaseMeta record={record} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Button
                    disabled={!canApprove || busyId === record.purchaseId}
                    onClick={() => { setDecision({ record, action: 'approve' }); setRationale(''); }}
                  >Approve</Button>
                  <Button
                    variant="secondary"
                    disabled={!canApprove || busyId === record.purchaseId}
                    onClick={() => { setDecision({ record, action: 'reject' }); setRationale(''); }}
                  >Reject</Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {decision ? (
        <section className="surface">
          <div className="surface-head">
            <div>
              <span className="step-kicker">{decision.action === 'approve' ? 'Approve' : 'Reject'} purchase</span>
              <h2>{purchaseTitle(decision.record)}</h2>
            </div>
          </div>
          <div className="surface-content">
            <p className="muted-note">
              {decision.action === 'approve'
                ? 'Approving records your decision. It does not capture payment; PayPal Sandbox checkout is a separate step.'
                : 'Rejecting prevents any payment from being created for this purchase.'}
            </p>
            <label htmlFor="approval-rationale">Rationale (required)</label>
            <textarea
              id="approval-rationale"
              rows={3}
              value={rationale}
              maxLength={1000}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Explain the decision for the audit trail."
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <Button
                onClick={submitDecision}
                disabled={!canApprove || busyId === decision.record.purchaseId || !rationale.trim()}
              >{decision.action === 'approve' ? 'Record approval' : 'Record rejection'}</Button>
              <Button variant="secondary" onClick={() => { setDecision(null); setRationale(''); }}>Cancel</Button>
            </div>
          </div>
        </section>
      ) : null}

      {approved.length > 0 ? (
        <section className="surface">
          <div className="surface-head">
            <div>
              <span className="step-kicker">Approved · payment not captured</span>
              <h2>Ready for PayPal Sandbox</h2>
            </div>
            <StatusBadge tone="info">APPROVED</StatusBadge>
          </div>
          <div className="surface-content page-stack">
            {approved.map((record) => (
              <article key={record.purchaseId} className="surface" style={{ padding: 16 }}>
                <h3>{purchaseTitle(record)} <code>{record.purchaseId}</code></h3>
                <OfferSummary record={record} />
                <PurchaseMeta record={record} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Button
                    disabled={!canApprove || busyId === record.purchaseId}
                    onClick={() => startPayment(record)}
                  >{busyId === record.purchaseId ? 'Starting PayPal…' : 'Pay with PayPal Sandbox'}</Button>
                  {record.payment?.paypal?.orderId ? (
                    <Button
                      variant="secondary"
                      disabled={!canApprove || busyId === record.purchaseId}
                      onClick={() => {
                        setBusyId(record.purchaseId);
                        startPayment(record).finally(() => setBusyId(''));
                      }}
                    >Reuse pending order</Button>
                  ) : null}
                </div>
                <p className="muted-note" style={{ marginTop: 8 }}>
                  You will approve the payment in PayPal. This app marks the purchase paid only after PayPal returns a verified COMPLETED capture.
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {completed.length > 0 ? (
        <section className="surface">
          <div className="surface-head">
            <div>
              <span className="step-kicker">Recent PayPal captures</span>
              <h2>Verified payments</h2>
            </div>
          </div>
          <div className="surface-content">
            {completed.map((record) => (
              <div key={record.purchaseId} className="status-list">
                <div>
                  <span><b>{purchaseTitle(record)}</b><small><code>{record.payment?.paypal?.captureId || record.payment?.paypal?.orderId}</code></small></span>
                  <strong className="pill-good">
                    {formatMoney(record.payment?.paypal?.amountMinor, record.payment?.paypal?.currency)}
                  </strong>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
