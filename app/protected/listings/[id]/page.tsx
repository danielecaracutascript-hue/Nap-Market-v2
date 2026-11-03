import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: l } = await supabase
    .from("listings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!l) notFound();
  const { data: seller, error: sellerError } = await supabase
    .from("public_profiles")
    .select("handle, country, seller_type, business_info")
    .eq("id", l.seller_id)
    .maybeSingle();
  if (sellerError) throw new Error("Seller details are temporarily unavailable");

  const photoUrls: string[] = (l.photos ?? []).map(
    (p: string) => supabase.storage.from("listing-photos").getPublicUrl(p).data.publicUrl
  );
  const price = l.price_eur_cents / 100;
  const buyerFee = price * 0.04;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-6">
      <p className="text-sm"><Link className="underline" href="/protected/listings">Back to listings</Link></p>
      <h1 className="text-2xl font-bold">{l.title}</h1>
      {photoUrls.length === 0 && <p className="text-sm opacity-70">No photos.</p>}
      <div className="grid grid-cols-2 gap-2">
        {photoUrls.map((u) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={u} src={u} alt={l.title} className="w-full rounded border object-cover" />
        ))}
      </div>
      <p className="whitespace-pre-wrap">{l.description}</p>
      <p className="text-sm opacity-70">
        {l.category} · {l.condition.replace("_", " ")} · {l.package_size} package · ships from {l.ship_from_country}
      </p>
      <div className="rounded border p-4 text-sm">
        <p className="mb-2 font-semibold">Seller: {seller?.handle ?? "unknown"} ({seller?.country ?? "?"})</p>
        {seller?.seller_type === "professional" ? (
          <p>Professional seller: {seller.business_info?.business_name} (VAT {seller.business_info?.vat_id})</p>
        ) : (
          <p>Private seller</p>
        )}
      </div>
      <div className="rounded border p-4 text-sm space-y-1">
        <div className="flex justify-between"><span>Price</span><span>{price.toFixed(2)} EUR</span></div>
        <div className="flex justify-between"><span>Buyer fee (4%)</span><span>{buyerFee.toFixed(2)} EUR</span></div>
        <div className="flex justify-between"><span>Shipping</span><span>calculated at checkout</span></div>
        <div className="flex justify-between border-t pt-1 font-semibold"><span>Total before shipping</span><span>{(price + buyerFee).toFixed(2)} EUR</span></div>
      </div>
      <Link className="inline-block rounded bg-foreground px-4 py-2 text-background" href={"/protected/listings/" + l.id + "/buy"}>Buy</Link>
    </div>
  );
}

export default function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Loading listing...</p>}>
      <Content params={params} />
    </Suspense>
  );
}

