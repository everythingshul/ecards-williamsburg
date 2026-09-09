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
// SOLA_IFIELDS_KEY is safe to expose to the frontend (see GET /shul-payments/
// mine/config in routes/shulPayments.js) — it's the PUBLIC key that only
// lets a browser tokenize card data via Sola's own hosted iframes (iFields),
// never a real charge; SOLA_TRANSACTION_KEY (the private xKey) never leaves
// this file.
//
// Card data itself never reaches this server at all: the shul portal's
// payment form loads Sola's iFields JS (two hosted iframes — card number and
// CVV — served from cardknox.com, not this app) which returns single-use
// tokens (SUTs) the browser submits here as ordinary form fields named
// xCardNum/xCVV. Those tokens, not real card data, are what gets forwarded
// to Sola's charge API below.
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
  ifieldsKey: process.env.SOLA_IFIELDS_KEY || '',
};

// x1 primary, x2 backup — both documented at docs.solapayments.com/api/transaction.
// gatewayjson accepts and returns JSON (vs. the form/xml variants), the
// natural fit for a Node/Express app.
const GATEWAY_URL = 'https://x1.cardknox.com/gatewayjson';
const SOFTWARE_NAME = 'EverythingShul-eCards';
const SOFTWARE_VERSION = '1.0';
const API_VERSION = '5.0.0';

export function isSolaMockMode() { return !CONFIG.transactionKey; }
export function solaIfieldsKey() { return CONFIG.ifieldsKey; }
export function solaConfigStatus() { return { mockMode: isSolaMockMode(), hasIfieldsKey: !!CONFIG.ifieldsKey }; }

async function post(fields) {
  const body = { xKey: CONFIG.transactionKey, xVersion: API_VERSION, xSoftwareName: SOFTWARE_NAME, xSoftwareVersion: SOFTWARE_VERSION, ...fields };
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return data;
}

// One-shot sale (auth + capture combined — xCommand: cc:Sale). xCardNum/
// xCVV here are the single-use TOKENS from iFields, not real card data — see
// the file-level comment above. Returns the Sola reference number
// (xRefNum), which is what a later refund/void must be linked to.
export async function chargeSale({ amount, xCardNum, xCVV, invoice, description }) {
  if (isSolaMockMode()) {
    return { approved: true, refNum: `mock_${Date.now()}`, authCode: 'MOCK00', maskedCardNumber: '************1234', mock: true };
  }
  const data = await post({
    xCommand: 'cc:Sale', xAmount: amount.toFixed(2), xCardNum, xCVV,
    xInvoice: invoice || '', xDescription: description || '',
  });
  if (data.xResult !== 'A') {
    return { approved: false, error: data.xError || data.xStatus || 'Card declined', refNum: data.xRefNum || null };
  }
  return { approved: true, refNum: data.xRefNum, authCode: data.xAuthCode, maskedCardNumber: data.xMaskedCardNumber || null, mock: false };
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
