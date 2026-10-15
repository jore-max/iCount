import type { APIRoute } from "astro";
import { cfgVoor, voorbeeld } from "../lib/billit";
import { env } from "cloudflare:workers";

// Toont de Billit-account (met de PartyID's van je bedrijven) en per BV twee ruwe records.
export const GET: APIRoute = async () => {
  const uit: Record<string, unknown> = {};
  const key = (env as any).BILLIT_KEY as string | undefined;
  if (key) {
    const base = ((env as any).BILLIT_BASE || "https://api.billit.be").replace(/\/$/, "");
    uit.account = await voorbeeld({ key, base }, ["/v1/account/accountInformation"]);
  }
  for (const n of [1, 2, 3, 4]) {
    const cfg = cfgVoor(n);
    uit[`BV ${n}`] = cfg ? await voorbeeld(cfg) : "geen BILLIT_KEY ingesteld";
  }
  return new Response(JSON.stringify(uit, null, 2), { headers: { "content-type": "application/json" } });
};
