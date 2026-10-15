import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

// Optionele basisbeveiliging: zet een secret WACHTWOORD met
//   npx wrangler secret put WACHTWOORD
// Zonder dat secret is de pagina open (gebruik dan bv. Cloudflare Access).
export const onRequest = defineMiddleware((ctx, next) => {
  const wachtwoord = (env as any).WACHTWOORD as string | undefined;
  if (!wachtwoord) return next();
  const auth = ctx.request.headers.get("authorization") ?? "";
  const [, b64] = auth.split(" ");
  const pw = b64 ? atob(b64).split(":").slice(1).join(":") : "";
  if (pw === wachtwoord) return next();
  return new Response("Aanmelden vereist", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="iCount"' },
  });
});
