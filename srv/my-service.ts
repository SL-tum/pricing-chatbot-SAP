import cds from "@sap/cds";

const VALID_ALGORITHMS = new Set(["COSINE_SIMILARITY", "L2DISTANCE"]);

type VectorInput =
  | Buffer
  | number[]
  | {
      data?: number[];
      type?: string;
    };

function vectorBufferToArray(input: VectorInput): number[] {
  if (Buffer.isBuffer(input)) {
    const dimensions = input.readUInt32LE(0);
    const values: number[] = [];
    for (let i = 0; i < dimensions; i += 1) {
      values.push(input.readFloatLE(4 + i * 4));
    }
    return values;
  }

  if (Array.isArray(input)) {
    return input;
  }

  if (input?.data) {
    return vectorBufferToArray(Buffer.from(input.data));
  }

  throw new Error("Invalid vector payload.");
}

function vectorLiteral(input: VectorInput): string {
  return JSON.stringify(vectorBufferToArray(input));
}

export class MyService extends cds.ApplicationService {
  async init(): Promise<void> {
    const db = await cds.connect.to("db");
    const { JSONfiles } = db.entities("Chatbot");

    this.on("recieveQuestion", async (req: any) => {
      return req.data.message;
    });

    this.on("uploadFile", async (req: any) => {
      const { text, metadata, embedding_text, embedding_metadata } = req.data;

      if (!text || !metadata || !embedding_text || !embedding_metadata) {
        req.error(400, "Missing text, metadata, embedding_text, or embedding_metadata.");
        return;
      }

      const payload = {
        text,
        metadata,
        embedding_text: vectorLiteral(embedding_text),
        embedding_metadata: vectorLiteral(embedding_metadata),
      };

      const existing = await db.run(SELECT.from(JSONfiles).where({ text: payload.text }));
      if (existing.length > 0) {
        return "Data already exists in the database.";
      }

      await db.run(INSERT.into(JSONfiles).entries(payload));
      return "File uploaded successfully.";
    });

    this.on("similaritySearch", async (req: any) => {
      const { queryEmbedding, algoName = "COSINE_SIMILARITY", topK = 7 } = req.data;

      if (!queryEmbedding) {
        req.error(400, "Missing queryEmbedding.");
        return;
      }

      if (!VALID_ALGORITHMS.has(algoName)) {
        req.error(400, `Invalid algorithm name: ${algoName}.`);
        return;
      }

      const limit = Number.isInteger(topK) && topK > 0 ? topK : 7;
      const sortDirection = algoName === "L2DISTANCE" ? "ASC" : "DESC";
      const embedding = vectorLiteral(queryEmbedding).replace(/'/g, "''");
      const tableName = "CHATBOT_JSONFILES";

      const selectStmt = `
        SELECT TOP ${limit}
          *,
          TO_NVARCHAR("TEXT") AS PAGE_CONTENT,
          ${algoName}(embedding_metadata, TO_REAL_VECTOR('${embedding}')) AS SCORE
        FROM ${tableName}
        ORDER BY SCORE ${sortDirection}
      `;

      const results = await db.run(selectStmt);
      const similarContent = results.map((obj: any) => obj.PAGE_CONTENT);
      const additionalContents = results.map((obj: any) => ({
        score: obj.SCORE,
        pageContent: obj.PAGE_CONTENT,
      }));

      return JSON.stringify({
        similarContent,
        additionalContents,
      });
    });

    this.on("initTable", async () => {
      return "Tables are managed by the CAP/HANA deployment model.";
    });

    this.on("deleteTable", async () => {
      return "Tables are managed by the CAP/HANA deployment model.";
    });

    this.on("deleteDocuments", async (req: any) => {
      const { column_name, column_value, if_all } = req.data;

      if (if_all) {
        await db.run(DELETE.from(JSONfiles));
        return "All documents deleted successfully.";
      }

      if (!["text", "metadata", "ID"].includes(column_name)) {
        req.error(400, "Only text, metadata, and ID are supported for targeted deletion.");
        return;
      }

      await db.run(DELETE.from(JSONfiles).where({ [column_name]: column_value }));
      return "Document deleted successfully.";
    });

    return super.init();
  }
}
