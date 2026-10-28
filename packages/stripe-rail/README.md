# @mandate/stripe-rail

The Stripe Shared Payment Token rail behind the TapVow gateway. Agents never hold a Stripe key. The gateway checks a granted SPT against the same signed mandate, budget store and ledger as the llm and x402 rails, reserves the amount atomically, and books the real PaymentIntent in the signed hash chain.

When a Stripe charge cannot be confirmed, for example after a timeout or a server error, the rail keeps the full reserved amount committed against the mandate budget and marks the settlement as unconfirmed. Nothing yet calls a reconcile path that would ask Stripe what really happened and then release or settle that amount, so an unconfirmed Stripe charge keeps its budget until a later reconcile, and that reconcile is not built yet.
