import { Suspense } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type Row = {
  id: string;
  reason: string;
  status: string;
  opened_at: string;
  orders: { id: string; price_eur_cents: number; listings: { title: string } | null } | null;
};

async function Cases() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("disputes")
    .select("id, reason, status, opened_at, orders(id, price_eur_cents, listings(title))")
    .eq("arbiter_id", auth.user?.id ?? "")
    .order("opened_at", { ascending: false });
  const rows = (data ?? []) as unknown as Row[];

  return (
    <>
      {error && <p className="text-sm">Error: {error.message}</p>}
      {rows.length === 0 && !error && <p className="text-sm">No cases assigned to you.</p>}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Link className="font-semibold underline" href={"/protected/arbiter/" + r.id}>
                  {r.orders?.listings?.title ?? "Order"}
                </Link>
                <p className="text-sm opacity-70">
                  {r.reason.split("_").join(" ")} · opened {new Date(r.opened_at).toLocaleDateString("en-GB")}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="font-semibold">{r.orders ? (r.orders.price_eur_cents / 100).toFixed(2) + " EUR" : ""}</p>
                <p className="opacity-70">{r.status}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ArbiterPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Arbiter desk</h1>
        <Link className="text-sm underline" href="/protected/listings">Listings</Link>
      </div>
      <Suspense fallback={<p className="text-sm">Loading cases...</p>}>
        <Cases />
      </Suspense>
    </div>
  );
}
