import orders from "../orders.json" with { type: "json" };

// Trivial tier: no LLM. Pure regex/keyword matching against the query text.
// Returns { matched, orderId, intent, response } — matched=false means the
// code path declines to handle it (would fall through to the next tier).

const ORDER_ID_RE = /\b(1\d{4})\b/;
const CANCEL_RE = /\bcancel\b/i;
const TRACK_RE = /\b(where|track|status|arrive|when will)\b/i;

export function runIntentMatcher(queryText) {
  const idMatch = queryText.match(ORDER_ID_RE);
  if (!idMatch) return { matched: false, reason: "no_order_id_found" };
  const orderId = idMatch[1];

  let intent = null;
  if (CANCEL_RE.test(queryText)) intent = "cancel_order";
  else if (TRACK_RE.test(queryText)) intent = "track_order";

  if (!intent) return { matched: false, reason: "no_intent_keyword_found", orderId };

  const order = orders[orderId];
  if (!order) {
    // Code path "grabs" the query (has an order id + intent keyword) but the
    // order doesn't exist — this is the false-claim case S2 is measuring.
    return {
      matched: true,
      orderId,
      intent,
      response: `Order ${orderId} not found in our system.`,
      correct: true, // "not found" IS the correct answer here
    };
  }

  if (intent === "track_order") {
    return {
      matched: true,
      orderId,
      intent,
      response: `Order ${orderId} is ${order.status}${
        order.delivered_days_ago != null ? ` (delivered ${order.delivered_days_ago} days ago)` : ""
      }.`,
    };
  }

  if (intent === "cancel_order") {
    if (order.status === "processing") {
      return {
        matched: true,
        orderId,
        intent,
        response: `Order ${orderId} has been cancelled.`,
      };
    }
    return {
      matched: true,
      orderId,
      intent,
      response: `Order ${orderId} has already shipped/delivered and cannot be cancelled through this channel.`,
    };
  }

  return { matched: false, reason: "unhandled_intent" };
}
