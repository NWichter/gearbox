import { NextResponse, type NextRequest } from "next/server";

// Optional site-wide basic auth: active only when SITE_PASSWORD is set (e.g. until Tesla reveals
// the injected faults, so other teams cannot read our findings). SITE_USER defaults to "airframe".
export function proxy(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();
  const user = process.env.SITE_USER || "airframe";
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, p] = atob(header.slice(6)).split(":");
    if (u === user && p === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Gearbox"' },
  });
}

export const config = {
  // everything except static assets and the favicon
  matcher: ["/((?!_next/static|_next/image|icon.svg).*)"],
};
