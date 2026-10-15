import { env } from "cloudflare:workers";
import { bedrag, normIban, mutatieNa, type Tx } from "./reken";
import { cfgVoor, winstVoorJaar, transactiesVanaf } from "./billit";

// Rekening: saldo is het saldo op `datum`; Billit-transacties op dat IBAN na die datum worden erbij geteld.
export type Rekening = { naam: string; iban: string; saldo: number; datum: string };
export type Bv = { naam: string; winstHandmatig: number; rekeningen: Rekening[] };
export type Data = { bvs: Bv[]; bijgewerkt: string | null };

const KEY = "data";
const CACHE_TTL = 900; // 15 minuten

const vandaag = () => new Date().toISOString().slice(0, 10);

const leeg = (): Data => ({
  bvs: [1, 2, 3, 4].map((n) => ({
    naam: `BV ${n}`,
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
      winstHandmatig: bedrag(form.get(`bv${i}_winst`)),
      rekeningen,
    };
  });
  return { bvs, bijgewerkt: new Date().toISOString() };
}

async function gecached<T>(key: string, vernieuw: boolean, maak: () => Promise<T>): Promise<T> {
  if (!vernieuw) {
    const c = await env.ICOUNT.get<T>(key, "json");
    if (c !== null) return c;
  }
  const v = await maak();
  await env.ICOUNT.put(key, JSON.stringify(v), { expirationTtl: CACHE_TTL });
  return v;
}

export type RekeningRegel = Rekening & { mutatie: number | null; huidig: number };
export type BvRegel = {
  naam: string;
  billit: boolean;
  fout: string | null;
  omzet: number | null;
  kosten: number | null;
  winst: number;
  saldo: number;
  rekeningen: RekeningRegel[];
};

export async function overzicht(data: Data, jaar: number, vernieuw: boolean): Promise<BvRegel[]> {
  return Promise.all(
    data.bvs.map(async (bv, i): Promise<BvRegel> => {
      const cfg = cfgVoor(i + 1);
      let fout: string | null = null;
      let omzet: number | null = null, kosten: number | null = null, winst = bv.winstHandmatig;
      let tx: Tx[] = [];

      if (cfg) {
        try {
          const w = await gecached(`cache:winst:${i + 1}:${jaar}`, vernieuw, () => winstVoorJaar(cfg, jaar));
          ({ omzet, kosten, winst } = w);
          const metIban = bv.rekeningen.filter((r) => r.iban);
          if (metIban.length) {
            const vanaf = metIban.map((r) => r.datum).sort()[0];
            tx = await gecached(`cache:tx:${i + 1}:${vanaf}`, vernieuw, () => transactiesVanaf(cfg, vanaf));
          }
        } catch (e) {
          fout = e instanceof Error ? e.message : String(e);
        }
      }

      const rekeningen = bv.rekeningen.map((r) => {
        const mutatie = cfg && r.iban && !fout ? mutatieNa(tx, r.iban, r.datum) : null;
        return { ...r, mutatie, huidig: r.saldo + (mutatie ?? 0) };
      });
      return {
        naam: bv.naam,
        billit: !!cfg,
        fout,
        omzet,
        kosten,
        winst,
        saldo: rekeningen.reduce((s, r) => s + r.huidig, 0),
        rekeningen,
      };
    }),
  );
}
