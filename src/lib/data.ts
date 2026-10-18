import { env, waitUntil } from "cloudflare:workers";
import { bedrag, normIban, mutatieNa, type Tx, type Maand, type InterneLeverancier, type Openstaand } from "./reken";
import { cfgVoor, winstVoorJaar, openstaandeVerkoop, transactiesVanaf, eigenBedrijf, type Bedrijf } from "./billit";

// Rekening: saldo is het saldo op `datum`; Billit-transacties op dat IBAN na die datum worden erbij geteld.
export type Rekening = { naam: string; iban: string; saldo: number; datum: string };
// inWinst: false voor een BV die aan de andere factureert (bv. Jove). Die telt niet mee in de winst,
// en haar facturen worden uit de kosten van de andere BV's gehaald (herkend op btw-nummer of naam).
// Niet ingevuld (oudere opslag) = automatisch: de BV die in Billit "Jove" heet telt niet mee, de rest wel.
export type Bv = { naam: string; btw: string; inWinst?: boolean; winstHandmatig: number; rekeningen: Rekening[] };
export type BvVol = Bv & { inWinst: boolean };
export type Data = { bvs: Bv[]; bijgewerkt: string | null };

const KEY = "data";
const CACHE_TTL = 900; // 15 minuten: daarna wordt op de achtergrond ververst
const BEWAAR = 60 * 86400; // zo lang blijft het laatste resultaat bewaard

const vandaag = () => new Date().toISOString().slice(0, 10);

const leeg = (): Data => ({
  bvs: [1, 2, 3, 4].map((n) => ({
    naam: `BV ${n}`,
    btw: "",
    inWinst: true,
    winstHandmatig: 0,
    rekeningen: [{ naam: "Zichtrekening", iban: "", saldo: 0, datum: vandaag() }],
  })),
  bijgewerkt: null,
});

export async function laad(): Promise<Data> {
  const d = await env.ICOUNT.get<any>(KEY, "json");
  if (!d) return leeg();
  // oudere versie had `winst` en rekeningen zonder iban/datum
  for (const bv of d.bvs) {
    bv.winstHandmatig ??= bv.winst ?? 0;
    bv.btw ??= "";
    for (const r of bv.rekeningen) { r.iban ??= ""; r.datum ??= vandaag(); }
  }
  return d as Data;
}

export async function bewaar(data: Data): Promise<void> {
  await env.ICOUNT.put(KEY, JSON.stringify(data));
}

export function uitForm(form: FormData): Data {
  const bvs: Bv[] = [0, 1, 2, 3].map((i) => {
    const kol = (k: string) => form.getAll(`bv${i}_rek_${k}`).map(String);
    const namen = kol("naam"), ibans = kol("iban"), saldi = kol("saldo"), datums = kol("datum");
    const rekeningen = namen
      .map((naam, j) => ({
        naam: naam.trim(),
        iban: normIban(ibans[j]),
        saldo: bedrag(saldi[j]),
        datum: /^\d{4}-\d{2}-\d{2}$/.test(datums[j] ?? "") ? datums[j] : vandaag(),
      }))
      .filter((r) => r.naam !== "" || r.iban !== "" || r.saldo !== 0);
    return {
      naam: String(form.get(`bv${i}_naam`) ?? "").trim() || `BV ${i + 1}`,
      btw: String(form.get(`bv${i}_btw`) ?? "").trim().toUpperCase(),
      inWinst: form.get(`bv${i}_inwinst`) === "on",
      winstHandmatig: bedrag(form.get(`bv${i}_winst`)),
      rekeningen,
    };
  });
  return { bvs, bijgewerkt: new Date().toISOString() };
}

// Stale-while-revalidate: de pagina toont altijd meteen wat bewaard is. Is dat ouder dan `ttl`
// seconden, dan haalt de worker het na het antwoord op de achtergrond opnieuw op uit Billit.
// Enkel "Vernieuwen" (of nog niets bewaard) wacht op Billit.
type Bewaard<T> = { t: number; v: T };

async function ververs<T>(key: string, maak: () => Promise<T>): Promise<T> {
  const v = await maak();
  await env.ICOUNT.put(key, JSON.stringify({ t: Date.now(), v } satisfies Bewaard<T>), { expirationTtl: BEWAAR });
  return v;
}

async function gecached<T>(key: string, vernieuw: boolean, maak: () => Promise<T>, ttl = CACHE_TTL): Promise<T> {
  const k = `swr:${key}`;
  if (!vernieuw) {
    const c = await env.ICOUNT.get<Bewaard<T>>(k, "json");
    if (c) {
      if (Date.now() - c.t > ttl * 1000) waitUntil(ververs(k, maak).catch(() => {}));
      return c.v;
    }
  }
  return ververs(k, maak);
}

export type RekeningRegel = Rekening & { mutatie: number | null; huidig: number };
export type BvRegel = {
  naam: string;
  inWinst: boolean;
  intern: number; // weggelaten aankopen bij een BV die buiten de winst blijft
  billit: boolean;
  fout: string | null;
  omzet: number | null;
  kosten: number | null;
  winst: number;
  maanden: Maand[] | null;
  openstaand: Openstaand | null; // nog te ontvangen verkoopfacturen (enkel BV's in de winst)
  saldo: number;
  rekeningen: RekeningRegel[];
};

// Een naam als "BV 3" (of leeg) is de standaardnaam: dan nemen we de naam uit Billit.
export const standaardNaam = (naam: string) => naam.trim() === "" || /^BV \d+$/i.test(naam.trim());

// Naam en btw-nummer per BV uit Billit (1 dag bewaard).
export async function bedrijvenUitBillit(vernieuw = false): Promise<Bedrijf[]> {
  return Promise.all(
    [1, 2, 3, 4].map(async (n) => {
      const cfg = cfgVoor(n);
      return cfg ? gecached(`cache:bedrijf:${n}`, vernieuw, () => eigenBedrijf(cfg), 86400) : { naam: "", btw: "" };
    }),
  );
}

const isJove = (naam: string | undefined) => /^\s*jove\b/i.test(naam ?? "");

// Vult de namen en btw-nummers aan met wat Billit weet, zonder wat je zelf invulde te overschrijven.
export function metBillit(data: Data, bedrijven: Bedrijf[]): { bvs: BvVol[]; bijgewerkt: string | null } {
  return {
    ...data,
    bvs: data.bvs.map((bv, i) => {
      const naam = standaardNaam(bv.naam) && bedrijven[i]?.naam ? bedrijven[i].naam : bv.naam;
      return {
        ...bv,
        naam,
        btw: bv.btw || bedrijven[i]?.btw || "",
        inWinst: bv.inWinst ?? !(isJove(naam) || isJove(bedrijven[i]?.naam)),
      };
    }),
  };
}

// Btw-nummers en namen van de BV's die buiten de winst blijven.
function interneLeveranciers(data: { bvs: BvVol[] }): InterneLeverancier {
  const uit = data.bvs.filter((bv) => !bv.inWinst);
  return { btw: uit.map((bv) => bv.btw).filter(Boolean), namen: uit.map((bv) => bv.naam).filter((n) => !standaardNaam(n)) };
}

export async function overzicht(opgeslagen: Data, jaar: number, vernieuw: boolean): Promise<BvRegel[]> {
  const data = metBillit(opgeslagen, await bedrijvenUitBillit(vernieuw));
  const intern = interneLeveranciers(data);
  const sleutel = encodeURIComponent([...intern.btw, ...intern.namen].join("|"));
  return Promise.all(
    data.bvs.map(async (bv, i): Promise<BvRegel> => {
      const cfg = cfgVoor(i + 1);
      let fout: string | null = null;
      let omzet: number | null = null, kosten: number | null = null, winst = bv.winstHandmatig;
      let maanden: Maand[] | null = null;
      let internBedrag = 0;
      let tx: Tx[] = [];
      let openstaand: Openstaand | null = null;

      if (cfg) {
        // winst, transacties en openstaande facturen tegelijk ophalen
        const uitsluiten = bv.inWinst ? intern : { btw: [], namen: [] };
        const metIban = bv.rekeningen.filter((r) => r.iban);
        const vanaf = metIban.map((r) => r.datum).sort()[0];
        const [w, t, o] = await Promise.allSettled([
          gecached(`cache:winst4:${i + 1}:${jaar}:${bv.inWinst ? sleutel : ""}`, vernieuw, () => winstVoorJaar(cfg, jaar, uitsluiten)),
          vanaf ? gecached(`cache:tx2:${i + 1}:${vanaf}`, vernieuw, () => transactiesVanaf(cfg, vanaf)) : Promise.resolve([] as Tx[]),
          bv.inWinst ? gecached(`cache:open3:${i + 1}`, vernieuw, () => openstaandeVerkoop(cfg)) : Promise.resolve(null),
        ]);
        const fouten = [w, t].filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (fouten.length) {
          const e = fouten[0].reason;
          fout = e instanceof Error ? e.message : String(e);
        } else if (w.status === "fulfilled" && t.status === "fulfilled") {
          ({ omzet, kosten, winst, maanden } = w.value);
          internBedrag = w.value.intern;
          tx = t.value;
          if (o.status === "fulfilled") openstaand = o.value;
        }
      }

      const rekeningen = bv.rekeningen.map((r) => {
        const mutatie = cfg && r.iban && !fout ? mutatieNa(tx, r.iban, r.datum) : null;
        return { ...r, mutatie, huidig: r.saldo + (mutatie ?? 0) };
      });
      return {
        naam: bv.naam,
        inWinst: bv.inWinst,
        intern: internBedrag,
        billit: !!cfg,
        fout,
        omzet,
        kosten,
        winst,
        maanden,
        openstaand,
        saldo: rekeningen.reduce((s, r) => s + r.huidig, 0),
        rekeningen,
      };
    }),
  );
}
