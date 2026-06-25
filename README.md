# Pricing Chatbot

SAP CAP + SAPUI5 RAG chatbot for SAP pricing questions.

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

Generate pricing text files from SAP Discovery Center:

```sh
npm run pricing:etl
```

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

This embeds `db/data/*.txt` into the HANA vector table.

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

## Secrets

Ignored local files:

```text
.env
.env.*
.cdsrc-private.json
```
