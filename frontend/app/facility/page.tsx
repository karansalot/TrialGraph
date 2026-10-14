"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loading } from "@/components/bits";
import FacilityDetail from "./detail";

function Inner() {
  const id = useSearchParams().get("id");
  if (!id) return <p className="text-sm">No facility selected. <Link className="text-blue-700 underline" href="/">Go back</Link></p>;
  return <FacilityDetail id={id} key={id} />;
}

export default function Page() {
  return <Suspense fallback={<Loading h={400} />}><Inner /></Suspense>;
}
