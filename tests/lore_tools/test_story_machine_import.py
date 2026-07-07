import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[2] / "lore-tools" / "story_machine_import.py"
SPEC = importlib.util.spec_from_file_location("story_machine_import", MODULE_PATH)
assert SPEC and SPEC.loader
story_machine_import = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(story_machine_import)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class StoryMachineImportTests(unittest.TestCase):
    def test_trajectoryless_optimizer_run_admits_snapshot_front(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            input_path = tmp_path / "optimizer-run.json"
            output_path = tmp_path / "out.lore.jsonl"
            run = {
                "runId": "2026-05-01T02-52-31-995-69488",
                "front": [
                    {"id": "seed0001", "generation": 0, "source": "seed source", "scores": {"s1::w1": 0.9}},
                    {"id": "child001", "generation": 1, "source": "child source", "scores": {"s1::w1": 0.4}},
                ],
                "best": {"id": "child001", "generation": 1, "source": "child source", "scores": {"s1::w1": 0.4}},
                "trajectories": [],
            }
            input_path.write_text(json.dumps(run), encoding="utf-8")

            stats = story_machine_import.convert([input_path], output_path)
            front_event = next(
                event for event in read_jsonl(output_path) if event["kind"] == "story-machine/optimizer-front"
            )

            self.assertEqual(stats["files"][str(input_path)]["front_reconstruction"], "snapshot")
            self.assertEqual(front_event["payload"]["front_kind"], "snapshot")
            self.assertEqual(front_event["payload"]["front"], ["seed0001", "child001"])
            self.assertEqual(front_event["payload"]["reconstructed_front"], [])
            self.assertEqual(
                front_event["payload"]["snapshot_scores"],
                {
                    "seed0001": {"s1::w1": 0.9},
                    "child001": {"s1::w1": 0.4},
                },
            )

    def test_loom_turn_without_string_id_is_carried_and_counted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            input_path = tmp_path / "loom.json"
            output_path = tmp_path / "out.lore.jsonl"
            loom = {
                "loom": {"id": "loom-fixture", "createdAt": 1770000000000, "meta": {"generator": "optimizer"}},
                "turns": [
                    {
                        "id": "root",
                        "createdAt": 1770000000000,
                        "payload": {"text": "seed"},
                        "meta": {"role": "seed", "author": "human"},
                    },
                    {
                        "id": 7,
                        "createdAt": 1770000001000,
                        "payload": {"text": "bad id"},
                        "meta": {"role": "prose", "author": "model-a"},
                    },
                ],
            }
            input_path.write_text(json.dumps(loom), encoding="utf-8")

            stats = story_machine_import.convert([input_path], output_path)
            events = read_jsonl(output_path)
            carried = [event for event in events if event["kind"] == "story-machine/nonconforming-turn"]

            self.assertEqual(stats["files"][str(input_path)]["turns_total"], 2)
            self.assertEqual(stats["files"][str(input_path)]["turns_imported"], 1)
            self.assertEqual(stats["files"][str(input_path)]["turns_nonconforming_carried"], 1)
            self.assertEqual(len(carried), 1)
            self.assertEqual(carried[0]["payload"]["reason"], "turn id is not a non-empty string")
            self.assertEqual(carried[0]["payload"]["original"]["id"], 7)
            self.assertTrue(carried[0]["payload"]["original_json"])


if __name__ == "__main__":
    unittest.main()
