#!/usr/bin/env python3
"""Import story-machine loom snapshots and optimizer-run JSON into .lore JSONL."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


IMPORTER = "splice/story-machine-import@0.1"


def dump(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def splice_digest(body: str) -> str:
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return body[:-1] + f',"digest":"sha256:{digest}"' + "}"


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def uuid7() -> str:
    ms = int(time.time() * 1000)
    rand = uuid.uuid4().int & ((1 << 74) - 1)
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0x0FFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def unix_ms_to_rfc3339(value: Any, fallback: str) -> str:
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(value / 1000, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return fallback


def run_id_to_rfc3339(value: Any, fallback: str) -> str:
    if not isinstance(value, str) or not value:
        return fallback
    # story-machine run ids are usually ISO-ish with colons/dots replaced in
    # the time tail, e.g. 2026-05-01T02-52-31-995-69488.
    date, sep, tail = value.partition("T")
    if not sep:
        return fallback
    pieces = tail.split("-")
    if len(pieces) < 3:
        return fallback
    hh, mm, ss = pieces[0], pieces[1], pieces[2]
    frac = pieces[3] if len(pieces) >= 4 and pieces[3].isdigit() else ""
    if not (date.count("-") == 2 and hh.isdigit() and mm.isdigit() and ss.isdigit()):
        return fallback
    stamp = f"{date}T{hh}:{mm}:{ss}"
    if frac:
        stamp += f".{frac}"
    stamp += "Z"
    return stamp


def source_ref(path: Path, label: str) -> str:
    return f"{path}:{label}"


def actor_for_turn(turn: dict[str, Any]) -> str:
    meta = turn.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("author"), str) and meta["author"]:
        return meta["author"]
    return "unknown"


def via_for_loom(loom: dict[str, Any]) -> str:
    meta = loom.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("generator"), str) and meta["generator"]:
        return "story-machine/" + meta["generator"]
    return "story-machine@unknown"


def turn_kind(turn: dict[str, Any]) -> str:
    role = "unknown"
    meta = turn.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("role"), str) and meta["role"]:
        role = meta["role"]
    return f"story-machine/{role}"


def turn_parent_source_ids(turn: dict[str, Any]) -> list[str]:
    meta = turn.get("meta")
    refs = meta.get("references") if isinstance(meta, dict) else None
    ordered_refs = [r for r in refs if isinstance(r, str) and r] if isinstance(refs, list) else []
    role = meta.get("role") if isinstance(meta, dict) else None

    # splice() records ordered composition inputs in references. Keep those as
    # the lore parent order so the composition can be reconstructed by readers.
    if role == "composition" and ordered_refs:
        return ordered_refs

    out: list[str] = []
    parent = turn.get("parentId")
    if isinstance(parent, str) and parent:
        out.append(parent)
    for ref in ordered_refs:
        if ref not in out:
            out.append(ref)
    return out


def loom_events(path: Path, data: dict[str, Any], marked: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    loom = data.get("loom") if isinstance(data.get("loom"), dict) else {}
    turns = data.get("turns") if isinstance(data.get("turns"), list) else []
    id_map: dict[str, str] = {}
    for turn in turns:
        if isinstance(turn, dict) and isinstance(turn.get("id"), str) and turn["id"]:
            id_map[turn["id"]] = uuid7()

    events: list[dict[str, Any]] = []
    stats = {"events": 0, "kinds": Counter(), "turns": len(id_map), "dangling_parents": 0}
    for index, turn_any in enumerate(turns, start=1):
        if not isinstance(turn_any, dict) or not isinstance(turn_any.get("id"), str):
            continue
        turn = turn_any
        source_id = turn["id"]
        parents: list[str] = []
        for parent_source_id in turn_parent_source_ids(turn):
            event_id = id_map.get(parent_source_id)
            if event_id:
                parents.append(event_id)
            else:
                stats["dangling_parents"] += 1
        event = {
            "v": 1,
            "id": id_map[source_id],
            "kind": turn_kind(turn),
            "at": unix_ms_to_rfc3339(turn.get("createdAt"), unix_ms_to_rfc3339(loom.get("createdAt"), marked)),
            "author": {
                "actor": actor_for_turn(turn),
                "operator": "deepfates",
                "via": via_for_loom(loom),
                "imported_by": IMPORTER,
                "source": source_ref(path, f"turns[{index}]#{source_id}"),
            },
            "parents": parents,
            "payload": {
                "loom": loom,
                "source_turn_id": source_id,
                "source_parent_ids": turn_parent_source_ids(turn),
                "original": turn,
            },
            "marked": marked,
        }
        events.append(event)
        stats["events"] += 1
        stats["kinds"][event["kind"]] += 1
    stats["kinds"] = dict(sorted(stats["kinds"].items()))
    return events, stats


def average(scores: dict[str, Any]) -> float:
    values = [v for v in scores.values() if isinstance(v, (int, float))]
    return sum(values) / len(values) if values else 0.0


def pareto_front(candidate_scores: dict[str, dict[str, float]], insertion_order: list[str]) -> list[str]:
    seed_ids: list[str] = []
    seen_seeds: set[str] = set()
    for candidate_id in insertion_order:
        for seed_id in candidate_scores.get(candidate_id, {}):
            if seed_id not in seen_seeds:
                seed_ids.append(seed_id)
                seen_seeds.add(seed_id)

    keep_indexes: set[int] = set()
    ordered = [cid for cid in insertion_order if cid in candidate_scores]
    for seed_id in seed_ids:
        best_idx = -1
        best_score = float("-inf")
        for index, candidate_id in enumerate(ordered):
            score = candidate_scores[candidate_id].get(seed_id, float("-inf"))
            if score > best_score:
                best_score = score
                best_idx = index
        if best_idx >= 0:
            keep_indexes.add(best_idx)
    return [candidate_id for index, candidate_id in enumerate(ordered) if index in keep_indexes]


def trajectory_score_map(entry: dict[str, Any]) -> dict[str, float]:
    seed_id = entry.get("seedId")
    if not isinstance(seed_id, str) or not seed_id:
        return {}
    per_witness = entry.get("perWitness")
    if isinstance(per_witness, list) and per_witness:
        out: dict[str, float] = {}
        for witness in per_witness:
            if (
                isinstance(witness, dict)
                and isinstance(witness.get("id"), str)
                and isinstance(witness.get("value"), (int, float))
            ):
                out[f"{seed_id}::{witness['id']}"] = float(witness["value"])
        if out:
            return out
    if isinstance(entry.get("score"), (int, float)):
        return {seed_id: float(entry["score"])}
    return {}


def optimizer_events(path: Path, data: dict[str, Any], marked: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    run_id = str(data.get("runId") or path.stem)
    at = run_id_to_rfc3339(run_id, marked)
    via = "story-machine/optimizer"
    events: list[dict[str, Any]] = []
    stats = {
        "events": 0,
        "kinds": Counter(),
        "candidates": 0,
        "scores": 0,
        "selection_events": 0,
        "front_reconstruction": "snapshot",
    }

    run_event_id = uuid7()
    run_event = {
        "v": 1,
        "id": run_event_id,
        "kind": "story-machine/optimizer-run",
        "at": at,
        "author": {
            "actor": "optimizer",
            "operator": "deepfates",
            "via": via,
            "imported_by": IMPORTER,
            "source": source_ref(path, "run"),
        },
        "parents": [],
        "payload": {
            "runId": run_id,
            "proposerModel": data.get("proposerModel"),
            "maxIterations": data.get("maxIterations"),
            "archiveSize": data.get("archiveSize"),
            "artifactPath": data.get("artifactPath"),
            "mode": data.get("mode"),
            "original": {k: v for k, v in data.items() if k not in {"front", "best", "trajectories"}},
        },
        "marked": marked,
    }
    events.append(run_event)

    candidate_event_ids: dict[str, str] = {}
    candidate_scores: dict[str, dict[str, float]] = defaultdict(dict)
    candidate_generations: dict[str, int] = {}
    candidate_order: list[str] = []

    def ensure_candidate(candidate_id: str, generation: Any = None, source_obj: Any = None) -> str:
        if candidate_id in candidate_event_ids:
            return candidate_event_ids[candidate_id]
        event_id = uuid7()
        candidate_event_ids[candidate_id] = event_id
        candidate_order.append(candidate_id)
        if isinstance(generation, int):
            candidate_generations[candidate_id] = generation
        event = {
            "v": 1,
            "id": event_id,
            "kind": "story-machine/optimizer-candidate",
            "at": at,
            "author": {
                "actor": "optimizer",
                "operator": "deepfates",
                "via": via,
                "imported_by": IMPORTER,
                "source": source_ref(path, f"candidate#{candidate_id}"),
            },
            "parents": [run_event_id],
            "payload": {
                "runId": run_id,
                "candidateId": candidate_id,
                "generation": generation,
                "source": source_obj,
            },
            "marked": marked,
        }
        events.append(event)
        stats["candidates"] += 1
        return event_id

    # Preserve front/best candidates even for old runs that lack trajectories.
    for source_obj in list(data.get("front") if isinstance(data.get("front"), list) else []) + [data.get("best")]:
        if isinstance(source_obj, dict) and isinstance(source_obj.get("id"), str) and source_obj["id"]:
            ensure_candidate(source_obj["id"], source_obj.get("generation"), source_obj.get("source"))
            scores = source_obj.get("scores")
            if isinstance(scores, dict):
                candidate_scores[source_obj["id"]].update(
                    {str(k): float(v) for k, v in scores.items() if isinstance(v, (int, float))}
                )

    trajectories = data.get("trajectories") if isinstance(data.get("trajectories"), list) else []
    for index, entry_any in enumerate(trajectories, start=1):
        if not isinstance(entry_any, dict) or not isinstance(entry_any.get("candidateId"), str):
            continue
        candidate_id = entry_any["candidateId"]
        candidate_event_id = ensure_candidate(candidate_id, entry_any.get("generation"))
        score_map = trajectory_score_map(entry_any)
        if entry_any.get("accepted") is True:
            candidate_scores[candidate_id].update(score_map)
        score_event = {
            "v": 1,
            "id": uuid7(),
            "kind": "story-machine/optimizer-score",
            "at": at,
            "author": {
                "actor": "optimizer",
                "operator": "deepfates",
                "via": via,
                "imported_by": IMPORTER,
                "source": source_ref(path, f"trajectories[{index}]"),
            },
            "parents": [candidate_event_id],
            "payload": {
                "runId": run_id,
                "candidateId": candidate_id,
                "generation": entry_any.get("generation"),
                "accepted": entry_any.get("accepted"),
                "seedId": entry_any.get("seedId"),
                "score": entry_any.get("score"),
                "archive_scores": score_map,
                "original": entry_any,
            },
            "marked": marked,
        }
        events.append(score_event)
        stats["scores"] += 1

        selection = {
            "v": 1,
            "id": uuid7(),
            "kind": "lore/selection",
            "at": at,
            "author": {
                "actor": "optimizer",
                "operator": "deepfates",
                "via": via,
                "imported_by": IMPORTER,
                "source": source_ref(path, f"trajectories[{index}]"),
            },
            "parents": [candidate_event_id],
            "payload": {
                "name": "story-machine/optimizer-acceptance",
                "selected": bool(entry_any.get("accepted")),
                "candidateId": candidate_id,
                "generation": entry_any.get("generation"),
                "seedId": entry_any.get("seedId"),
                "score_event": score_event["id"],
            },
            "marked": marked,
        }
        events.append(selection)
        stats["selection_events"] += 1

    source_front = [
        entry.get("id")
        for entry in data.get("front", [])
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    ] if isinstance(data.get("front"), list) else []
    reconstructed = pareto_front(candidate_scores, candidate_order)
    front_kind = "reconstructed" if source_front and reconstructed == source_front else "snapshot"
    if not source_front and reconstructed:
        front_kind = "reconstructed"
    stats["front_reconstruction"] = front_kind
    front_ids = reconstructed if front_kind == "reconstructed" else source_front
    front_parents = [candidate_event_ids[cid] for cid in front_ids if cid in candidate_event_ids]
    best = data.get("best") if isinstance(data.get("best"), dict) else {}
    best_id = best.get("id") if isinstance(best.get("id"), str) else None

    front_event = {
        "v": 1,
        "id": uuid7(),
        "kind": "story-machine/optimizer-front",
        "at": at,
        "author": {
            "actor": "optimizer",
            "operator": "deepfates",
            "via": via,
            "imported_by": IMPORTER,
            "source": source_ref(path, "front"),
        },
        "parents": [run_event_id, *front_parents],
        "payload": {
            "runId": run_id,
            "front_kind": front_kind,
            "front": front_ids,
            "source_front": source_front,
            "reconstructed_front": reconstructed,
            "best": best_id,
            "best_average": average(best.get("scores", {})) if isinstance(best.get("scores"), dict) else None,
            "original": {"front": data.get("front"), "best": data.get("best")},
        },
        "marked": marked,
    }
    events.append(front_event)

    best_event_parent = candidate_event_ids.get(best_id) if best_id else None
    if best_id and best_event_parent:
        events.append(
            {
                "v": 1,
                "id": uuid7(),
                "kind": "lore/selection",
                "at": at,
                "author": {
                    "actor": "optimizer",
                    "operator": "deepfates",
                    "via": via,
                    "imported_by": IMPORTER,
                    "source": source_ref(path, "best"),
                },
                "parents": [best_event_parent],
                "payload": {
                    "name": "story-machine/optimizer-best",
                    "selected": True,
                    "candidateId": best_id,
                    "generation": best.get("generation"),
                    "score_event": None,
                },
                "marked": marked,
            }
        )
        stats["selection_events"] += 1

    stats["events"] = len(events)
    stats["kinds"] = dict(sorted(Counter(event["kind"] for event in events).items()))
    return events, stats


def detect_kind(data: Any) -> str:
    if isinstance(data, dict) and isinstance(data.get("loom"), dict) and isinstance(data.get("turns"), list):
        return "loom"
    if isinstance(data, dict) and ("front" in data or "trajectories" in data or "best" in data) and "runId" in data:
        return "optimizer"
    raise ValueError("input is neither a story-machine loom snapshot nor optimizer-run JSON")


def convert(input_paths: list[Path], output_path: Path) -> dict[str, Any]:
    marked = now_rfc3339()
    totals: dict[str, Any] = {"events": 0, "files": {}, "kinds": Counter()}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as out:
        for path in input_paths:
            data = json.loads(path.read_text(encoding="utf-8"))
            kind = detect_kind(data)
            if kind == "loom":
                events, stats = loom_events(path, data, marked)
            else:
                events, stats = optimizer_events(path, data, marked)
            totals["files"][str(path)] = {"kind": kind, **stats}
            for event in events:
                out.write(splice_digest(dump(event)) + "\n")
                totals["events"] += 1
                totals["kinds"][event["kind"]] += 1
    totals["kinds"] = dict(sorted(totals["kinds"].items()))
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Import story-machine loom snapshots and optimizer-run JSON into .lore.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("-o", "--output", required=True, type=Path)
    parser.add_argument("--stats-json", action="store_true")
    args = parser.parse_args()
    stats = convert(args.inputs, args.output)
    if args.stats_json:
        print(json.dumps(stats, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"wrote {stats['events']} events to {args.output}")
        print(f"kinds={stats['kinds']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
