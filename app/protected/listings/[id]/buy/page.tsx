import { Suspense } from "react";
import BuyClient from "./buy-client";

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BuyClient key={id} listingId={id} />;
}

export default function BuyPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Loading...</p>}>
      <Content params={params} />
    </Suspense>
  );
}
