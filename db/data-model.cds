namespace Chatbot;

using {
  cuid,
  managed
} from '@sap/cds/common';

entity Documents : managed, cuid {
  text     : LargeString;
  metadata : LargeString;
  embedding: Vector(1536);
}

entity JSONfiles : managed, cuid {
  text              : LargeString;
  metadata          : LargeString;
  embedding_text    : Vector(1536);
  embedding_metadata: Vector(1536);
}
