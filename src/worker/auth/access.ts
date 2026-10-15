// Cloudflare Access: validates the `cf-access-jwt-assertion` header, as
// open-seo's AUTH_MODE=cloudflare_access does. The key resolver is injected so
// tests can use a local JWKS.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "@/shared/errors";

export function remoteAccessKeys(teamDomain: string): JWTVerifyGetKey {
  const base = teamDomain.startsWith("http") ? teamDomain : `https://${teamDomain}`;
  return createRemoteJWKSet(new URL(`${base.replace(/\/$/, "")}/cdn-cgi/access/certs`));
}

export async function verifyAccessJwt(
  token: string,
  options: { keys: JWTVerifyGetKey; teamDomain: string; audience: string },
): Promise<{ email: string }> {
  const issuer = options.teamDomain.startsWith("http") ? options.teamDomain.replace(/\/$/, "") : `https://${options.teamDomain}`;
  try {
    const { payload } = await jwtVerify(token, options.keys, { issuer, audience: options.audience });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    if (!email) throw new Error("token has no email claim");
    return { email };
  } catch (error) {
    throw new AppError("UNAUTHENTICATED", `Invalid Cloudflare Access token: ${(error as Error).message}`);
  }
}
