import { Suspense } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type Listing = {
  id: string;
  seller_id: string;
  title: string;
  category: string;
  condition: string;
  price_eur_cents: number;
  package_size: string;
  ship_from_country: string;
};

type PublicProfile = { id: string; handle: string };

async function ListingsList() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("listings")
    .select("id, seller_id, title, category, condition, price_eur_cents, package_size, ship_from_country")
    .eq("status", "active")
    .order("created_at", { ascending: false });

  const listings = (data ?? []) as Listing[];
  const sellerIds = [...new Set(listings.map((listing) => listing.seller_id))];
  const { data: sellers, error: sellersError } = sellerIds.length
    ? await supabase.from("public_profiles").select("id, handle").in("id", sellerIds)
    : { data: [], error: null };
  const handles = new Map(
    ((sellers ?? []) as PublicProfile[]).map((seller) => [seller.id, seller.handle])
  );

  return (
    <>
      {error && <p className="text-sm">Error: {error.message}</p>}
      {sellersError && <p className="text-sm">Seller names are temporarily unavailable.</p>}
      {listings.length === 0 && !error && <p className="text-sm">No listings yet.</p>}
      <ul className="space-y-3">
        {listings.map((l) => (
          <li key={l.id} className="rounded border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Link className="font-semibold underline" href={"/protected/listings/" + l.id}>{l.title}</Link>
                <p className="text-sm opacity-70">
                  {l.category} · {l.condition.replace("_", " ")} · {l.package_size} package · ships from {l.ship_from_country}
                </p>
                <p className="text-sm opacity-70">Seller: {handles.get(l.seller_id) ?? "unknown"}</p>
              </div>
              <p className="font-semibold">{(l.price_eur_cents / 100).toFixed(2)} EUR</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ListingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Listings</h1>
        <div className="flex gap-4 text-sm">
          <Link className="underline" href="/protected/orders">My orders</Link><Link className="underline" href="/protected/arbiter">Arbiter desk</Link><Link className="underline" href="/protected/wallet">My wallet</Link><Link className="underline" href="/protected/profile">My profile</Link>
          <Link className="underline" href="/protected/listings/new">New listing</Link>
        </div>
      </div>
      <Suspense fallback={<p className="text-sm">Loading listings...</p>}>
        <ListingsList />
      </Suspense>
    </div>
  );
}
