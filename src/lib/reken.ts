// Pure rekenfuncties (zonder Cloudflare-imports, los te testen).

type Obj = Record<string, any>;

// Billit-velden hoofdletterongevoelig ophalen, met alternatieve namen.
export function veld(o: Obj, ...namen: string[]): any {
  const keys = Object.keys(o ?? {});
  for (const n of namen) {
    const k = keys.find((k) => k.toLowerCase() === n.toLowerCase());
    if (k !== undefined && o[k] !== null && o[k] !== undefined) return o[k];
  }
  return undefined;
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export type Maand = { omzet: number; kosten: number };
export type Winst = {
  omzet: number;
  kosten: number;
  winst: number;
  facturen: number;
  maanden: Maand[];
  intern: number; // aankoopfacturen van een eigen BV die buiten de winst blijft, niet in `kosten`
};

// Een eigen BV die factureert aan de andere (bv. Jove): op btw-nummer of naam herkennen.
export type InterneLeverancier = { btw: string[]; namen: string[] };

// BE0123.456.789 -> 123456789 (voorloopnullen weg, zodat BE0... en 0... gelijk zijn)
export const normBtw = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
const normNaam = (v: unknown) =>
  String(v ?? "").toLowerCase().replace(/\b(bv|bvba|nv|srl|sprl)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function isIntern(o: Obj, intern: InterneLeverancier): boolean {
  const cp = veld(o, "CounterParty", "Counterparty") ?? {};
  const btw = normBtw(veld(cp, "VATNumber", "VatNumber", "VAT", "EnterpriseNumber"));
  if (btw && intern.btw.some((b) => normBtw(b) === btw)) return true;
  const naam = normNaam(veld(cp, "DisplayName", "Name", "CommercialName") ?? veld(o, "CounterPartyName", "SupplierName", "PartyName"));
  return !!naam && intern.namen.some((n) => normNaam(n) !== "" && naam.includes(normNaam(n)));
}

// Winst = verkoopfacturen - verkoopcreditnota's - aankoopfacturen + aankoopcreditnota's (excl. btw, zonder ontwerpen),
// ook per maand (index 0 = januari) op basis van OrderDate.
// Aankopen bij een interne leverancier tellen niet als kost (ze staan apart in `intern`).
export function winstUitOrders(orders: Obj[], intern: InterneLeverancier = { btw: [], namen: [] }): Winst {
  let omzet = 0, kosten = 0, facturen = 0, internTotaal = 0;
  const maanden: Maand[] = Array.from({ length: 12 }, () => ({ omzet: 0, kosten: 0 }));
  for (const o of orders) {
    const type = String(veld(o, "OrderType") ?? "").toLowerCase();
    const credit = type.includes("credit");
    if (!credit && type !== "invoice") continue; // offertes, bestelbonnen, ... tellen niet
    if (/draft|concept/i.test(String(veld(o, "OrderStatus") ?? ""))) continue; // ontwerpen tellen niet
    const richting = String(veld(o, "OrderDirection") ?? "").toLowerCase();
    const bedrag = Math.abs(num(veld(o, "TotalExcl"))) * (credit ? -1 : 1);
    const m = new Date(String(veld(o, "OrderDate") ?? "")).getMonth();
    const maand = Number.isNaN(m) ? null : maanden[m];
    if (richting === "income") { omzet += bedrag; if (maand) maand.omzet += bedrag; }
    else if (richting === "cost") {
      if (isIntern(o, intern)) { internTotaal += bedrag; continue; }
      kosten += bedrag; if (maand) maand.kosten += bedrag;
    }
    else continue;
    facturen++;
  }
  return { omzet, kosten, winst: omzet - kosten, facturen, maanden, intern: internTotaal };
}

// Nog te ontvangen: verkoopfacturen die nog niet (volledig) betaald zijn, incl. btw.
// Per factuur: Paid = true telt niet; anders het openstaande bedrag (ToPay) of het volledige bedrag.
// Creditnota's tellen niet apart: Billit trekt een gekoppelde creditnota al af van wat op de factuur
// nog te betalen is, en de creditnota zelf blijft "onbetaald" staan.
// `vervallen` is het deel waarvan de vervaldag voorbij is. `detail` dient om na te kijken.
export type Openstaand = { bedrag: number; aantal: number; vervallen: number; detail?: Record<string, unknown> };

export function openstaandUitOrders(orders: Obj[], vandaag = new Date().toISOString().slice(0, 10)): Openstaand {
  let bedrag = 0, aantal = 0, vervallen = 0;
  const lijst: unknown[] = [];
  const d = { orders: orders.length, betaald: 0, concept: 0, zonderToPay: 0, totaalIncl: 0, creditnotas: 0, creditBedrag: 0, statussen: {} as Record<string, number> };
  for (const o of orders) {
    const type = String(veld(o, "OrderType") ?? "").toLowerCase();
    const credit = type.includes("credit");
    if (!credit && type !== "invoice") continue;
    if (String(veld(o, "OrderDirection") ?? "").toLowerCase() !== "income") continue;
    const status = String(veld(o, "OrderStatus") ?? "");
    lijst.push([veld(o, "OrderNumber"), type, status, veld(o, "TotalIncl"), veld(o, "ToPay"), veld(o, "Paid"), String(veld(o, "ExpiryDate") ?? "").slice(0, 10), veld(o, "Overdue")]);
    d.statussen[status] = (d.statussen[status] ?? 0) + 1;
    if (/draft|concept/i.test(status)) { d.concept++; continue; }
    const betaald = veld(o, "Paid", "IsPaid");
    if (betaald === true || String(betaald).toLowerCase() === "true") { d.betaald++; continue; }
    const rest = veld(o, "ToPay", "AmountToPay", "OpenAmount", "Outstanding");
    if (credit) { d.creditnotas++; d.creditBedrag += Math.abs(num(rest ?? veld(o, "TotalIncl"))); continue; }
    if (rest === undefined || rest === null) d.zonderToPay++;
    d.totaalIncl += num(veld(o, "TotalIncl"));
    const open = num(rest ?? veld(o, "TotalIncl"));
    if (Math.abs(open) < 0.005) continue;
    bedrag += open;
    aantal++;
    const vervaldag = String(veld(o, "ExpiryDate", "DueDate", "PaymentDueDate") ?? "").slice(0, 10);
    if (vervaldag && vervaldag < vandaag) vervallen += open;
  }
  return { bedrag, aantal, vervallen, detail: { ...d, lijst } };
}

const normIban = (s: any) => String(s ?? "").replace(/\s/g, "").toUpperCase();

export type Tx = { iban: string; datum: string; bedrag: number };

// Billit-banktransacties naar { iban, datum (YYYY-MM-DD), bedrag }.
export function normTransacties(transacties: Obj[]): Tx[] {
  return transacties
    .map((t) => ({
      iban: normIban(veld(t, "IBAN", "BankAccountIBAN", "BankAccountNumber", "AccountNumber", "OwnIBAN")),
      datum: String(veld(t, "ValueDate", "TransactionDate", "Date", "BookingDate") ?? "").slice(0, 10),
      // Billit geeft TotalAmount altijd positief; TransactionType "Debet" is geld dat buitengaat.
      bedrag: /^deb/i.test(String(veld(t, "TransactionType") ?? ""))
        ? -Math.abs(num(veld(t, "TotalAmount", "Amount", "TransactionAmount")))
        : num(veld(t, "TotalAmount", "Amount", "TransactionAmount")),
    }))
    .filter((t) => t.iban);
}

// Huidig saldo = saldo op `datum` + alle transacties op dat IBAN na die datum.
export function mutatieNa(tx: Tx[], iban: string, datum: string): number {
  return tx.filter((t) => t.iban === iban && t.datum > datum).reduce((s, t) => s + t.bedrag, 0);
}

export { normIban };

// "1.234,56", "10.000" of "1234.56" -> getal
export function bedrag(v: unknown): number {
  let s = String(v ?? "").trim().replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export const euro = (n: number) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(n);
