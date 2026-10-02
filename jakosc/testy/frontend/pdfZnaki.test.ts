import test from "node:test";
import assert from "node:assert/strict";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { doWinAnsi, zabezpieczZnakiPdf } from "../../../aplikacje/web/src/portfel/services/pdfZnaki.ts";

test("doWinAnsi: polskie litery bez ogonkow, o z kreska i znaki WinAnsi zostaja", () => {
  assert.equal(doWinAnsi("Załącznik — Główne: ŻÓŁĆ źdźbło ęą ńś"), "Zalacznik — Glówne: ZÓLC zdzblo ea ns");
  assert.equal(doWinAnsi("„cudzysłów” 1 234,56 PLN · 5 → 6"), "„cudzyslów” 1 234,56 PLN · 5 -> 6");
});

test("PDF z polskim tekstem i tabela nie koduje napisow jako UTF-16 (znieksztalcone 'ZaB cznik')", () => {
  const doc = zabezpieczZnakiPdf(new jsPDF({ compress: false }));
  doc.setFont("helvetica", "normal");
  doc.text("Załącznik informacyjny", 10, 10);
  doc.text(["Łączny przychód", "Wartość"], 10, 20);
  autoTable(doc, { head: [["Pozycja", "Kwota"]], body: [["Przychód z dywidend", "1 234,56 PLN"], ["Główne konto", "Koszty do potrącenia"]] });
  const pdf = doc.output();
  const napisy = pdf.split("\n").filter((l) => / Tj$/.test(l));
  assert.ok(napisy.length >= 6, "brak napisow w strumieniu");
  assert.equal(napisy.some((l) => l.includes("\u0000")), false, "napis zakodowany jako UTF-16");
  assert.ok(napisy.some((l) => l.includes("(Zalacznik informacyjny)")));
  assert.ok(napisy.some((l) => l.includes("Koszty do potracenia")));
});
