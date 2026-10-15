import { env } from "cloudflare:workers";
import { veld, winstUitOrders, normTransacties, type Tx, type Winst } from "./reken";

const E = env as unknown as Record<string, string | undefined>;

export type BillitCfg = { key: string; partyId?: string; base: string };

// Standaard: één gedeelde BILLIT_KEY met per BV de PartyID in BILLIT_PARTYID_n.
// Een aparte sleutel per BV kan ook met BILLIT_KEY_n.
export function cfgVoor(n: number): BillitCfg | null {
  const key = E[`BILLIT_KEY_${n}`] ?? E.BILLIT_KEY;
  if (!key) return null;
  return {
    key,
    partyId: E[`BILLIT_PARTYID_${n}`] || undefined,
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

export async function winstVoorJaar(cfg: BillitCfg, jaar: number): Promise<Winst> {
  const orders = await alle(
    cfg,
    "/v1/orders" + q(`OrderDate ge datetime'${jaar}-01-01' and OrderDate le datetime'${jaar}-12-31'`),
  );
  return winstUitOrders(orders);
}

// Banktransacties na een datum (YYYY-MM-DD).
export async function transactiesVanaf(cfg: BillitCfg, vanaf: string): Promise<Tx[]> {
  return normTransacties(await alle(cfg, "/v1/financialTransactions" + q(`ValueDate gt datetime'${vanaf}'`)));
}

// Ruwe voorbeelden, om veldnamen na te kijken (pagina /billit-test).
export async function voorbeeld(cfg: BillitCfg, paden = ["/v1/orders?$top=2", "/v1/financialTransactions?$top=2"]) {
  const uit: Record<string, unknown> = {};
  for (const pad of paden) {
    try { uit[pad] = await get(cfg, pad); } catch (e) { uit[pad] = String(e); }
  }
  return uit;
}
