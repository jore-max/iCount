import { env } from "cloudflare:workers";
import { veld, winstUitOrders, openstaandUitOrders, type Openstaand, normTransacties, type Tx, type Winst, type InterneLeverancier } from "./reken";

const E = env as unknown as Record<string, string | undefined>;

export type BillitCfg = { key: string; partyId?: string; base: string };

// Standaard: één gedeelde BILLIT_KEY met per BV de PartyID in BILLIT_PARTYID_n.
// Een aparte sleutel per BV kan ook met BILLIT_KEY_n.
export function cfgVoor(n: number): BillitCfg | null {
  const eigen = E[`BILLIT_KEY_${n}`];
  const partyId = E[`BILLIT_PARTYID_${n}`] || undefined;
  // met de gedeelde sleutel is een PartyID nodig, anders weet Billit niet welke BV
  const key = eigen ?? (partyId ? E.BILLIT_KEY : undefined);
  if (!key) return null;
  return {
    key,
    partyId,
    base: (E.BILLIT_BASE || "https://api.billit.be").replace(/\/$/, ""),
  };
}

async function get(cfg: BillitCfg, url: string): Promise<any> {
  const headers: Record<string, string> = { ApiKey: cfg.key, Accept: "application/json" };
  if (cfg.partyId) headers.PartyID = cfg.partyId;
  const res = await fetch(url.startsWith("http") ? url : cfg.base + url, { headers });
  if (!res.ok) throw new Error(`Billit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Haalt alle pagina's op (Billit geeft max. 120 per pagina en een NextPageLink).
async function alle(cfg: BillitCfg, pad: string, maxPaginas = 100): Promise<any[]> {
  const items: any[] = [];
  let url: string | undefined = pad;
  for (let p = 0; url && p < maxPaginas; p++) {
    const body = await get(cfg, url);
    const pagina: any[] = Array.isArray(body) ? body : veld(body, "Items", "value") ?? [];
    items.push(...pagina);
    url = Array.isArray(body) ? undefined : veld(body, "NextPageLink", "NextPageUrl", "@odata.nextLink");
  }
  return items;
}

const q = (filter: string) => "?$filter=" + encodeURIComponent(filter);

export async function winstVoorJaar(cfg: BillitCfg, jaar: number, intern?: InterneLeverancier): Promise<Winst> {
  const orders = await alle(
    cfg,
    "/v1/orders" + q(`OrderDate ge datetime'${jaar}-01-01' and OrderDate le datetime'${jaar}-12-31'`),
  );
  return winstUitOrders(orders, intern);
}

// Onbetaalde verkoopfacturen, ongeacht het jaar. Lukt de filter op Paid niet, dan de facturen
// van vorig en dit jaar (ook dan telt Paid per factuur).
export async function openstaandeVerkoop(cfg: BillitCfg): Promise<Openstaand> {
  let orders: any[];
  let filter = "Paid eq false";
  try {
    orders = await alle(cfg, "/v1/orders" + q("OrderDirection eq 'Income' and Paid eq false"));
  } catch (e) {
    const vanaf = new Date().getFullYear() - 1;
    filter = `vanaf ${vanaf} (${e instanceof Error ? e.message.slice(0, 120) : e})`;
    orders = await alle(cfg, "/v1/orders" + q(`OrderDirection eq 'Income' and OrderDate ge datetime'${vanaf}-01-01'`));
  }
  const o = openstaandUitOrders(orders);
  return { ...o, detail: { ...o.detail, filter } };
}

export type Bedrijf = { naam: string; btw: string };

const bedrijfUit = (o: any): Bedrijf => ({
  naam: String(veld(o, "CommercialName", "CompanyName", "DisplayName", "Name") ?? "").trim(),
  btw: String(veld(o, "VATNumber", "VatNumber", "VAT") ?? "").trim(),
});

// Zoekt in een willekeurig Billit-antwoord het object met deze PartyID.
function zoekParty(o: any, partyId: string): any {
  if (!o || typeof o !== "object") return null;
  if (!Array.isArray(o) && String(veld(o, "PartyID", "PartyId", "ID") ?? "") === partyId) return o;
  for (const v of Object.values(o)) {
    const r = zoekParty(v, partyId);
    if (r) return r;
  }
  return null;
}

// Naam en btw-nummer van het bedrijf zelf (de PartyID van deze BV), uit Billit.
export async function eigenBedrijf(cfg: BillitCfg): Promise<Bedrijf> {
  const leeg = { naam: "", btw: "" };
  if (!cfg.partyId) return leeg;
  let b = leeg;
  try {
    // accountInformation somt de bedrijven van de gebruiker op
    const info = await get({ ...cfg, partyId: undefined }, "/v1/account/accountInformation");
    const p = zoekParty(info, cfg.partyId);
    if (p) b = bedrijfUit(p);
  } catch {}
  if (b.naam && b.btw) return b;
  try {
    const p = bedrijfUit(await get(cfg, `/v1/parties/${cfg.partyId}`));
    b = { naam: b.naam || p.naam, btw: b.btw || p.btw };
  } catch {}
  return b;
}

// Banktransacties na een datum (YYYY-MM-DD).
export async function transactiesVanaf(cfg: BillitCfg, vanaf: string): Promise<Tx[]> {
  return normTransacties(await alle(cfg, "/v1/financialTransactions" + q(`ValueDate gt datetime'${vanaf}'`)));
}

// Controle of de banktransacties uit Billit herkend worden: de laatste 14 dagen, ruw en genormaliseerd.
export async function transactieCheck(cfg: BillitCfg): Promise<Record<string, unknown>> {
  const vanaf = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const ruw = await alle(cfg, "/v1/financialTransactions" + q(`ValueDate gt datetime'${vanaf}'`), 5);
  const tx = normTransacties(ruw);
  return { vanaf, ruw: ruw.length, herkend: tx.length, ibans: [...new Set(tx.map((t) => t.iban))], velden: ruw[0] ? Object.keys(ruw[0]) : [], voorbeeld: ruw[0] ?? null, eersteTx: tx.slice(0, 3) };
}

// Ruwe voorbeelden, om veldnamen na te kijken (pagina /billit-test).
export async function voorbeeld(cfg: BillitCfg, paden = ["/v1/orders?$top=2", "/v1/financialTransactions?$top=2"]) {
  const uit: Record<string, unknown> = {};
  for (const pad of paden) {
    try { uit[pad] = await get(cfg, pad); } catch (e) { uit[pad] = String(e); }
  }
  return uit;
}
