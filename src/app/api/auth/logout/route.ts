import { successResponse } from "@/lib/api-helpers";

export async function POST() {
  const response = successResponse({ message: "Logged out" });
  response.cookies.set("el_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
