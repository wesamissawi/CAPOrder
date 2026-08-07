// Tax-in ("taxes in") quoting.
//
// Customers ask what a part costs with the tax already on it — "that rotor is
// $100 taxes in" — so the number that gets typed is the TOTAL, and the sell
// price stored on the item is what's left once the tax is backed out. The
// customer then gets two pieces of paper: a Quotation showing $100, and later a
// Sales Order showing $88.50 + HST. They will lay them side by side, so the two
// totals have to agree to the penny.
//
// That agreement is the reason this math lives in one file. The Quotation's
// total is not computed from the tax-in numbers in its own rows — it IS the
// sales order's total, and the rows are fitted to it. Recomputing either side
// independently is exactly how the two papers end up a cent apart.
//
// Sell prices are stored to FOUR decimals, not two, and that is load-bearing.
// $100 taxes in backs out to $88.4956. Rounded to $88.50 it grosses back up to
// $100.01 — and at two decimals that happens to 60% of whole-dollar quotes, by
// as much as three cents once quantity multiplies it up. At four decimals it's
// 1% and never more than a penny, so "$100 taxes in" actually prints $100.
// Sage accepts four-decimal prices, which is what makes this available.
//
// The visible cost: a sales order line for 3 @ $88.4956 shows a $265.49
// extension, which is a cent off the $88.50 unit price beside it times three.
// Hence `formatUnitPrice` below — unit prices print their real precision rather
// than a rounded figure that doesn't multiply out.

export const DEFAULT_TAX_RATE = 0.13;

// Money that a customer adds up stays at two decimals — extensions, subtotals,
// tax, totals. Only the unit price carries more.
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const formatMoney = (n) => `$${round2(n).toFixed(2)}`;

// Two decimals minimum so prices read as money, up to four when the extra
// precision is really there — "88.4956", but "44.25" rather than "44.2500".
export function formatPrice(n) {
  const v = round4(n);
  const s = v.toFixed(4).replace(/0+$/, "");
  return s.endsWith(".") || s.split(".")[1].length < 2 ? v.toFixed(2) : s;
}

// What the customer says ⇄ what gets stored. Both per-unit: quoting "$100" on a
// qty-3 line means $100 each — $300 for the line — never $33.33.
export const taxInToPretax = (taxIn, taxRate = DEFAULT_TAX_RATE) =>
  round4(num(taxIn) / (1 + num(taxRate)));

// Back the other way for display, where it's a figure someone reads off a
// screen rather than one that feeds another calculation.
export const pretaxToTaxIn = (pretax, taxRate = DEFAULT_TAX_RATE) =>
  round2(num(pretax) * (1 + num(taxRate)));

// The sales order's own footer arithmetic, extracted so the quote can be pinned
// to it. Rows are `{ extension, taxable }` — the shape InvoicePreview already
// builds for both items and extra lines.
export function computeDocumentTotals(rows, taxRate = DEFAULT_TAX_RATE) {
  const rate = num(taxRate);
  let subtotal = 0;
  let taxableBase = 0;
  (rows || []).forEach((r) => {
    const ext = num(r?.extension);
    subtotal += ext;
    if (r?.taxable !== false) taxableBase += ext;
  });
  const roundedSubtotal = round2(subtotal);
  const tax = round2(taxableBase * rate);
  return {
    subtotal: roundedSubtotal,
    taxableBase: round2(taxableBase),
    tax,
    total: round2(roundedSubtotal + tax),
  };
}

// Restates each row tax-in for the Quotation. Non-taxable extra lines are
// carried across untouched — no tax was charged on them, so there's none to
// fold in.
//
// The per-row roundings can miss the document total by a cent or two, so the
// last row absorbs the difference. Same remainder-absorption Cash Sales uses
// when it spreads a payment across parts: the column has to add up to the
// number printed underneath it.
export function computeQuoteRows(rows, taxRate = DEFAULT_TAX_RATE) {
  const rate = num(taxRate);
  const totals = computeDocumentTotals(rows, rate);
  const quoted = (rows || []).map((r) =>
    round2(r?.taxable === false ? num(r?.extension) : num(r?.extension) * (1 + rate))
  );
  if (quoted.length) {
    const drift = round2(totals.total - quoted.reduce((sum, v) => sum + v, 0));
    const last = quoted.length - 1;
    quoted[last] = round2(quoted[last] + drift);
  }
  return {
    rows: (rows || []).map((r, i) => {
      const qty = num(r?.qty);
      return {
        ...r,
        quoteExtension: quoted[i],
        // Derived from the fitted extension rather than grossed up on its own,
        // so unit × qty reads back as the extension beside it. On the one row
        // that absorbed the drift and has qty > 1 they can sit a cent apart —
        // unavoidable while unit prices print to two decimals.
        quoteUnit: qty > 0 ? round2(quoted[i] / qty) : quoted[i],
      };
    }),
    ...totals,
  };
}

// "Make it 240 even" on a $243 quote. `discount` is tax-in dollars off the
// printed total — that's how it's said out loud and how it's shown on the
// Quotation, so it's how it's stored.
export function applyQuoteDiscount(totals, discount) {
  const gross = num(totals?.total);
  const d = Math.max(0, round2(discount));
  return { gross, discount: d, net: round2(gross - d) };
}

// Pushes an accepted discount down into the individual sell prices, so the
// Sales Order's own footer lands on the discounted total without the word
// "discount" appearing on it — the customer agreed to a price for the job, and
// the paperwork should just say that price. (The Quotation still shows the
// discount on its own line; only this side absorbs it.)
//
// Spread across the lines rather than parked on one, because of returns. A
// customer who brings back everything but one part gets refunded whatever those
// parts were invoiced at — so if the concession sat on the part they KEPT, the
// refund goes out at full price against a total you discounted, and you eat the
// difference. Sharing it out means any subset coming back refunds exactly what
// that subset was invoiced, with no combination that can strand you.
//
// The share is taken out of MARGIN, not price: a line gives up in proportion to
// what it makes (price − cost), so thin-margin lines barely move and fat ones
// carry the deal. That also makes the cost floor automatic — a line can never
// give up more than it had — instead of a clamp bolted on afterwards.
//
// A line with no cost recorded gives up nothing. Its margin is unknown, not
// zero, and guessing wrong there is how a part ends up sold under water.
//
// Extra lines are left alone: they're print-only rows that exist on the sheet
// and nowhere else, so there is no stored price on them to reduce. The whole
// discount therefore comes out of the parts.
//
// Returns `{ ok, updates, ... }` rather than writing anything — the caller owns
// the confirm and the writes.
export function computeDiscountedItemPrices(
  items,
  extraLines,
  discount,
  taxRate = DEFAULT_TAX_RATE
) {
  const rate = num(taxRate);
  const d = round2(discount);
  if (!(d > 0)) return { ok: false, error: "Enter a discount above zero." };

  const itemRows = (items || []).map((it) => {
    // An absent cost is unknown, not free — distinguished on the raw string,
    // since Number("") is 0 and would read as a 100%-margin part.
    const rawCost = String(it.cost ?? "").trim();
    const hasCost = rawCost !== "" && Number.isFinite(Number(rawCost));
    return {
      uid: it.uid,
      qty: num(it.quantity),
      unit: num(it.allocated_for),
      hasCost,
      cost: hasCost ? num(rawCost) : null,
    };
  });
  const extraRows = (extraLines || []).map((l) => ({
    extension: num(l.quantity) * num(l.unitPrice),
    taxable: l.taxable !== false,
  }));

  const rowsFor = (rs) => [
    ...rs.map((r) => ({ extension: r.qty * r.unit, taxable: true })),
    ...extraRows,
  ];
  const before = computeDocumentTotals(rowsFor(itemRows), rate);
  const target = round2(before.total - d);
  if (target <= 0) return { ok: false, error: "That discount is larger than the order." };

  // Only lines actually carrying money can give any up. A zero-priced part has
  // nothing to prorate against and stays as it is.
  const priced = itemRows.filter((r) => r.qty > 0 && r.unit > 0);
  if (!priced.length)
    return { ok: false, error: "Nothing on this order is priced, so there's nothing to discount." };

  // What each line could give up before it hit its own cost, and what the whole
  // order could. A line already at or under cost has nothing left.
  const marginOf = (r) => (r.hasCost ? Math.max(0, r.qty * (r.unit - r.cost)) : 0);
  const marginPool = priced.reduce((sum, r) => sum + marginOf(r), 0);
  const noCostCount = priced.filter((r) => !r.hasCost).length;

  // The discount is quoted tax-in, so the pretax room it needs is that much
  // less.
  const reduction = d / (1 + rate);

  if (marginPool <= 0) {
    return {
      ok: false,
      error: noCostCount === priced.length
        ? "No cost is recorded against these parts, so there's no margin to take a discount out of. Add costs, or drop the prices by hand."
        : "These parts are already at or below cost — there's no margin left to discount.",
    };
  }
  if (reduction > marginPool) {
    // Hard floor: nothing gets sold under cost to make a deal fit. Stating the
    // ceiling is the useful half — it turns a refusal into the next offer.
    const maxDiscount = Math.floor(marginPool * (1 + rate) * 100) / 100;
    return {
      ok: false,
      error:
        `That would push parts below cost. This order carries ${formatMoney(marginPool)} of ` +
        `margin, so the most you can take off is ${formatMoney(maxDiscount)} taxes in.` +
        (noCostCount
          ? `\n\n${noCostCount} part${noCostCount === 1 ? " has" : "s have"} no cost recorded and ` +
            `${noCostCount === 1 ? "was" : "were"} left out of that — adding ${noCostCount === 1 ? "it" : "them"} may give you more room.`
          : ""),
      maxDiscount,
    };
  }

  // Each line gives up its share OF THE MARGIN. Because every share is capped
  // by the line's own margin and the pool covers the reduction, no line can
  // cross its cost — the floor falls out of the arithmetic rather than being
  // clamped on top.
  const next = new Map();
  let remaining = reduction;
  const givers = priced.filter((r) => marginOf(r) > 0);
  givers.forEach((r, idx) => {
    const share = idx === givers.length - 1 ? remaining : reduction * (marginOf(r) / marginPool);
    const unit = round4(Math.max(r.hasCost ? r.cost : 0, r.unit - share / r.qty));
    remaining -= (r.unit - unit) * r.qty;
    next.set(r.uid, unit);
  });

  const withPrices = () => itemRows.map((r) => ({ ...r, unit: next.has(r.uid) ? next.get(r.uid) : r.unit }));
  const totalNow = () => computeDocumentTotals(rowsFor(withPrices()), rate).total;
  const floorOf = (uid) => {
    const r = priced.find((x) => x.uid === uid);
    return r && r.hasCost ? r.cost : 0;
  };

  // Rounding the unit prices can still leave the document a cent off target.
  // Nudge one line by exactly the amount that closes the gap — solved for
  // rather than stepped, since at four decimals a fixed step would take
  // hundreds of passes. The absorber is the line with the most margin left, so
  // the correction has somewhere to go without touching the cost floor. Stops
  // as soon as a pass stops improving, so a target that two-decimal EXTENSIONS
  // can't express settles at the closest reachable figure instead of
  // oscillating.
  const absorber = givers.reduce(
    (best, r) => {
      const room = (next.get(r.uid) - floorOf(r.uid)) * r.qty;
      return room > best.room ? { r, room } : best;
    },
    { r: givers[0], room: -Infinity }
  ).r;
  for (let guard = 0; guard < 6; guard += 1) {
    const diff = round2(target - totalNow());
    if (diff === 0) break;
    const restore = next.get(absorber.uid);
    const candidate = round4(restore + diff / (absorber.qty * (1 + rate)));
    if (candidate < floorOf(absorber.uid)) break;
    next.set(absorber.uid, candidate);
    if (Math.abs(round2(target - totalNow())) >= Math.abs(diff)) {
      next.set(absorber.uid, restore);
      break;
    }
  }

  const achieved = totalNow();
  const updates = Array.from(next.entries())
    .filter(([uid, unit]) => unit !== priced.find((r) => r.uid === uid).unit)
    .map(([uid, unit]) => ({ uid, allocated_for: formatPrice(unit) }));
  return {
    ok: true,
    updates,
    before: before.total,
    target,
    achieved,
    // Non-zero only when two-decimal extensions can't express the target.
    shortfall: round2(achieved - target),
    basis: "margin",
    marginPool: round2(marginPool),
    marginLeft: round2(marginPool - reduction),
    // Lines deliberately left at full price because their margin is unknown.
    noCostCount,
  };
}
