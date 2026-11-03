import { Suspense } from "react";
import OrderClient from "./order-client";

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderClient key={id} orderId={id} />;
}

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Loading...</p>}>
      <Content params={params} />
    </Suspense>
  );
}
