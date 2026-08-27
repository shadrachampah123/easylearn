import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { success: false, error: "Public registration is disabled. Please contact your school administrator to obtain an account." },
    { status: 403 }
  );
}