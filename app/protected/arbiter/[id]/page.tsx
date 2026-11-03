import { Suspense } from "react";
import ArbiterClient from "./arbiter-client";

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArbiterClient disputeId={id} />;
}

export default function ArbiterCasePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Loading...</p>}>
      <Content params={params} />
    </Suspense>
  );
}
