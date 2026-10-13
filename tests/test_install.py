import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("delegation_installer", ROOT / "tests/fixtures/legacy_install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def snapshot(home):
    return {str(path.relative_to(home)): path.read_bytes()
            for path in home.rglob("*") if path.is_file()}


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.home = self.directory / "codex-home"

    def run_install(self, root=ROOT, dry_run=False):
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install(root, self.home, dry_run)

    def package_copy(self):
        copy = self.directory / "release"
        copy.mkdir()
        shutil.copy2(ROOT / "VERSION", copy / "VERSION")
        shutil.copytree(ROOT / "adapters", copy / "adapters")
        return copy

    def test_dry_run_and_repeated_install_preserve_user_settings(self):
        self.run_install(dry_run=True)
        self.assertFalse(self.home.exists())
        self.home.mkdir()
        private_config = b'model = "user-model"\n[model_providers.custom]\napi_key = "TEST_ONLY_NOT_REAL"\n'
        (self.home / "config.toml").write_bytes(private_config)
        original_rules = b"# User rules\n\nDo not commit without approval.\n"
        (self.home / "AGENTS.md").write_bytes(original_rules)
        (self.home / "agents").mkdir()
        original_agent = b'name = "default"\ndescription = "Existing agent"\n'
        (self.home / "agents/default.toml").write_bytes(original_agent)
        self.run_install()
        self.assertEqual((self.home / "config.toml").read_bytes(), private_config)
        self.assertEqual((self.home / "agents/default.toml").read_bytes(), original_agent)
        self.assertTrue((self.home / "AGENTS.md").read_bytes().startswith(original_rules))
        before = snapshot(self.home)
        self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_role_schema_and_unpinned_user_choice(self):
        self.run_install()
        names = set()
        contracts = []
        for path in (self.home / "agents").glob("*.toml"):
            agent = tomllib.loads(path.read_text())
            self.assertTrue(all(agent.get(key) for key in ("name", "description", "developer_instructions")))
            self.assertFalse(agent["features"]["image_generation"])
            names.add(agent["name"])
            contracts.append(agent["developer_instructions"].split("\n\n本角色")[0])
            if agent["name"] == "task_delegate":
                self.assertNotIn("model", agent)
                self.assertNotIn("model_reasoning_effort", agent)
            else:
                self.assertIn("model", agent)
                self.assertIn("model_reasoning_effort", agent)
        self.assertEqual(names, {"task_delegate", "task_scan", "task_execute", "task_review"})
        self.assertEqual(len(set(contracts)), 1)

    def test_upgrade_removes_only_owned_obsolete_files(self):
        release = self.package_copy()
        skill = release / "adapters/codex/skills" / installer.SKILL_NAME
        (skill / "obsolete.txt").write_text("Old managed content")
        self.run_install(release)
        user_note = self.home / "skills" / installer.SKILL_NAME / "my-notes.txt"
        user_note.write_text("User-owned notes")
        next_version = installer.version_number((ROOT / "VERSION").read_text().strip())
        next_version = f"{next_version[0]}.{next_version[1]}.{next_version[2] + 1}"
        (release / "VERSION").write_text(next_version + "\n")
        (skill / "obsolete.txt").unlink()
        (skill / "SKILL.md").write_text((skill / "SKILL.md").read_text() + "\nUpdated release.\n")
        self.run_install(release)
        self.assertFalse((user_note.parent / "obsolete.txt").exists())
        self.assertEqual(user_note.read_text(), "User-owned notes")
        state = json.loads((self.home / installer.STATE_DIR / "state.json").read_text())
        self.assertEqual(state["version"], next_version)
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install(ROOT)
        self.assertEqual(snapshot(self.home), before)

    def test_user_edits_stop_all_writes(self):
        self.run_install()
        path = self.home / "agents/task-execute.toml"
        path.write_text(path.read_text() + "\n# User customization\n")
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_rule_block_edit_stops_all_writes(self):
        self.run_install()
        path = self.home / "AGENTS.md"
        fragment_line = (ROOT / "adapters/codex/skills/subagent-model-selection/assets/AGENTS.fragment.md").read_text().splitlines()[0]
        path.write_text(path.read_text().replace(fragment_line, "User-edited managed content"))
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_name_conflicts_in_files_and_registration_are_rejected(self):
        (self.home / "agents").mkdir(parents=True)
        other = self.home / "agents/custom.toml"
        other.write_text('name = "task_scan"\ndescription = "User role"\n')
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(snapshot(self.home), before)
        other.unlink()
        (self.home / "config.toml").write_text('[agents.task_scan]\nconfig_file = "elsewhere.toml"\n')
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_symlink_and_invalid_manifest_cannot_redirect_writes(self):
        self.home.mkdir()
        outside = self.directory / "outside"
        outside.mkdir()
        (self.home / "agents").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(list(outside.iterdir()), [])
        (self.home / "agents").unlink()
        state_path = self.home / installer.STATE_DIR / "state.json"
        state_path.write_text(json.dumps({
            "schema_version": 1, "agent": "codex", "version": "0.1.0",
            "files": {"../outside/private.txt": "0" * 64}, "rules_sha256": "0" * 64,
        }))
        before = snapshot(self.home)
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_write_failure_rolls_back_completed_changes(self):
        self.home.mkdir()
        (self.home / "AGENTS.md").write_text("User rules\n")
        before = snapshot(self.home)
        real_write = installer.atomic_write
        calls = 0

        def failing_write(path, content):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("Simulated write failure")
            return real_write(path, content)

        with mock.patch.object(installer, "atomic_write", side_effect=failing_write):
            with self.assertRaises(OSError):
                self.run_install()
        self.assertEqual(snapshot(self.home), before)

    def test_cli_installs_in_path_with_spaces_and_rejects_other_agents(self):
        target = self.directory / "Codex home with spaces"
        command = [sys.executable, str(ROOT / "install.py"), "--codex-home", str(target)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((target / "agents/task-delegate.toml").is_file())
        before = snapshot(target)
        result = subprocess.run(command + ["--agent", "other"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(snapshot(target), before)

    def test_conflict_output_does_not_expose_configuration_values(self):
        self.home.mkdir()
        private_config = 'agents = true\nprivate_value = "TEST_ONLY_NOT_REAL"\n'
        (self.home / "config.toml").write_text(private_config)
        command = [sys.executable, str(ROOT / "install.py"), "--codex-home", str(self.home)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("TEST_ONLY_NOT_REAL", result.stdout + result.stderr)
        self.assertEqual((self.home / "config.toml").read_text(), private_config)
        self.assertFalse((self.home / "agents/task-delegate.toml").exists())


if __name__ == "__main__":
    unittest.main()
