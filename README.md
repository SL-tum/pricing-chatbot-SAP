# SAP Discovery Center Pricing Documentation Assistant

SAP CAP + SAPUI5 RAG chatbot for SAP pricing questions.

## Retrieval Architecture

Pricing is indexed as structured source records in `Chatbot.PricingChunks`. Each record stores topic, source, section, service, plan, commercial model, region, metric, unit, numeric price, currency, source URL, sync timestamp, content hash, version, access level, text, and its embedding.

For every question the assistant:

1. extracts service, region, plan, commercial model, and metric;
2. selects `topic = pricing` filtering for normal pricing questions, or `source + section` filtering when the question explicitly targets documentation;
3. applies the selected filter and extracted metadata in SQL;
4. ranks only the filtered candidates with `COSINE_SIMILARITY` Top-K;
5. passes complete source records to the chat model;
6. answers only from those records and appends verified `source_url` citations; and
7. returns `not found in indexed source` when records, an exact requested number, or a citable source is unavailable.

## Install

Use Node 20 or 22.

```sh
cd ./Code/pricing_chatbot
npm ci
python3 -m pip install -r tools/requirements.txt
```

## Local Test

Start with an in-memory database:

```sh
npx cds serve --port 4004 --in-memory
```

Check services:

```sh
curl 'http://localhost:4004/odata/v4/my/$metadata'
curl 'http://localhost:4004/odata/v4/ticket-automator/$metadata'
curl 'http://localhost:4004/odata/v4/embedding-storage/$metadata'
```

Normal start commands run a pricing-data sync first:

```sh
npm start
npm run watch
npm run watch-hybrid
```

The sync compares SAP Discovery Center data with the local cache and regenerates changed `db/data/*.txt` files. To skip it:

```sh
SKIP_PRICING_SYNC=1 npm run watch
```

## BTP Binding

For real HANA and AI usage, bind BTP services:

```sh
npx cds bind -2 pricing-chatbot-db:pricing-chatbot-db-key
npx cds bind -2 pricing-chatbot-auth:pricing-chatbot-auth-key
npx cds bind -2 pricing-chatbot-destination:pricing-chatbot-destination-key
```

Then run:

```sh
npm run watch-hybrid
```

The Destination service must contain the `GENERATIVE_AI_HUB` destination.

## Load Documents

Generate pricing text files and the structured `db/data/pricing-records.jsonl` index from SAP Discovery Center:

```sh
npm run pricing:etl
```

Synchronize structured records and embeddings through `EmbeddingStorageService.addDocument` after deploying the updated HANA model. The sync compares stable logical keys and `content_hash`: unchanged records reuse their embeddings, changed records are updated with an incremented version, new records are inserted, and stale records are deleted. Limited/test ETL manifests only delete stale rows for the included services.

For a quick extraction test:

```sh
npm run pricing:etl:test
```

To manually check for changed or newly added pricing data:

```sh
npm run pricing:sync
```

After HANA and Generative AI Hub are available:

```sh
curl -X POST 'http://localhost:4004/odata/v4/embedding-storage/addDocument'
```

This incrementally syncs `db/data/pricing-records.jsonl` into the HANA vector table and returns `inserted`, `updated`, `unchanged`, and `deleted` counts.

## Ask Question

```sh
curl -X POST 'http://localhost:4004/odata/v4/ticket-automator/sendQuestion' \
  -H 'content-type: application/json' \
  --data '{"question":"What is the price for SAP Task Center standard plan?"}'
```

## Build

```sh
npx tsc --noEmit
npx cds build --production
```

## Evaluation Tests

Validate the 100 cases in `test/eval.json` without calling external services:

```sh
npm test
```

With the application and HANA/AI bindings running, execute the full grounded-answer evaluation:

```sh
npm run test:eval
```

Use `EVAL_LIMIT=10`, `EVAL_CATEGORY=hana_cloud_pricing`, or `EVAL_ENDPOINT=<url>` to select cases or target another deployment. The runner accepts either a cited answer or the exact fallback, reports hint recall by category, and fails on HTTP or response-contract errors.

## Secrets

Ignored local files:

```text
.env
.env.*
.cdsrc-private.json
```
