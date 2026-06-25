using { Chatbot as db } from '../db/data-model';

@path: 'my'
service MyService {
  entity Documents as projection on db.Documents excluding {
    embedding
  };

  action recieveQuestion(message: String) returns String;

  action uploadFile(
    text: LargeString,
    metadata: LargeString,
    embedding_text: LargeBinary,
    embedding_metadata: LargeBinary
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
    topK: Integer
  ) returns String;
}
