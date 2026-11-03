import { NextResponse } from "next/server";

/**
 * Automatic payments from the shared Core test wallet are suspended.
 * Restore only after server-side regtest isolation, persistent idempotency,
 * real outpoint detection and database permissions have been verified.
 * External payments can still be checked through check-payment.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Automatic test-wallet payments are temporarily disabled. No payment was sent. Existing payments can be checked separately.",
    },
    { status: 503 },
  );
}
