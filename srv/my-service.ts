import cds from "@sap/cds";

const VALID_ALGORITHMS = new Set(["COSINE_SIMILARITY", "L2DISTANCE"]);
const FILTER_COLUMNS: Record<string, string> = {
  service_name: "SERVICE_NAME",
  service_plan: "SERVICE_PLAN",
  commercial_model: "COMMERCIAL_MODEL",
  region: "REGION",
  metric_name: "METRIC_NAME",
};
const FILTER_MODES = new Set(["topic", "source_section"]);

type VectorInput = Buffer | number[] | { data?: number[] };

function vectorBufferToArray(input: VectorInput): number[] {
  if (Buffer.isBuffer(input)) {
    const dimensions = input.readUInt32LE(0);
    return Array.from({ length: dimensions }, (_, index) => input.readFloatLE(4 + index * 4));
  }
  if (Array.isArray(input)) return input;
  if (input?.data) return vectorBufferToArray(Buffer.from(input.data));
  throw new Error("Invalid vector payload.");
}

function vectorLiteral(input: VectorInput): string {
  return JSON.stringify(vectorBufferToArray(input));
}

export class MyService extends cds.ApplicationService {
  async init(): Promise<void> {
    const db = await cds.connect.to("db");
    const { PricingChunks } = db.entities("Chatbot");

    this.on("recieveQuestion", (req: any) => req.data.message);

    this.on("uploadFile", async (req: any) => {
      const data = req.data;
      if (!data.service_name || !data.content_text || !data.embedding || !data.content_hash) {
        return req.error(400, "service_name, content_text, embedding, and content_hash are required.");
      }

      const existing = await db.run(
        SELECT.one.from(PricingChunks).where({ content_hash: data.content_hash }),
      );
      if (existing) return "Data already exists in the database.";

      await db.run(INSERT.into(PricingChunks).entries({
        topic: data.topic || "pricing",
        source: data.source || "SAP Discovery Center",
        section: data.section || "pricing",
        service_name: data.service_name,
        service_plan: data.service_plan || null,
        commercial_model: data.commercial_model || null,
        region: data.region || null,
        metric_name: data.metric_name || null,
        unit: data.unit || null,
        price_value: data.price_value ?? null,
        currency: data.currency || null,
        source_url: data.source_url || null,
        last_synced_at: data.last_synced_at || new Date().toISOString(),
        content_text: data.content_text,
        embedding: vectorLiteral(data.embedding),
        content_hash: data.content_hash,
        version: data.version || 1,
        access_level: data.access_level || "public",
      }));
      return "Pricing record uploaded successfully.";
    });

    this.on("similaritySearch", async (req: any) => {
      const {
        queryEmbedding,
        algoName = "COSINE_SIMILARITY",
        topK = 7,
        filter_mode = "topic",
      } = req.data;
      if (!queryEmbedding) return req.error(400, "Missing queryEmbedding.");
      if (!VALID_ALGORITHMS.has(algoName)) {
        return req.error(400, `Invalid algorithm name: ${algoName}.`);
      }
      if (!FILTER_MODES.has(filter_mode)) {
        return req.error(400, `Invalid filter mode: ${filter_mode}.`);
      }

      const limit = Number.isInteger(topK) && topK > 0 ? Math.min(topK, 50) : 7;
      const direction = algoName === "L2DISTANCE" ? "ASC" : "DESC";
      const embedding = vectorLiteral(queryEmbedding).replace(/'/g, "''");
      const predicates: string[] = [];
      const values: string[] = [];

      if (filter_mode === "topic") {
        predicates.push(`LOWER("TOPIC") = ?`);
        values.push(String(req.data.topic || "pricing").toLowerCase());
      } else {
        if (!req.data.source && !req.data.section) {
          return req.error(400, "source_section filtering requires source or section.");
        }
        if (req.data.source) {
          predicates.push(`(LOWER("SOURCE") LIKE ? OR LOWER("SOURCE_URL") LIKE ?)`);
          const sourcePattern = `%${String(req.data.source).toLowerCase()}%`;
          values.push(sourcePattern, sourcePattern);
        }
        if (req.data.section) {
          predicates.push(`LOWER("SECTION") LIKE ?`);
          values.push(`%${String(req.data.section).toLowerCase()}%`);
        }
      }

      for (const [field, column] of Object.entries(FILTER_COLUMNS)) {
        if (field === "access_level") continue;
        const value = req.data[field];
        if (!value) continue;
        predicates.push(`LOWER("${column}") LIKE ?`);
        values.push(`%${String(value).toLowerCase()}%`);
      }
      const requestedAccess = String(req.data.access_level || "public").toLowerCase();
      const allowedAccess = req.user?.is?.("PricingAdmin") ? requestedAccess : "public";
      predicates.push(`LOWER("ACCESS_LEVEL") = ?`);
      values.push(allowedAccess);

      const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
      const statement = `
        SELECT TOP ${limit}
          "ID", "TOPIC", "SOURCE", "SECTION", "SERVICE_NAME", "SERVICE_PLAN", "COMMERCIAL_MODEL", "REGION",
          "METRIC_NAME", "UNIT", "PRICE_VALUE", "CURRENCY", "SOURCE_URL",
          "LAST_SYNCED_AT", "CONTENT_TEXT", "CONTENT_HASH", "VERSION", "ACCESS_LEVEL",
          ${algoName}("EMBEDDING", TO_REAL_VECTOR('${embedding}')) AS "SCORE"
        FROM CHATBOT_PRICINGCHUNKS
        ${where}
        ORDER BY "SCORE" ${direction}
      `;

      const rows = await db.run(statement, values);
      const sourceRecords = rows.map((row: any) => ({
        id: row.ID,
        topic: row.TOPIC,
        source: row.SOURCE,
        section: row.SECTION,
        service_name: row.SERVICE_NAME,
        service_plan: row.SERVICE_PLAN,
        commercial_model: row.COMMERCIAL_MODEL,
        region: row.REGION,
        metric_name: row.METRIC_NAME,
        unit: row.UNIT,
        price_value: row.PRICE_VALUE,
        currency: row.CURRENCY,
        source_url: row.SOURCE_URL,
        last_synced_at: row.LAST_SYNCED_AT,
        content_text: row.CONTENT_TEXT,
        content_hash: row.CONTENT_HASH,
        version: row.VERSION,
        access_level: row.ACCESS_LEVEL,
        score: row.SCORE,
      }));
      return JSON.stringify({ sourceRecords });
    });

    this.on("initTable", () => "Tables are managed by the CAP/HANA deployment model.");
    this.on("deleteTable", () => "Tables are managed by the CAP/HANA deployment model.");
    this.on("deleteDocuments", async (req: any) => {
      const { column_name, column_value, if_all } = req.data;
      if (if_all) {
        await db.run(DELETE.from(PricingChunks));
        return "All pricing records deleted successfully.";
      }
      const allowed = ["ID", "content_hash", "service_name"];
      if (!allowed.includes(column_name)) {
        return req.error(400, `column_name must be one of: ${allowed.join(", ")}.`);
      }
      await db.run(DELETE.from(PricingChunks).where({ [column_name]: column_value }));
      return "Pricing records deleted successfully.";
    });

    return super.init();
  }
}
