import { env } from "cloudflare:workers";
import { cfgVoor, get, alle, q } from "./billit";
import { laad, overzicht, metBillit, bedrijvenUitBillit } from "./data";
import { veld } from "./reken";

// AI-assistent: een model op Cloudflare Workers AI beantwoordt vragen over Billit en bevraagt daarvoor
// zelf live de Billit-API (enkel lezen). Nodig: de AI-binding in wrangler.jsonc, geen API-sleutel.

const MODEL = "@cf/moonshotai/kimi-k2.6";
const MAX_RONDES = 12; // zoveel keer mag het model na elkaar tools gebruiken per vraag
const MAX_TEKENS = 60_000; // een tool-antwoord wordt ingekort tot dit aantal tekens

export const assistentKlaar = () => !!(env as any).AI;

type Obj = Record<string, any>;
type Tool = { name: string; description: string; input_schema: Obj };

const bvParam = { type: "integer", minimum: 1, maximum: 4, description: "Nummer van de BV (1 t.e.m. 4, zie bedrijven)." };
const datum = (beschrijving: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: beschrijving });

const TOOLS: Tool[] = [
  {
    name: "bedrijven",
    description: "De 4 BV's met nummer, naam, btw-nummer, of ze meetellen in de winst en of Billit gekoppeld is. Gebruik dit eerst om te weten welke BV welk nummer heeft.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "overzicht",
    description: "Dezelfde cijfers als het iCount-dashboard voor een jaar: per BV omzet, kosten, winst (excl. btw, per maand), nog te ontvangen verkoopfacturen en de huidige rekeningsaldi. Jove telt niet mee in de winst; haar facturen aan de andere BV's zitten niet in hun kosten (veld intern).",
    input_schema: {
      type: "object",
      properties: { jaar: { type: "integer", description: "Kalenderjaar, bv. 2026." } },
      required: ["jaar"],
      additionalProperties: false,
    },
  },
  {
    name: "facturen",
    description:
      "Zoekt facturen en creditnota's (ook offertes e.d.) van één BV in Billit, binnen een periode op factuurdatum. Geeft totalen en een lijst met per factuur id, nummer, datum, vervaldag, tegenpartij, type, richting (Income = verkoop, Cost = aankoop), status, bedrag excl./incl. btw, nog te betalen en betaald. Gebruik factuur voor de regels van één factuur.",
    input_schema: {
      type: "object",
      properties: {
        bv: bvParam,
        vanaf: datum("Eerste factuurdatum (YYYY-MM-DD)."),
        tot: datum("Laatste factuurdatum (YYYY-MM-DD)."),
        richting: { type: "string", enum: ["Income", "Cost", "alle"], description: "Income = verkoop, Cost = aankoop." },
        onbetaald: { type: "boolean", description: "Enkel facturen die nog niet betaald zijn." },
        zoek: { type: "string", description: "Tekst om op te filteren (tegenpartij, nummer, referentie, omschrijving). Leeg = alles." },
      },
      required: ["bv", "vanaf", "tot"],
      additionalProperties: false,
    },
  },
  {
    name: "factuur",
    description: "Alle details van één factuur uit Billit, met de factuurregels. Het id komt uit facturen.",
    input_schema: {
      type: "object",
      properties: { bv: bvParam, id: { type: "integer", description: "OrderID uit facturen." } },
      required: ["bv", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "banktransacties",
    description: "Banktransacties van één BV uit Billit binnen een periode (op valutadatum). TotalAmount is altijd positief; TransactionType Debet = geld dat buitengaat, Credit = geld dat binnenkomt.",
    input_schema: {
      type: "object",
      properties: {
        bv: bvParam,
        vanaf: datum("Eerste valutadatum (YYYY-MM-DD)."),
        tot: datum("Laatste valutadatum (YYYY-MM-DD)."),
        zoek: { type: "string", description: "Tekst om op te filteren (naam, mededeling, IBAN). Leeg = alles." },
      },
      required: ["bv", "vanaf", "tot"],
      additionalProperties: false,
    },
  },
  {
    name: "billit_get",
    description:
      "Een willekeurige GET op de Billit-API (enkel lezen) voor wat de andere tools niet dekken, bv. /v1/parties?$filter=PartyType eq 'Customer', /v1/products, /v1/parties/{id}. Pad begint met /v1/. Ondersteunt OData ($filter, $top, $skip). Geen bv = op accountniveau (bv. /v1/account/accountInformation).",
    input_schema: {
      type: "object",
      properties: {
        bv: bvParam,
        pad: { type: "string", description: "Pad met query, bv. /v1/parties?$top=50" },
      },
      required: ["pad"],
      additionalProperties: false,
    },
  },
];

function cfg(n: number) {
  const c = cfgVoor(n);
  if (!c) throw new Error(`BV ${n} is niet aan Billit gekoppeld.`);
  return c;
}

// Lege velden weg, zodat de antwoorden compact blijven.
function zonderLeeg(o: any): any {
  if (Array.isArray(o)) return o.map(zonderLeeg);
  if (!o || typeof o !== "object") return o;
  const uit: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    uit[k] = zonderLeeg(v);
  }
  return uit;
}

const dag = (v: unknown) => (v ? String(v).slice(0, 10) : undefined);
const bevat = (o: unknown, zoek: string) => JSON.stringify(o).toLowerCase().includes(zoek.toLowerCase());

function factuurKort(o: Obj) {
  const cp = veld(o, "CounterParty", "Counterparty") ?? {};
  return zonderLeeg({
    id: veld(o, "OrderID", "OrderId"),
    nummer: veld(o, "OrderNumber"),
    datum: dag(veld(o, "OrderDate")),
    vervaldag: dag(veld(o, "ExpiryDate")),
    tegenpartij: veld(cp, "DisplayName", "Name", "CommercialName"),
    btw: veld(cp, "VATNumber"),
    type: veld(o, "OrderType"),
    richting: veld(o, "OrderDirection"),
    status: veld(o, "OrderStatus"),
    excl: veld(o, "TotalExcl"),
    incl: veld(o, "TotalIncl"),
    teBetalen: veld(o, "ToPay"),
    betaald: veld(o, "Paid"),
    referentie: veld(o, "Reference"),
    omschrijving: veld(o, "OrderTitle", "Description"),
  });
}

async function voerUit(naam: string, inp: Obj): Promise<unknown> {
  switch (naam) {
    case "bedrijven": {
      const data = metBillit(await laad(), await bedrijvenUitBillit());
      return data.bvs.map((bv, i) => ({ bv: i + 1, naam: bv.naam, btw: bv.btw, inWinst: bv.inWinst, billit: !!cfgVoor(i + 1) }));
    }
    case "overzicht": {
      const rijen = await overzicht(await laad(), Number(inp.jaar), false);
      return rijen.map((r, i) => ({
        bv: i + 1,
        naam: r.naam,
        inWinst: r.inWinst,
        fout: r.fout,
        omzet: r.omzet,
        kosten: r.kosten,
        winst: r.winst,
        intern: r.intern,
        perMaand: r.maanden?.map((m, j) => ({ maand: j + 1, omzet: m.omzet, kosten: m.kosten })),
        nogTeOntvangen: r.openstaand && { bedrag: r.openstaand.bedrag, aantal: r.openstaand.aantal, vervallen: r.openstaand.vervallen },
        saldo: r.saldo,
        rekeningen: r.rekeningen.map((k) => ({ naam: k.naam, iban: k.iban, huidig: k.huidig })),
      }));
    }
    case "facturen": {
      const delen = [`OrderDate ge datetime'${inp.vanaf}'`, `OrderDate le datetime'${inp.tot}'`];
      if (inp.richting && inp.richting !== "alle") delen.push(`OrderDirection eq '${inp.richting}'`);
      if (inp.onbetaald) delen.push("Paid eq false");
      let orders = await alle(cfg(inp.bv), "/v1/orders" + q(delen.join(" and ")), 40);
      if (inp.zoek) orders = orders.filter((o) => bevat(o, inp.zoek));
      const lijst = orders.map(factuurKort);
      const som = (k: string) => lijst.reduce((s, f) => s + (Number(f[k]) || 0), 0);
      return { aantal: lijst.length, totaalExcl: som("excl"), totaalIncl: som("incl"), totaalTeBetalen: som("teBetalen"), facturen: lijst };
    }
    case "factuur":
      return zonderLeeg(await get(cfg(inp.bv), `/v1/orders/${Number(inp.id)}`));
    case "banktransacties": {
      const filter = `ValueDate ge datetime'${inp.vanaf}' and ValueDate le datetime'${inp.tot}'`;
      let tx = await alle(cfg(inp.bv), "/v1/financialTransactions" + q(filter), 40);
      if (inp.zoek) tx = tx.filter((t) => bevat(t, inp.zoek));
      return { aantal: tx.length, transacties: zonderLeeg(tx) };
    }
    case "billit_get": {
      const pad = String(inp.pad ?? "");
      if (!pad.startsWith("/v1/")) throw new Error("Pad moet met /v1/ beginnen.");
      const c = inp.bv ? cfg(inp.bv) : { ...cfg(1), partyId: undefined };
      return zonderLeeg(await get(c, pad));
    }
  }
  throw new Error(`Onbekende tool ${naam}`);
}

function systeem() {
  const vandaag = new Date().toISOString().slice(0, 10);
  return `Je bent de financiële assistent in iCount, het interne dashboard van Jore. Je beantwoordt vragen over de boekhouding van zijn 4 Belgische BV's in Billit (facturen, klanten, leveranciers, betalingen, banktransacties, winst).

- Haal cijfers altijd live op met de tools; verzin nooit bedragen. Begin met bedrijven als je niet weet welke BV welk nummer heeft.
- Groepsstructuur: Jove factureert aan de andere BV's. Jove telt niet mee in de winst en haar facturen tellen niet als kost bij de andere BV's. Voor winstvragen gebruik je overzicht, zodat je antwoord overeenkomt met het dashboard.
- Winst is exclusief btw, zonder ontwerpfacturen (status Draft). Nog te ontvangen is inclusief btw.
- Antwoord in het Nederlands (Belgisch), kort en to the point, met bedragen als € 1.234,56. Gebruik een tabel als je meerdere facturen of BV's vergelijkt. Zeg erbij over welke periode en welke BV('s) je antwoord gaat.
- Je kan enkel lezen in Billit, niets wijzigen of versturen.
- Vandaag is ${vandaag}.`;
}

export type Bericht = { role: "user" | "assistant"; content: string };
export type Gebeurtenis = { type: "tool"; naam: string; invoer: Obj } | { type: "tekst"; tekst: string } | { type: "fout"; tekst: string } | { type: "klaar" };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

// Workers AI geeft (afhankelijk van het model) een OpenAI-antwoord of de oudere vorm { response, tool_calls }.
function bericht(res: any): { content: string; tool_calls: ToolCall[] } {
  const m = res?.choices?.[0]?.message;
  const ruw: any[] = (m ? m.tool_calls : res?.tool_calls) ?? [];
  const tool_calls = ruw.map((t, i) => ({
    id: String(t.id ?? `call_${Date.now()}_${i}`),
    type: "function" as const,
    function: {
      name: String(t.function?.name ?? t.name),
      arguments: typeof (t.function?.arguments ?? t.arguments) === "string" ? (t.function?.arguments ?? t.arguments) : JSON.stringify(t.function?.arguments ?? t.arguments ?? {}),
    },
  }));
  return { content: String((m ? m.content : res?.response) ?? ""), tool_calls };
}

const leesInvoer = (s: string): Obj => { try { return JSON.parse(s || "{}") ?? {}; } catch { return {}; } };

// Beantwoordt de laatste vraag; meldt tussendoor welke tools lopen en stuurt dan het antwoord.
export async function beantwoord(gesprek: Bericht[], stuur: (g: Gebeurtenis) => void): Promise<void> {
  const ai = (env as any).AI as { run: (model: string, invoer: Obj) => Promise<any> };
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages: Obj[] = [{ role: "system", content: systeem() }, ...gesprek.map((b) => ({ role: b.role, content: b.content }))];

  for (let ronde = 0; ronde < MAX_RONDES; ronde++) {
    const antwoord = bericht(await ai.run(MODEL, { messages, tools, max_tokens: 8000 }));
    if (!antwoord.tool_calls.length) {
      if (!antwoord.content.trim()) return stuur({ type: "fout", tekst: "Het model gaf geen antwoord. Probeer het opnieuw." });
      return stuur({ type: "tekst", tekst: antwoord.content });
    }
    messages.push({ role: "assistant", content: antwoord.content || null, tool_calls: antwoord.tool_calls });

    const resultaten = await Promise.all(
      antwoord.tool_calls.map(async (t) => {
        const invoer = leesInvoer(t.function.arguments);
        stuur({ type: "tool", naam: t.function.name, invoer });
        let s: string;
        try {
          s = JSON.stringify(await voerUit(t.function.name, invoer));
          if (s.length > MAX_TEKENS) s = s.slice(0, MAX_TEKENS) + " …[ingekort: vraag een kleinere periode of gebruik zoek]";
        } catch (e) {
          s = "Fout: " + (e instanceof Error ? e.message : String(e));
        }
        return { role: "tool", tool_call_id: t.id, content: s };
      }),
    );
    messages.push(...resultaten);
  }
  stuur({ type: "fout", tekst: "Te veel stappen nodig; stel de vraag wat specifieker." });
}
