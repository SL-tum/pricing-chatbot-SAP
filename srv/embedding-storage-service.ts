import cds from "@sap/cds";
import path from "path";
import { TextLoader } from "langchain/document_loaders/fs/text";

interface OutboundCredentials {
  url: string;
};
import * as fs from "fs";
import { CharacterTextSplitter } from "@langchain/textsplitters";

export class EmbeddingStorageService extends cds.ApplicationService {
  async init(): Promise<void> {
    this.on("addDocument", async (req: any) => {
      try {
        const vectorPlugin = await cds.connect.to("cap-llm-plugin");
        console.log(__dirname);
        const directoryPath = path.resolve("db/data");
        const files = fs.readdirSync(directoryPath);
        console.log(files);
        for (const file of files) {
          const filePath = path.join(directoryPath, file);
            try {
              const loader = new TextLoader(filePath);
              const documents = await loader.load();
              let documentText = "";
              for (const document of documents) {
                documentText = documentText + "\n" + document.pageContent;
              }
              console.log(`Content comes from ${file}：`);
              const textSplitter = new CharacterTextSplitter({
                chunkSize: 3500,
                chunkOverlap: 400,
                separator: 'Commercial'
              });
              const texts = await textSplitter.splitText(documentText);
              const file_name = path.basename(filePath, path.extname(filePath));
              for (const chunk of texts) {
                const embedding_text = await (vectorPlugin as any).getEmbedding(chunk);
                const embedding_metadata = await (vectorPlugin as any).getEmbedding(file_name);
                const entry = {
                  text: chunk,
                  metadata: file_name,
                  embedding_text: array2VectorBuffer(embedding_text),
                  embedding_metadata: array2VectorBuffer(embedding_metadata)
                };
                const insertStatus = await sendFile(entry);
                console.log(insertStatus);
              };
              console.log(`${file_name} is finished`);
            } catch (error) {
              console.error(`Reading ${file} error occured`, error);
            }
          };
        console.log('All Docuemtns Upload Success');
        return 'Upload Success';
      } catch (error) {
        console.log("Error while generating and storing vector embeddings:", error.response.data);
        throw error;
      }
    });
  }
};
let sendFile = async (data: any) => {
  try {
    const myService = await cds.connect.to("MyService");
    return await (myService as any).send("uploadFile", data);
  } catch (error) {
    console.log("Error while uploading document chunk:", error);
    throw error;
  }
};

let array2VectorBuffer = (data: any) => {
  const sizeFloat = 4;
  const sizeDimensions = 4;
  const bufferSize = data.length * sizeFloat + sizeDimensions;

  const buffer = Buffer.allocUnsafe(bufferSize);
  buffer.writeUInt32LE(data.length, 0);
  data.forEach((value: any, index: any) => {
    buffer.writeFloatLE(value, index * sizeFloat + sizeDimensions);
  });
  return buffer;
};

let removeQuotes = (input: string) => {
  return input.replace(/"/g, '');
};
