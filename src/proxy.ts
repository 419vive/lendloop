import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk keeps the session cookie fresh here. Authorization is NOT done by
// path matching: every Convex query/mutation checks the caller itself
// (convex/lib/auth.ts), and the app shell redirects signed-out visitors to
// sign-in purely for UX.
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
