// ---------------------------------------------------------------------------
// UNUSED — kept for reference only. Shul card payments were migrated from
// Stripe to Sola Payments (see services/sola.js); nothing in routes/
// shulPayments.js calls into this file anymore. Historical shul_payments
// rows created while Stripe was live still carry method='stripe_card' and a
// real stripe_payment_intent_id, which is the only reason this file (and
// those two columns) are still around.
//
// Stripe — card/debit payments only (ACH deferred to a later pass, see
// CLAUDE.md). MOCK MODE (no real charges, a fake client_secret so the whole
// embedded-Elements flow was testable end to end) until STRIPE_SECRET_KEY
// was set in the deploy environment — same pattern as every other
// integration in this app (Brevo, disccardpromos, SimpleSender, and now
// Sola). STRIPE_WEBHOOK_SECRET verified that a webhook call actually came
// from Stripe — that webhook route no longer exists (Sola's charge flow is
// synchronous, no webhook needed).
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
