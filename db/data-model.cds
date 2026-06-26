namespace Chatbot;

using {
  cuid
} from '@sap/cds/common';

entity PricingChunks : cuid {
  topic           : String(64) default 'pricing';
  source          : String(255) default 'SAP Discovery Center';
  section         : String(128);
  service_name    : String(255) not null;
  service_plan    : String(255);
  commercial_model: String(255);
  region          : String(255);
  metric_name     : String(255);
  unit            : String(255);
  price_value     : Decimal(19, 6);
  currency        : String(3);
  source_url      : String(1024);
  last_synced_at  : Timestamp;
  content_text    : LargeString not null;
  embedding       : Vector(1536);
  content_hash    : String(64) not null;
  version         : Integer default 1;
  access_level    : String(32) default 'public';
}
