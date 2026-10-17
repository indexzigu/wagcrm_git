import { redirect } from "next/navigation";

// 자료 목록 허브(카드 4장)는 없어졌다 — 사이드바 「자료 목록」 하위 항목이 입구를 대신한다.
export default function AssetsPage() {
  redirect("/assets/archive");
}
