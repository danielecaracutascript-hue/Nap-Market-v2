import { notFound } from "next/navigation";
import EscrowV2TestClient from "./test-client";

export default function Page() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return <EscrowV2TestClient />;
}
