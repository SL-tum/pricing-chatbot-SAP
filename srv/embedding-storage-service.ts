import cds from "@sap/cds";
import * as fs from "fs";
import path from "path";
import { createHash } from "crypto";

type PricingRecord = {
  topic?: string;
  source?: string;
  section?: string;
  service_name: string;
  service_plan?: string;
  commercial_model?: string;
  region?: string;
  metric_name?: string;
  unit?: string;
  price_value?: number | null;
  currency?: string;
  source_url?: string;
  last_synced_at?: string;
  content_text: string;
  content_hash?: string;
  version?: number;
  access_level?: string;
};

type StoredRecord = PricingRecord & { ID: string; content_hash: string; version: number };
type IndexManifest = { full_snapshot?: boolean; service_names?: string[]; record_count?: number };

const IDENTITY_FIELDS: (keyof PricingRecord)[] = [
  "topic", "source", "service_name", "service_plan", "commercial_model", "region",
  "metric_name", "unit", "currency", "source_url", "access_level",
];

export class EmbeddingStorageService extends cds.ApplicationService {
  async init(): Promise<void> {
    this.on("addDocument", async (req: any) => {
      const indexPath = path.resolve("db/data/pricing-records.jsonl");
      const manifestPath = path.resolve("db/data/pricing-index-manifest.json");
      if (!fs.existsSync(indexPath)) {
        return req.error(400, "Missing db/data/pricing-records.jsonl. Run npm run pricing:etl first.");
      }

      const records = readRecords(indexPath).map(normalizeRecord);
      const manifest: IndexManifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : { full_snapshot: false, service_names: [...new Set(records.map((row) => row.service_name))] };
      if (manifest.record_count !== undefined && manifest.record_count !== records.length) {
        return req.error(400, "Pricing index manifest does not match the JSONL record count.");
      }
      const recordKeys = records.map(identityKey);
      if (new Set(recordKeys).size !== recordKeys.length) {
        return req.error(400, "Pricing index contains duplicate logical record keys.");
      }
      const db = await cds.connect.to("db");
      const { PricingChunks } = db.entities("Chatbot");
      const stored = await db.run(SELECT.from(PricingChunks).columns(
        "ID", "topic", "source", "service_name", "service_plan", "commercial_model",
        "region", "metric_name", "unit", "currency", "source_url", "access_level",
        "content_hash", "version",
      )) as StoredRecord[];
      const storedByKey = new Map(stored.map((row) => [identityKey(row), row]));
      const incomingKeys = new Set<string>();
      const vectorPlugin = await cds.connect.to("cap-llm-plugin");
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const record of records) {
        const key = identityKey(record);
        incomingKeys.add(key);
        const current = storedByKey.get(key);
        if (current?.content_hash === record.content_hash) {
          unchanged += 1;
          continue;
        }

        const embedding = await (vectorPlugin as any).getEmbedding(record.content_text);
        const payload = { ...record, embedding: JSON.stringify(embedding) };
        if (current) {
          await db.run(UPDATE(PricingChunks).set({
            ...payload,
            version: (current.version || 1) + 1,
          }).where({ ID: current.ID }));
          updated += 1;
        } else {
          await db.run(INSERT.into(PricingChunks).entries({ ...payload, version: 1 }));
          inserted += 1;
        }
      }

      const indexedServices = new Set(manifest.service_names || records.map((row) => row.service_name));
      const stale = stored.filter((row) => {
        if (incomingKeys.has(identityKey(row))) return false;
        return manifest.full_snapshot
          ? row.source === "SAP Discovery Center"
          : row.source === "SAP Discovery Center" && indexedServices.has(row.service_name);
      });
      for (const row of stale) await db.run(DELETE.from(PricingChunks).where({ ID: row.ID }));

      return JSON.stringify({ inserted, updated, unchanged, deleted: stale.length });
    });
    return super.init();
  }
}

function readRecords(indexPath: string): PricingRecord[] {
  return fs.readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PricingRecord);
}

function normalizeRecord(record: PricingRecord): PricingRecord & { content_hash: string } {
  const normalized = {
    ...record,
    topic: record.topic || "pricing",
    source: record.source || "SAP Discovery Center",
    section: record.section || "pricing",
    access_level: record.access_level || "public",
  };
  const { content_hash: _hash, last_synced_at: _syncedAt, version: _version, ...hashable } = normalized;
  const contentHash = record.content_hash || createHash("sha256")
    .update(JSON.stringify(hashable))
    .digest("hex");
  return { ...normalized, content_hash: contentHash };
}

function identityKey(record: PricingRecord): string {
  return JSON.stringify(IDENTITY_FIELDS.map((field) => record[field] ?? null));
}
