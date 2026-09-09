// ---------------------------------------------------------------------------
// Sola Payments — card/debit online payments (replaces the earlier Stripe
// integration; see services/stripe.js, kept in place but unused — historical
// shul_payments rows still reference it via method='stripe_card' and
// stripe_payment_intent_id, so the file stays for reference, it's just never
// called anymore).
//
// Sola is a white-labeled front for the Cardknox gateway (confirmed via
// docs.solapayments.com, whose links resolve to cdn.cardknox.com and whose
// terminology — xKey, iFields — is exactly Cardknox's own API) — this file
// talks to Cardknox's actual REST endpoints under Sola's branding.
//
// MOCK MODE (no real charge, a fake approval) until SOLA_TRANSACTION_KEY is
// set in the deploy environment — same pattern as every other integration in
// this app (Brevo, disccardpromos, SimpleSender, the old Stripe setup).
// SOLA_TRANSACTION_KEY (the private xKey) never leaves this file.
//
// PCI SCOPE — READ BEFORE TOUCHING THIS FLOW: the shul portal's payment form
// is a plain (non-iframe) HTML form — real card number/CVV are typed
// directly into ordinary <input> fields, POSTed to this app's own
// POST /mine/sola-charge route in routes/shulPayments.js, and forwarded from
// there straight into chargeSale() below. Raw card data DOES pass through
// this server's request handling (in req.body, in memory) on its way to
// Sola — it is never written to the database or logged anywhere, but it is
// processed here, which is a materially different (and heavier) PCI
// compliance posture than a hosted-iframe solution like Sola's own iFields
// product: this puts the org in PCI SAQ-D scope (the full assessment —
// network segmentation, quarterly scans, etc.), not the lightweight SAQ-A a
// true iframe/redirect solution qualifies for. This was a deliberate,
// explicit choice (matching an existing sibling app's own Sola integration,
// which uses the same pattern) made after that tradeoff was raised — don't
// "simplify" this back to iFields, and don't add any logging of req.body on
// this route or anywhere chargeSale()'s cardNum/cvv arguments flow through.
//
// One material gap, flagged rather than guessed at: Stripe's fee_amount was
// the REAL fee, read back from the settled charge's own balance_transaction
// (see the old services/stripe.js). Sola/Cardknox's transaction API (as
// documented at docs.solapayments.com/api/transaction) does not return a
// per-transaction processing-fee figure the same way — interchange/
// processing fees are typically only visible on the merchant's statement,
// not the sale response. fee_amount is left at 0 for every Sola-processed
// row until/unless Sola's support confirms a way to retrieve it per
// transaction — same "best-guess pending confirmation" posture this app
// already takes with disccardpromos.js's endpoint mapping.
// ---------------------------------------------------------------------------

const CONFIG = {
  transactionKey: process.env.SOLA_TRANSACTION_KEY || '',
};

// x1 primary, x2 backup — both documented at docs.solapayments.com/api/transaction.
// gatewayjson accepts and returns JSON (vs. the form/xml variants), the
// natural fit for a Node/Express app.
const GATEWAY_URL = 'https://x1.cardknox.com/gatewayjson';
const SOFTWARE_NAME = 'EverythingShul-eCards';
const SOFTWARE_VERSION = '1.0';
const API_VERSION = '5.0.0';

export function isSolaMockMode() { return !CONFIG.transactionKey; }
export function solaConfigStatus() { return { mockMode: isSolaMockMode() }; }

async function post(fields) {
  const body = { xKey: CONFIG.transactionKey, xVersion: API_VERSION, xSoftwareName: SOFTWARE_NAME, xSoftwareVersion: SOFTWARE_VERSION, ...fields };
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return data;
}

// Pulls just the last 4 digits out of Sola's xMaskedCardNumber (e.g.
// "411111xxxxxx1111" or "************1234") — this app never has the full
// PAN to begin with (see the file-level comment), so the trailing digits
// are all there ever is to extract.
function last4From(maskedCardNumber) {
  const m = String(maskedCardNumber || '').match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

// One-shot sale (auth + capture combined — xCommand: cc:Sale). xCardNum/
// xCVV/xExp here are the REAL card number/CVV/expiration (MMYY), typed
// directly into the shul portal's own form fields — see the file-level PCI
// comment above for what that means and why. Field names below (xBillZip,
// xComments, in addition to the obvious xCardNum/xCVV/xExp/xAmount) match a
// working sibling app's own proven Sola integration exactly, rather than
// this file's own earlier guesses (xZip/xDescription) from Sola's public
// docs alone — kept that way deliberately since it's the more reliable
// source. Returns the Sola reference number (xRefNum), which is what a
// later refund/void must be linked to.
export async function chargeSale({ amount, xCardNum, xCVV, xExp, xZip, xName, xEmail, invoice, comments }) {
  if (isSolaMockMode()) {
    return { approved: true, refNum: `mock_${Date.now()}`, authCode: 'MOCK00', last4: '1234', mock: true };
  }
  const data = await post({
    xCommand: 'cc:Sale', xAmount: amount.toFixed(2), xCardNum, xCVV, xExp: xExp || '',
    xName: xName || '', xBillZip: xZip || '', xEmail: xEmail || '',
    xInvoice: invoice || '', xComments: comments || '',
  });
  if (data.xResult !== 'A') {
    return { approved: false, error: data.xError || data.xStatus || 'Card declined', refNum: data.xRefNum || null };
  }
  return { approved: true, refNum: data.xRefNum, authCode: data.xAuthCode, last4: last4From(data.xMaskedCardNumber), mock: false };
}

// Refund linked to the original sale via xRefNum — amount can be the full
// original amount or less (a partial refund; Sola's cc:Refund command takes
// the same shape either way, just a smaller xAmount — see docs.
// solapayments.com/api/transaction).
export async function refundTransaction({ refNum, amount }) {
  if (isSolaMockMode() || String(refNum).startsWith('mock_')) {
    return { approved: true, refNum: `mock_refund_${Date.now()}`, mock: true };
  }
  const data = await post({ xCommand: 'cc:Refund', xRefNum: refNum, xAmount: amount.toFixed(2) });
  if (data.xResult !== 'A') {
    return { approved: false, error: data.xError || data.xStatus || 'Refund failed', refNum: data.xRefNum || null };
  }
  return { approved: true, refNum: data.xRefNum, mock: false };
}
