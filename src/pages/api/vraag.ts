import type { APIRoute } from "astro";
import { beantwoord, assistentKlaar, type Bericht, type Gebeurtenis } from "../../lib/assistent";

// POST { gesprek: [{ role, content }] } -> NDJSON-stroom met gebeurtenissen (tool, tekst, fout, klaar).
export const POST: APIRoute = async ({ request }) => {
  if (!assistentKlaar()) return new Response("Zet eerst het secret ANTHROPIC_API_KEY.", { status: 503 });
  const body = await request.json().catch(() => null);
  const gesprek: Bericht[] = (Array.isArray(body?.gesprek) ? body.gesprek : [])
    .filter((b: any) => (b?.role === "user" || b?.role === "assistant") && typeof b.content === "string" && b.content.trim())
    .slice(-30);
  if (gesprek.at(-1)?.role !== "user") return new Response("Geen vraag.", { status: 400 });

  const enc = new TextEncoder();
  const stroom = new ReadableStream({
    async start(ctrl) {
      const stuur = (g: Gebeurtenis) => ctrl.enqueue(enc.encode(JSON.stringify(g) + "\n"));
      try {
        await beantwoord(gesprek, stuur);
      } catch (e) {
        stuur({ type: "fout", tekst: e instanceof Error ? e.message : String(e) });
      }
      stuur({ type: "klaar" });
      ctrl.close();
    },
  });
  return new Response(stroom, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
};
