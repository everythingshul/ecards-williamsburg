// ---------------------------------------------------------------------------
// Stripe — card/debit payments only for now (ACH deferred to a later pass,
// see CLAUDE.md). MOCK MODE (no real charges, a fake client_secret so the
// whole embedded-Elements flow is testable end to end) until
// STRIPE_SECRET_KEY is set in the deploy environment — same pattern as
// every other integration in this app (Brevo, disccardpromos, SimpleSender).
// STRIPE_PUBLISHABLE_KEY is safe to expose to the frontend (see /api/config
// in index.js). STRIPE_WEBHOOK_SECRET verifies that a webhook call actually
// came from Stripe (routes/shulPayments.js's POST /stripe/webhook).
// ---------------------------------------------------------------------------

import Stripe from 'stripe';

const CONFIG = {
  secretKey: process.env.STRIPE_SECRET_KEY || '',
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
};

export function isStripeMockMode() { return !CONFIG.secretKey; }
export function stripePublishableKey() { return CONFIG.publishableKey; }
export function stripeConfigStatus() { return { mockMode: isStripeMockMode(), hasWebhookSecret: !!CONFIG.webhookSecret }; }

let stripeClient = null;
function client() {
  if (!stripeClient) stripeClient = new Stripe(CONFIG.secretKey, { apiVersion: '2024-06-20' });
  return stripeClient;
}

// One PaymentIntent per shul payment attempt. metadata carries everything
// the webhook needs to create the matching shul_payments row without a
// second round trip — Stripe echoes metadata back on every event for this
// intent. Card/debit only (payment_method_types) — no redirect-based
// methods, so the embedded Payment Element never leaves the page.
export async function createPaymentIntent({ amountCents, shulId, seasonId, orgId, userId }) {
  if (isStripeMockMode()) {
    const id = `pi_mock_${Date.now()}`;
    return { id, client_secret: `${id}_secret_mock`, mock: true };
  }
  return client().paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    payment_method_types: ['card'],
    metadata: { shulId, seasonId, orgId, userId: userId || '' },
  });
}

// The REAL fee Stripe took, from the settled charge's own balance
// transaction — not an approximated formula — so shul_payments.fee_amount
// reflects what Stripe actually charged for that specific payment method/
// card type. Only meaningful once the PaymentIntent has succeeded, i.e.
// called from the webhook handler.
export async function getPaymentIntentFee(paymentIntentId) {
  if (isStripeMockMode()) return 0;
  const intent = await client().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] });
  const fee = intent.latest_charge?.balance_transaction?.fee;
  return fee != null ? fee / 100 : 0;
}

// Verifies a webhook call actually came from Stripe (signed with
// STRIPE_WEBHOOK_SECRET) using the exact raw request bytes — see
// index.js's express.json({ verify }) for where req.rawBody comes from.
export function constructWebhookEvent(rawBody, signature) {
  if (!CONFIG.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  return client().webhooks.constructEvent(rawBody, signature, CONFIG.webhookSecret);
}
