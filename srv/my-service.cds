using { Chatbot as db } from '../db/data-model';

@path: 'my'
service MyService {
  entity PricingChunks as projection on db.PricingChunks excluding {
    embedding
  };

  action recieveQuestion(message: String) returns String;

  action uploadFile(
    topic: String,
    source: String,
    section: String,
    service_name: String,
    service_plan: String,
    commercial_model: String,
    region: String,
    metric_name: String,
    unit: String,
    price_value: Decimal(19, 6),
    currency: String,
    source_url: String,
    last_synced_at: Timestamp,
    content_text: LargeString,
    embedding: LargeBinary,
    content_hash: String,
    version: Integer,
    access_level: String
  ) returns String;

  action initTable() returns String;
  action deleteTable() returns String;
  action deleteDocuments(
    column_name: String,
    column_value: String,
    if_all: Boolean
  ) returns String;

  action similaritySearch(
    queryEmbedding: LargeBinary,
    algoName: String,
    topK: Integer,
    filter_mode: String,
    topic: String,
    source: String,
    section: String,
    service_name: String,
    service_plan: String,
    commercial_model: String,
    region: String,
    metric_name: String,
    access_level: String
  ) returns String;
}
