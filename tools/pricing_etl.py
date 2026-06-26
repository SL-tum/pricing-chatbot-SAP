#!/usr/bin/env python3
"""Extract, clean, and structure SAP Discovery Center pricing data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import xmltodict


SERVICE_LIST_URL = "https://discovery-center.cloud.sap/servicecatalog/Services"
SERVICE_DETAILS_URL = (
    "https://discovery-center.cloud.sap/servicecatalog/GetServicesDetails?serviceId='{}'"
)

USELESS_KEYS = {
    "CalculatorLink",
    "AdditionalCategories",
    "Category",
    "Id",
    "LicenseModelType",
    "Tags",
    "ProductId",
    "ProductType",
    "certifications",
    "CsnComponent",
    "FeatureDescLink",
    "Icon",
    "MaterialId",
    "ReferencedTools",
    "SapStoreLink",
    "ServiceJiraId",
    "resources",
    "headlines",
}


def safe_filename(value: str) -> str:
    value = re.sub(r"[\\/]+", "_", value)
    value = re.sub(r"\s+", "_", value.strip())
    value = re.sub(r"[^A-Za-z0-9_.()-]+", "_", value)
    return value.strip("_") or "unknown"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def load_json_or_default(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return load_json(path)


def fetch_service_list() -> list[dict[str, str]]:
    response = requests.get(SERVICE_LIST_URL, timeout=60)
    response.raise_for_status()
    service_data = xmltodict.parse(response.content)
    entries = service_data.get("feed", {}).get("entry", [])
    if isinstance(entries, dict):
        entries = [entries]

    services = []
    for entry in entries:
        properties = entry.get("content", {}).get("m:properties", {})
        service_id = properties.get("d:Id")
        service_name = properties.get("d:Name", "Unknown")
        if service_id:
            services.append({"id": service_id, "name": service_name})
    return services


def fetch_service_details(service_id: str, delay: float) -> str:
    response = requests.get(SERVICE_DETAILS_URL.format(service_id), timeout=90)
    response.raise_for_status()
    if delay > 0:
        time.sleep(delay)
    return response.text


def parse_service_detail(raw_xml: str) -> dict[str, Any]:
    parsed = xmltodict.parse(raw_xml)
    return json.loads(parsed["GetServicesDetails"]["#text"])


def remove_empty_values(data: Any) -> Any:
    if isinstance(data, dict):
        return {
            key: remove_empty_values(value)
            for key, value in data.items()
            if key not in USELESS_KEYS and value not in (None, "", [])
        }
    if isinstance(data, list):
        return [remove_empty_values(item) for item in data if item not in (None, "", [])]
    return data


def canonical_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def parse_price(value: Any) -> float | None:
    if value in (None, ""):
        return None
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", str(value))
    if not match:
        return None
    return float(match.group(0).replace(",", ""))


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_index_manifest(
    output_dir: Path, records: list[dict[str, Any]], full_snapshot: bool,
) -> None:
    write_json(output_dir / "pricing-index-manifest.json", {
        "source": "SAP Discovery Center",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "full_snapshot": full_snapshot,
        "service_names": sorted({record["service_name"] for record in records}),
        "record_count": len(records),
    })


class ServiceFormatter:
    def __init__(self, data: dict[str, Any], service_id: str = "") -> None:
        self.data = data
        self.service_id = service_id
        self.name = data.get("Name", "Unknown Service")
        self.description = (
            f"{data.get('LongDescription', '')}\n{data.get('ShortDescription', '')}".strip()
        )
        self.metrics = data.get("metrics", [])
        self.service_plans = self._service_plans(data.get("servicePlans", []))

    def structured_records(self, synced_at: str) -> list[dict[str, Any]]:
        """Return one filterable source record per region and price component."""
        records: list[dict[str, Any]] = []
        source_url = SERVICE_DETAILS_URL.format(self.service_id) if self.service_id else SERVICE_LIST_URL
        for plan in self.service_plans:
            plan_name = str(plan.get("Name", "Unknown Plan"))
            for model in plan.get("commercial_models", []):
                commercial_model = str(model.get("CommercialModels", ""))
                regions = sorted({
                    str(environment[2]).strip()
                    for environment in model.get("available_environment", [])
                    if len(environment) > 2 and str(environment[2]).strip()
                }) or ["Global"]
                rate_plans = model.get("ratePlans", [])
                if not rate_plans:
                    for region in regions:
                        records.append(self._record(
                            plan_name, commercial_model, region, None, None, None,
                            source_url, synced_at,
                            "No exact price is published for this service/plan/model/region.",
                        ))
                    continue

                for rate_plan in rate_plans:
                    currency = str(rate_plan.get("Currency", "")) or None
                    for block in rate_plan.get("blockRates", []):
                        metric = self.metric_name(str(block.get("MetricId", "")))
                        unit = f"billing block size {block.get('BlockSize', '')}".strip()
                        for region in regions:
                            records.append(self._record(
                                plan_name, commercial_model, region, metric, unit,
                                block.get("PricePerBlock"), source_url, synced_at,
                                "Unit price per billing block per month.", currency,
                            ))

                    for volume in rate_plan.get("allUnitVolumes", []):
                        metric = self.metric_name(str(volume.get("MetricId", "")))
                        for tier in volume.get("tiers", []):
                            bound = str(tier.get("Bound", "From previous bound"))
                            price_fields = [
                                ("fixed fee", tier.get("FixedPrice")),
                                ("unit price per month", tier.get("PricePerUnit")),
                            ]
                            for price_type, price in price_fields:
                                if price in (None, ""):
                                    continue
                                for region in regions:
                                    records.append(self._record(
                                        plan_name, commercial_model, region, metric,
                                        f"{price_type}; range {bound}", price,
                                        source_url, synced_at, price_type.capitalize() + ".", currency,
                                    ))
        return records

    def _record(
        self, plan: str, model: str, region: str, metric: str | None,
        unit: str | None, price: Any, source_url: str, synced_at: str,
        note: str, currency: str | None = None,
    ) -> dict[str, Any]:
        price_value = parse_price(price)
        content = (
            f"Service: {self.name}\nService plan: {plan}\nCommercial model: {model}\n"
            f"Region: {region}\nMetric: {metric or 'not specified'}\nUnit: {unit or 'not specified'}\n"
            f"Price: {price_value if price_value is not None else 'not published'} "
            f"{currency or ''}\n{note}"
        ).strip()
        stable = {
            "topic": "pricing",
            "source": "SAP Discovery Center",
            "section": "pricing" if price_value is not None else "service-plan",
            "service_name": self.name, "service_plan": plan,
            "commercial_model": model, "region": region, "metric_name": metric,
            "unit": unit, "price_value": price_value, "currency": currency,
            "source_url": source_url, "content_text": content,
        }
        return {
            **stable,
            "last_synced_at": synced_at,
            "content_hash": hashlib.sha256(canonical_json(stable).encode("utf-8")).hexdigest(),
            "version": 1,
            "access_level": "public",
        }

    def _service_plans(self, service_plans: list[dict[str, Any]]) -> list[dict[str, Any]]:
        output = []
        for service_plan in service_plans:
            item = {
                key: service_plan[key]
                for key in ["Name", "Description", "features"]
                if key in service_plan
            }
            item["commercial_models"] = []
            for entitlement_plan in service_plan.get("entitlementPlans", []):
                model = {
                    key: entitlement_plan[key]
                    for key in ["CommercialModels", "DirectBillingRelationship", "ratePlans"]
                    if key in entitlement_plan
                }
                model["available_environment"] = [
                    [
                        environment.get("Platform", ""),
                        environment.get("Infrastructure", ""),
                        environment.get("Region", ""),
                    ]
                    for environment in entitlement_plan.get("environments", [])
                ]
                model["available_environment"].sort(key=lambda item: tuple(item))
                item["commercial_models"].append(model)
            output.append(item)
        return output

    def metric_name(self, code: str) -> str:
        for metric in self.metrics:
            if code == metric.get("Code"):
                return metric.get("Name", "Unknown Metric")
        return "Unknown Metric"

    def metric_description(self, name: str) -> str:
        for metric in self.metrics:
            if name == metric.get("Name"):
                return metric.get("Description", "")
        return ""

    def format_all_plans(self) -> list[tuple[str, str]]:
        chunks = []
        for plan in self.service_plans:
            plan_name = plan.get("Name", "Unknown Plan")
            content = "\n".join(
                part
                for part in [self.name, self.description, self.format_service_plan(plan)]
                if part
            )
            chunks.append((plan_name, content))
        return chunks

    def text_files(self) -> dict[str, str]:
        return {
            f"{safe_filename(self.name)}_{safe_filename(plan_name)}.txt": content
            for plan_name, content in self.format_all_plans()
        }

    def format_service_plan(self, plan: dict[str, Any]) -> str:
        return "\n".join(
            [
                f"Service Plan: {plan.get('Name', 'Unknown Plan')} ({plan.get('Description', '')})",
                self.format_features(plan),
                self.format_commercial_models(plan.get("commercial_models", [])),
            ]
        )

    def format_features(self, plan: dict[str, Any]) -> str:
        features = plan.get("features", [])
        if not features:
            return "No Features"

        output = [
            "Technical Features:",
            "Feature|Quantity|Description|MoreInfo(link)",
            "-------|--------|-----------|--------------",
        ]
        for feature in features:
            output.append(
                "|".join(
                    [
                        str(feature.get("Name", "")),
                        str(feature.get("Quantity", "")),
                        str(feature.get("Value", "")),
                        f"{feature.get('MoreInfoName', '')}({feature.get('MoreInfoLink', '')})",
                    ]
                )
            )
        return "\n".join(output)

    def format_commercial_models(self, models: list[dict[str, Any]]) -> str:
        output = []
        for model in models:
            output.append(
                f"Commercial Model: {model.get('CommercialModels', '')} "
                f"({model.get('DirectBillingRelationship', '')})"
            )
            environments = ";".join(
                ", ".join(part for part in environment if part)
                for environment in model.get("available_environment", [])
            )
            output.append(f"for the following regions: {environments}.")
            output.extend(self.format_rate_plans(model.get("ratePlans", [])))
        return "\n".join(output)

    def format_rate_plans(self, rate_plans: list[dict[str, Any]]) -> list[str]:
        if not rate_plans:
            return ["Unknown Price, Please check again; Or the service under this service plan is free."]

        if rate_plans[0].get("blockRates"):
            return self.format_block_rates(rate_plans)
        if rate_plans[0].get("allUnitVolumes"):
            return self.format_unit_volumes(rate_plans)
        return ["Unknown Price, Please check again; Or the service under this service plan is free."]

    def format_block_rates(self, rate_plans: list[dict[str, Any]]) -> list[str]:
        output = [
            "Prices:",
            "Metric|Billing Block Size|Unit Price per Month",
            "------|------------------|--------------------",
        ]
        metric_names = set()
        for rate_plan in rate_plans:
            if rate_plan.get("Currency") != "EUR":
                continue
            for block in rate_plan.get("blockRates", []):
                metric = self.metric_name(block.get("MetricId", ""))
                metric_names.add(metric)
                output.append(f"{metric}|{block.get('BlockSize', '')}|{block.get('PricePerBlock', '')}")
        output.extend(self.metric_notes(metric_names))
        return output

    def format_unit_volumes(self, rate_plans: list[dict[str, Any]]) -> list[str]:
        output = [
            "Prices:",
            "Metric|Ranges|Fixed Fee|Unit Price per Month",
            "------|------|---------|--------------------",
        ]
        metric_names = set()
        for rate_plan in rate_plans:
            if rate_plan.get("Currency") != "EUR":
                continue
            for unit in rate_plan.get("allUnitVolumes", []):
                metric = self.metric_name(unit.get("MetricId", ""))
                metric_names.add(metric)
                for tier in unit.get("tiers", []):
                    output.append(
                        f"{metric}|{tier.get('Bound', 'From previous bound')}|"
                        f"{tier.get('FixedPrice', '')}|{tier.get('PricePerUnit', '')}"
                    )
        output.extend(self.metric_notes(metric_names))
        return output

    def metric_notes(self, metric_names: set[str]) -> list[str]:
        output = ["Note:"] if metric_names else []
        for metric_name in sorted(metric_names):
            description = self.metric_description(metric_name)
            if description:
                output.append(description)
        return output


def fetch_services(args: argparse.Namespace) -> None:
    services = fetch_service_list()
    if args.limit:
        services = services[: args.limit]
    write_json(args.work_dir / "sap_service_list.json", services)
    print(f"Saved {len(services)} services.")


def fetch_raw(args: argparse.Namespace) -> None:
    services = load_json(args.work_dir / "sap_service_list.json")
    service_ids = [service["id"] for service in services if service.get("id")]
    if args.limit:
        service_ids = service_ids[: args.limit]

    raw_data = {}
    for index, service_id in enumerate(service_ids, start=1):
        print(f"[{index}/{len(service_ids)}] Fetching {service_id}")
        try:
            raw_data[service_id] = {"xml_text": fetch_service_details(service_id, args.delay)}
        except requests.RequestException as error:
            print(f"Failed to fetch {service_id}: {error}")
    write_json(args.work_dir / "all_raw_data.json", raw_data)


def transform(args: argparse.Namespace) -> None:
    raw_data = load_json(args.work_dir / "all_raw_data.json")
    json_dir = args.work_dir / "json_data"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    generated = 0
    records: list[dict[str, Any]] = []
    synced_at = datetime.now(timezone.utc).isoformat()

    for service_id, entry in raw_data.items():
        try:
            service_data = remove_empty_values(parse_service_detail(entry["xml_text"]))
            service_name = service_data.get("Name", service_id)
            write_json(json_dir / f"{safe_filename(service_name)}.json", service_data)

            formatter = ServiceFormatter(service_data, service_id)
            records.extend(formatter.structured_records(synced_at))
            for plan_name, content in formatter.format_all_plans():
                file_name = f"{safe_filename(service_name)}_{safe_filename(plan_name)}.txt"
                (args.output_dir / file_name).write_text(content, encoding="utf-8")
                generated += 1
        except Exception as error:
            print(f"Failed to transform {service_id}: {error}")
    write_jsonl(args.output_dir / "pricing-records.jsonl", records)
    write_index_manifest(
        args.output_dir, records, bool(getattr(args, "full_snapshot", False)),
    )
    print(f"Generated {generated} text files in {args.output_dir}.")
    print(f"Generated {len(records)} structured pricing records.")


def write_service_data_texts(service_id: str, service_data: dict[str, Any], args: argparse.Namespace) -> int:
    service_name = service_data.get("Name", service_id)
    json_dir = args.work_dir / "json_data"
    write_json(json_dir / f"{safe_filename(service_name)}.json", service_data)

    formatter = ServiceFormatter(service_data, service_id)
    text_files = formatter.text_files()
    for file_name, content in text_files.items():
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / file_name).write_text(content, encoding="utf-8")
    return len(text_files)


def write_service_texts(service_id: str, raw_xml: str, args: argparse.Namespace) -> int:
    service_data = remove_empty_values(parse_service_detail(raw_xml))
    return write_service_data_texts(service_id, service_data, args)


def sync(args: argparse.Namespace) -> None:
    service_list_path = args.work_dir / "sap_service_list.json"
    raw_data_path = args.work_dir / "all_raw_data.json"

    old_services = load_json_or_default(service_list_path, [])
    old_raw_data = load_json_or_default(raw_data_path, {})
    old_service_ids = {service["id"] for service in old_services if service.get("id")}

    current_services = fetch_service_list()
    if args.limit:
        current_services = current_services[: args.limit]

    current_service_ids = [service["id"] for service in current_services if service.get("id")]
    new_service_ids = set(current_service_ids) - old_service_ids
    removed_service_ids = old_service_ids - set(current_service_ids)

    updated_raw_data = dict(old_raw_data)
    changed_service_ids = []
    generated_files = 0

    for index, service_id in enumerate(current_service_ids, start=1):
        print(f"[{index}/{len(current_service_ids)}] Checking {service_id}")
        raw_xml = fetch_service_details(service_id, args.delay)
        old_xml = old_raw_data.get(service_id, {}).get("xml_text")

        service_data = remove_empty_values(parse_service_detail(raw_xml))
        current_content = canonical_json(ServiceFormatter(service_data, service_id).text_files())
        old_content = None
        if old_xml:
            try:
                old_data = remove_empty_values(parse_service_detail(old_xml))
                old_content = canonical_json(ServiceFormatter(old_data, service_id).text_files())
            except Exception:
                old_content = None

        if old_content == current_content:
            continue

        status = "new" if service_id in new_service_ids or old_xml is None else "changed"
        print(f"Detected {status} pricing data for {service_id}")
        updated_raw_data[service_id] = {"xml_text": raw_xml}
        changed_service_ids.append(service_id)
        generated_files += write_service_data_texts(service_id, service_data, args)

    write_json(service_list_path, current_services)
    write_json(raw_data_path, updated_raw_data)
    rebuild_structured_index(updated_raw_data, current_service_ids, args)

    if removed_service_ids:
        print(f"Services no longer listed: {len(removed_service_ids)}")

    if changed_service_ids:
        print(
            f"Updated {len(changed_service_ids)} services and generated "
            f"{generated_files} text files."
        )
    else:
        print("No pricing changes detected.")


def rebuild_structured_index(
    raw_data: dict[str, Any], service_ids: list[str], args: argparse.Namespace,
) -> None:
    synced_at = datetime.now(timezone.utc).isoformat()
    records: list[dict[str, Any]] = []
    for service_id in service_ids:
        entry = raw_data.get(service_id)
        if not entry:
            continue
        try:
            service_data = remove_empty_values(parse_service_detail(entry["xml_text"]))
            records.extend(ServiceFormatter(service_data, service_id).structured_records(synced_at))
        except Exception as error:
            print(f"Failed to index structured records for {service_id}: {error}")
    write_jsonl(args.output_dir / "pricing-records.jsonl", records)
    write_index_manifest(
        args.output_dir, records, full_snapshot=bool(service_ids) and args.limit == 0,
    )
    print(f"Generated {len(records)} structured pricing records.")


def run_all(args: argparse.Namespace) -> None:
    fetch_services(args)
    fetch_raw(args)
    services = load_json(args.work_dir / "sap_service_list.json")
    raw_data = load_json(args.work_dir / "all_raw_data.json")
    expected_ids = {service["id"] for service in services if service.get("id")}
    args.full_snapshot = bool(expected_ids) and args.limit == 0 and expected_ids.issubset(raw_data)
    transform(args)


def run_startup_sync(args: argparse.Namespace) -> None:
    if os.environ.get("SKIP_PRICING_SYNC") == "1":
        print("Skipping pricing sync because SKIP_PRICING_SYNC=1.")
        return

    try:
        sync(args)
    except Exception as error:
        message = f"Pricing sync failed: {error}"
        if args.strict:
            raise
        print(f"{message}. Continuing startup.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["fetch-services", "fetch-raw", "transform", "sync", "startup-sync", "all"],
    )
    parser.add_argument("--work-dir", type=Path, default=Path("tools/generated-pricing"))
    parser.add_argument("--output-dir", type=Path, default=Path("db/data"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail with a non-zero exit code if startup sync cannot reach the source.",
    )
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)

    if args.command == "fetch-services":
        fetch_services(args)
    elif args.command == "fetch-raw":
        fetch_raw(args)
    elif args.command == "transform":
        transform(args)
    elif args.command == "sync":
        sync(args)
    elif args.command == "startup-sync":
        run_startup_sync(args)
    else:
        try:
            run_all(args)
        except Exception as error:
            print(f"ETL failed: {error}", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
