"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

const CATEGORIES = ["Fashion", "Electronics", "Home", "Books", "Sports", "Collectibles", "Other"];
const MAX_PHOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

export default function NewListingPage() {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [condition, setCondition] = useState("good");
  const [price, setPrice] = useState("");
  const [packageSize, setPackageSize] = useState("small");
  const [shipFrom, setShipFrom] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length > MAX_PHOTOS) {
      setMessage("You can add at most " + MAX_PHOTOS + " photos.");
      setFiles([]);
      return;
    }
    if (picked.some((f) => f.size > MAX_BYTES)) {
      setMessage("Each photo must be 5 MB or smaller.");
      setFiles([]);
      return;
    }
    setMessage("");
    setFiles(picked);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    if (files.length === 0) {
      setMessage("Add at least one photo.");
      return;
    }
    setSaving(true);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setMessage("You must be signed in.");
      setSaving(false);
      return;
    }
    const id = crypto.randomUUID();
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${auth.user.id}/${id}/${i}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("listing-photos")
        .upload(path, f, { contentType: f.type });
      if (upErr) {
        setMessage("Photo upload failed: " + upErr.message);
        setSaving(false);
        return;
      }
      paths.push(path);
    }
    const { error } = await supabase.from("listings").insert({
      id,
      seller_id: auth.user.id,
      title: title.trim(),
      description: description.trim(),
      category,
      condition,
      price_eur_cents: Math.round(Number(price) * 100),
      package_size: packageSize,
      ship_from_country: shipFrom.trim().toUpperCase(),
      photos: paths,
      status: "active",
    });
    if (error) {
      setMessage("Error: " + error.message + " (if this mentions a foreign key, create your profile first)");
      setSaving(false);
      return;
    }
    router.push("/protected/listings");
  }

  const field = "w-full rounded border bg-transparent px-3 py-2";

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-bold">New listing</h1>
      <form onSubmit={save} className="space-y-4">
        <label className="block">
          <span className="text-sm">Title</span>
          <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={120} />
        </label>
        <label className="block">
          <span className="text-sm">Description</span>
          <textarea className={field} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-sm">Photos (1 to 5, JPG, PNG or WebP, up to 5 MB each)</span>
          <input className={field} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={onFiles} required />
        </label>
        <label className="block">
          <span className="text-sm">Category</span>
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm">Condition</span>
          <select className={field} value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="new">New</option>
            <option value="like_new">Like new</option>
            <option value="good">Good</option>
            <option value="fair">Fair</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm">Price in EUR (50 to 500)</span>
          <input className={field} type="number" min={50} max={500} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-sm">Package size (limits to be defined)</span>
          <select className={field} value={packageSize} onChange={(e) => setPackageSize(e.target.value)}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm">Ships from (2-letter country code, e.g. IT)</span>
          <input className={field} value={shipFrom} onChange={(e) => setShipFrom(e.target.value)} required maxLength={2} minLength={2} />
        </label>
        <button type="submit" disabled={saving} className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50">
          {saving ? "Publishing..." : "Publish listing"}
        </button>
      </form>
      {message && <p className="text-sm">{message}</p>}
      <p className="text-sm"><Link className="underline" href="/protected/listings">Back to listings</Link></p>
    </div>
  );
}
