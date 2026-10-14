"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loading } from "@/components/bits";
import TrialDetail from "./detail";

function Inner() {
  const id = useSearchParams().get("id");
  if (!id) return <p className="text-sm">No trial selected. <Link className="text-blue-700 underline" href="/trials">Go back</Link></p>;
  return <TrialDetail nctId={id} key={id} />;
}

export default function Page() {
  return <Suspense fallback={<Loading h={400} />}><Inner /></Suspense>;
}
