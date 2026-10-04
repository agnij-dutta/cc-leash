// Tool rules: which MCP tools move money, and where their amount / currency /
// payee live in the tool input. Rules are tried in order; first match wins.
//
// Rule shape (see CONTRIBUTING.md for how to add one):
//   id           short name, shown in the ledger and `leash check`
//   match        regex tested against the tool name (and its snake_case form)
//   exclude      optional regex; a matching tool name is NOT a payment
//   amount       candidate paths for the amount; the first one present wins
//   currency     candidate paths for the currency
//   payee        candidate paths for the payee
//   scale        divide the amount by this (e.g. 100 for a cents field)
//   minorUnits   the amount is in the currency's minor unit (Stripe style):
//                divide by 10^exponent, where JPY has 0 decimals, KWD 3, etc.
//
// Path syntax (JSONPath-ish): "amount", "amount.value",
// "purchase_units[0].amount.value". A path starting with "=" is a literal,
// e.g. "=USDC" means "the currency is always USDC for this tool".

const COMMON_AMOUNT = ["amount", "value", "amount_usd", "amountUsd", "price", "total", "sum", "amount.value", "maxAmount", "max_amount"];
const COMMON_CURRENCY = [
  "currency",
  "currency_code",
  "currencyCode",
  "asset",
  "assetId",
  "asset_id",
  "token",
  "symbol",
  "amount.currency",
  "amount.currency_code",
];
const COMMON_PAYEE = [
  "to",
  "payee",
  "recipient",
  "destination",
  "address",
  "toAddress",
  "to_address",
  "payTo",
  "pay_to",
  "merchant",
  "vendor",
  "email",
  "account",
];

// Read-only verbs. A tool whose own name starts with one of these never moves money.
const READ_ONLY =
  "__(get|list|retrieve|search|read|describe|show|check|estimate|quote|calculate|preview|validate|lookup|find|view|cancel|void)(_[a-z0-9_]*)?$|(_status|_history|_balance|_balances|_details|_info|_logs?)$|transfer_(issue|issues|repo|repository|ownership|file|files|project|domain)";

export const DEFAULT_RULES = [
  {
    id: "capline",
    description: "capline-mcp pay (mandate-gated USDC payments)",
    match: "^mcp__.*capline.*__pay$",
    amount: ["amount"],
    currency: ["currency", "=USDC"],
    payee: ["to"],
  },
  {
    id: "fakepay",
    description: "fakepay demo server bundled in examples/",
    match: "^mcp__.*fakepay.*__(pay|refund|send_payment)$",
    amount: ["amount"],
    currency: ["currency", "=USD"],
    payee: ["to", "recipient"],
  },
  {
    id: "stripe",
    description: "Stripe MCP / agent toolkit (amounts are in the currency's minor unit, e.g. cents)",
    match:
      "^mcp__.*stripe.*__(create_refund|create_payment_intent|confirm_payment_intent|capture_payment_intent|create_charge|create_payout|create_transfer|create_payment_link|finalize_invoice|pay_invoice|send_invoice|create_invoice_item)$",
    amount: ["amount", "unit_amount", "amount_cents"],
    minorUnits: true,
    currency: ["currency", "=USD"],
    payee: ["destination", "customer", "payment_intent", "charge", "invoice", "price"],
  },
  {
    id: "paypal",
    description: "PayPal MCP (orders, payouts, refunds, invoices)",
    match:
      "^mcp__.*paypal.*__(create_order|capture_order|pay_order|authorize_order|create_refund|create_payout|send_invoice|create_invoice|create_subscription)$",
    amount: ["amount.value", "purchase_units[0].amount.value", "amount", "total", "value"],
    currency: ["amount.currency_code", "purchase_units[0].amount.currency_code", "currency_code", "currency", "=USD"],
    payee: ["recipient_email", "receiver", "payee.email_address", "recipient", "items[0].recipient_email", "recipient_email_address"],
  },
  {
    id: "wallet",
    description: "Coinbase AgentKit / CDP / generic EVM + Solana wallet transfer tools",
    match: "^mcp__.*(agentkit|coinbase|cdp|wallet|evm|solana|onchain|crypto).*__(.*_)?(transfer|send|trade|swap|pay|withdraw|bridge)(_.*)?$",
    exclude: READ_ONLY,
    amount: ["amount", "value", "amount_in", "amountIn", "fromAmount", "from_amount", "quantity"],
    currency: ["assetId", "asset_id", "token", "tokenSymbol", "currency", "asset", "fromAssetId", "from_asset_id", "symbol", "mint"],
    payee: ["destination", "to", "recipient", "address", "toAddress", "to_address"],
  },
  {
    id: "x402",
    description: "x402 pay-per-request tools (paid fetch / pay_for)",
    match: "^mcp__.*__(.*_)?(x402|pay_for|paid_fetch|fetch_with_payment|make_payment|pay_request)(_.*)?$",
    exclude: READ_ONLY,
    amount: ["amount", "maxAmount", "max_amount", "maxPaymentAmount", "max_payment", "price"],
    currency: ["currency", "asset", "token", "=USDC"],
    payee: ["payTo", "pay_to", "to", "recipient", "url", "resource"],
  },
  {
    id: "generic",
    description: "Fallback: any MCP tool whose name looks like it moves money",
    match:
      "^mcp__.*__(.*_)?(pay|payment|payments|transfer|payout|payouts|refund|charge|withdraw|withdrawal|purchase|checkout|tip|donate|send_(money|funds|usdc|usdt|eth|sol|btc|token|tokens|crypto|transaction))(_.*)?$",
    exclude: READ_ONLY,
    amount: COMMON_AMOUNT,
    currency: COMMON_CURRENCY,
    payee: COMMON_PAYEE,
  },
];

// Stripe's zero-decimal and three-decimal currencies
// (https://docs.stripe.com/currencies#zero-decimal). Everything else is
// treated as two decimals. Getting this wrong understates a JPY charge 100x.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Number of minor-unit decimals for a currency code (2 unless known otherwise). */
export function minorUnitExponent(currency) {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

const SYMBOLS = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };

/**
 * Read a value from a tool input by path ("a.b[0].c"), or return the literal
 * after "=" for paths like "=USD". JSON-encoded string arguments are parsed
 * on the way down. Returns undefined when the path is absent.
 */
export function getPath(obj, path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (path.startsWith("=")) return path.slice(1);
  const parts = [];
  for (const seg of path.split(".")) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(seg))) parts.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === "string") {
      // Some MCP tools take a JSON-encoded string argument.
      try {
        cur = JSON.parse(cur);
      } catch {
        return undefined;
      }
    }
    cur = cur[p];
  }
  return cur;
}

/**
 * Parse an amount value: 500, "500", "$1,250.50", "12.5 USDC" or
 * {value, currency_code}. Returns {amount, currency} or null when the value is
 * not a recognizable amount (null means "unknown", which the engine escalates).
 */
export function parseAmount(v) {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? { amount: v, currency: null } : null;
  if (typeof v === "object") {
    const inner = v.value ?? v.amount;
    const r = parseAmount(inner);
    if (!r) return null;
    const cur = v.currency_code ?? v.currency ?? v.currencyCode ?? null;
    return { amount: r.amount, currency: cur ? normCurrency(cur) : r.currency };
  }
  if (typeof v !== "string") return null;
  const m = /^\s*([$€£¥₹])?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+)\s*([A-Za-z]{3,6})?\s*$/.exec(v);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const currency = m[3] ? normCurrency(m[3]) : m[1] ? SYMBOLS[m[1]] : null;
  return { amount, currency };
}

/**
 * Canonical currency code: symbols map to ISO codes, short codes are
 * upper-cased, and long identifiers (token mints, contract addresses) are kept
 * verbatim because they are case-sensitive.
 */
export function normCurrency(c) {
  if (c === null || c === undefined) return null;
  const s = String(c).trim();
  if (!s) return null;
  if (Object.hasOwn(SYMBOLS, s)) return SYMBOLS[s];
  // Long identifiers (token mints, contract addresses) are kept verbatim.
  if (s.length > 12) return s;
  return s.toUpperCase();
}

/**
 * Pre-compile rule regexes. A rule with a missing or invalid regex is dropped;
 * policy validation reports those before they get here, so this only guards
 * against a bad built-in.
 */
export function compileRules(rules) {
  const out = [];
  for (const r of rules || []) {
    if (!r || typeof r.match !== "string") continue;
    try {
      out.push({
        ...r,
        _re: new RegExp(r.match, "i"),
        _ex: r.exclude ? new RegExp(r.exclude, "i") : null,
      });
    } catch {
      // Unreachable for validated policies; never take the hook down.
    }
  }
  return out;
}

// "mcp__pay-svc__sendPayment" -> "mcp__pay_svc__send_payment", so word-boundary
// rules work for camelCase and kebab-case tool names too.
export function normToolName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/**
 * First rule whose `match` hits the tool name (raw or snake_cased) and whose
 * `exclude` does not. `ignore` regexes win over every rule. Null = not a payment.
 */
export function matchRule(compiled, toolName, ignore = []) {
  const names = [toolName, normToolName(toolName)];
  const hit = (re) => names.some((n) => re.test(n));
  for (const pat of ignore) {
    try {
      if (hit(new RegExp(pat, "i"))) return null;
    } catch {
      /* skip */
    }
  }
  for (const r of compiled) {
    if (hit(r._re) && !(r._ex && hit(r._ex))) return r;
  }
  return null;
}

function first(input, paths) {
  for (const p of paths || []) {
    const v = getPath(input, p);
    if (v !== undefined && v !== null && v !== "") return { value: v, path: p };
  }
  return null;
}

/**
 * Pull amount (in major units), currency and payee out of a tool input using
 * a rule. Any field that can't be found is null; the engine decides what an
 * unknown means (by default: ask the user).
 * @returns {{amount: number|null, currency: string|null, payee: string|null, amountPath: string|null}}
 */
export function extract(rule, input) {
  /** @type {{amount: number|null, currency: string|null, payee: string|null, amountPath: string|null}} */
  const res = { amount: null, currency: null, payee: null, amountPath: null };
  const a = first(input, rule.amount);
  const parsed = a ? parseAmount(a.value) : null;
  if (a && parsed) {
    res.amountPath = a.path;
    if (parsed.currency) res.currency = parsed.currency;
  }
  if (!res.currency) {
    const c = first(input, rule.currency);
    if (c && (typeof c.value === "string" || typeof c.value === "number")) res.currency = normCurrency(c.value);
  }
  if (parsed) {
    // Currency is resolved first because minor units depend on it.
    let divisor = Number(rule.scale) > 0 ? Number(rule.scale) : 1;
    if (rule.minorUnits) divisor *= 10 ** minorUnitExponent(res.currency);
    res.amount = parsed.amount / divisor;
  }
  const p = first(input, rule.payee);
  if (p) res.payee = typeof p.value === "string" ? p.value : JSON.stringify(p.value);
  return res;
}
