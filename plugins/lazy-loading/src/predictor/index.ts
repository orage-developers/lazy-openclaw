import type { CatalogEntry } from "../catalog/schema.js";

export interface PredictToolsOptions {
  message: string;
  entries: readonly CatalogEntry[];
  maxPredicted: number;
  minScore: number;
  never?: readonly string[];
  core?: readonly string[];
}

const STOP = new Set("a an and are as at be by do for from how i in is it me my of on or please the this to want with you your el la los las un una unos unas de del al por para que como necesito quiero quisiera puedes puede hacer crear buscar encontrar ver abrir leer enviar actualizar borrar eliminar ayuda con en y o mi mis".split(" "));
const ALIASES: Readonly<Record<string, string>> = {
  correo: "email", email: "correo", mail: "correo", issue: "ticket", ticket: "issue",
  github: "repositorio", repo: "repositorio", repository: "repositorio", repositorio: "repository",
  calendar: "calendario", calendario: "calendar", meeting: "reunion", reunión: "meeting",
  file: "archivo", archivo: "file", search: "buscar", buscar: "search", send: "enviar", enviar: "send",
  create: "crear", crear: "create", delete: "eliminar", eliminar: "delete", read: "leer", leer: "read",
};

function tokens(text: string): string[] {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}_-]+/gu)?.filter((word) => word.length > 1 && !STOP.has(word)) ?? [];
}

function expanded(text: string): string[] {
  return tokens(text).flatMap((word) => {
    const alias = ALIASES[word];
    return alias ? [word, ...tokens(alias)] : [word];
  });
}

/** Rank catalog tools from the current user message only; scores are deterministic and in [0,1]. */
export function predictTools({ message, entries, maxPredicted, minScore, never = [], core = [] }: PredictToolsOptions): { name: string; score: number }[] {
  if (!Number.isFinite(maxPredicted) || maxPredicted <= 0 || !Number.isFinite(minScore)) return [];
  const query = expanded(message);
  if (query.length === 0) return [];
  const queryCounts = new Map<string, number>();
  for (const term of query) queryCounts.set(term, (queryCounts.get(term) ?? 0) + 1);
  const docs = entries.map((entry) => ({ entry, terms: tokens(`${entry.name.replace(/[_-]/g, " ")} ${entry.description} ${entry.signature}`) }));
  const avgLength = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const term of queryCounts.keys()) df.set(term, docs.filter((doc) => doc.terms.includes(term)).length);
  const excluded = new Set([...never, ...core]);
  return docs.flatMap(({ entry, terms }) => {
    if (excluded.has(entry.name) || entry.class === "never" || entry.class === "core" || entry.directOnly) return [];
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let bm25 = 0;
    let matched = 0;
    for (const [term, qf] of queryCounts) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      matched++;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      bm25 += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * terms.length / (avgLength || 1))) * Math.min(qf, 2);
    }
    if (matched === 0) return [];
    const coverage = matched / queryCounts.size;
    const score = Math.min(1, 0.65 * (bm25 / (bm25 + 2)) + 0.35 * coverage);
    return score >= minScore ? [{ name: entry.name, score: Number(score.toFixed(6)) }] : [];
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "en")).slice(0, Math.floor(maxPredicted));
}
