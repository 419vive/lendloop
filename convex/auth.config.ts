import type { AuthConfig } from "convex/server";

// Clerk issues the JWT; Convex verifies it against Clerk's JWKS.
// Set CLERK_JWT_ISSUER_DOMAIN in the Convex deployment env
// (`npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-app>.clerk.accounts.dev`).
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
