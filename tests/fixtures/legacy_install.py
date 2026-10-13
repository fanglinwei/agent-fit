#!/usr/bin/env python3
"""Install the Codex delegation rules without replacing unrelated settings."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

if sys.version_info < (3, 11):
    raise SystemExit("需要 Python 3.11 或更新版本；安装器不会自动安装依赖。")

import tomllib


PACKAGE_ROOT = Path(__file__).resolve().parent
SKILL_NAME = "subagent-model-selection"
STATE_DIR = ".subagent-delegation"
START = "<!-- subagent-delegation:start -->"
END = "<!-- subagent-delegation:end -->"


class InstallError(Exception):
    """A conflict or unsupported installation state that must not be overwritten."""


def digest(content):
    # Installation ownership needs byte-level drift detection before upgrades.
    return hashlib.sha256(content).hexdigest()


def version_number(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise InstallError("版本格式必须为 major.minor.patch。")
    return tuple(map(int, value.split(".")))


def read_bytes(path):
    return path.read_bytes() if path.exists() else None


def check_path(home, path):
    relative = path.relative_to(home)
    current = home
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise InstallError(f"不写入符号链接路径：{current}")


def owned_path(relative):
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        return False
    if len(path.parts) >= 3 and path.parts[:2] == ("skills", SKILL_NAME):
        return True
    return len(path.parts) == 2 and path.parts[0] == "agents" and bool(
        re.fullmatch(r"task-[a-z-]+\.toml", path.name)
    )


def read_state(home):
    path = home / STATE_DIR / "state.json"
    check_path(home, path)
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        if state["schema_version"] != 1 or state["agent"] != "codex":
            raise ValueError
        version_number(state["version"])
        if not isinstance(state["files"], dict):
            raise ValueError
        for relative, value in state["files"].items():
            if not owned_path(relative) or not re.fullmatch(r"[a-f0-9]{64}", value):
                raise ValueError
        if not re.fullmatch(r"[a-f0-9]{64}", state["rules_sha256"]):
            raise ValueError
    except (KeyError, TypeError, ValueError, InstallError):
        raise InstallError("安装记录无效或不兼容；未覆盖现有文件。") from None
    return state


def payload(package_root):
    skill = package_root / "adapters" / "codex" / "skills" / SKILL_NAME
    files = {}
    for source in sorted(skill.rglob("*")):
        if source.is_symlink():
            raise InstallError("发布包包含不支持的符号链接。")
        if source.is_file() and source.name != ".DS_Store" and "__pycache__" not in source.parts:
            files[str(Path("skills") / SKILL_NAME / source.relative_to(skill))] = source.read_bytes()
    if f"skills/{SKILL_NAME}/SKILL.md" not in files:
        raise InstallError("发布包缺少 Skill。")
    agents = {}
    for source in sorted((skill / "assets" / "codex" / "agents").glob("*.toml")):
        content = source.read_bytes()
        agent = tomllib.loads(content.decode("utf-8"))
        if not all(isinstance(agent.get(key), str) and agent[key].strip()
                   for key in ("name", "description", "developer_instructions")):
            raise InstallError("发布包中的独立代理缺少必要字段。")
        if agent["name"] in agents.values():
            raise InstallError("发布包包含重复代理名称。")
        relative = str(Path("agents") / source.name)
        if not owned_path(relative):
            raise InstallError("发布包的代理文件名不在安装范围内。")
        files[relative] = content
        agents[relative] = agent["name"]
    if not agents:
        raise InstallError("发布包缺少代理配置。")
    fragment = (skill / "assets" / "AGENTS.fragment.md").read_text(encoding="utf-8")
    block = f"{START}\n{fragment.rstrip()}\n{END}\n".encode("utf-8")
    return files, agents, block


def check_agent_names(home, agents):
    config_path = home / "config.toml"
    if config_path.exists():
        try:
            registered = tomllib.loads(config_path.read_text(encoding="utf-8")).get("agents", {})
        except (tomllib.TOMLDecodeError, UnicodeError):
            raise InstallError("现有 config.toml 无法解析；未修改配置。") from None
        if not isinstance(registered, dict):
            raise InstallError("现有 config.toml 的 agents 字段不是配置表。")
        for relative, name in agents.items():
            if name not in registered:
                continue
            role = registered[name]
            value = role.get("config_file") if isinstance(role, dict) else None
            if not isinstance(value, str):
                raise InstallError(f"config.toml 已定义同名角色：{name}")
            configured = Path(value).expanduser()
            if not configured.is_absolute():
                configured = home / configured
            if configured.resolve() != (home / relative).resolve():
                raise InstallError(f"config.toml 的同名角色指向其他配置：{name}")
    for path in (home / "agents").glob("*.toml"):
        relative = str(path.relative_to(home))
        if relative in agents:
            continue
        check_path(home, path)
        try:
            name = tomllib.loads(path.read_text(encoding="utf-8")).get("name")
        except (tomllib.TOMLDecodeError, UnicodeError):
            raise InstallError(f"现有代理配置无法解析，请先检查：{path}") from None
        if name in agents.values():
            raise InstallError(f"另一文件已定义同名代理，未覆盖：{path}")


def merge_rules(original, block, state):
    text = (original or b"").decode("utf-8")
    matches = list(re.finditer(
        rf"^{re.escape(START)}\n.*?^{re.escape(END)}(?:\n|$)", text, re.M | re.S
    ))
    if text.count(START) != len(matches) or text.count(END) != len(matches) or len(matches) > 1:
        raise InstallError("AGENTS.md 的受管理标记不完整或重复；未修改规则。")
    if matches:
        match = matches[0]
        existing = match.group().encode("utf-8")
        expected = state["rules_sha256"] if state else digest(block)
        if digest(existing) not in (expected, digest(block)):
            raise InstallError("AGENTS.md 的受管理规则已被修改；请先处理冲突。")
        return (text[:match.start()] + block.decode("utf-8") + text[match.end():]).encode("utf-8")
    if state:
        raise InstallError("受管理规则已被移除；请先处理冲突。")
    if text and not text.endswith("\n"):
        text += "\n"
    if text and not text.endswith("\n\n"):
        text += "\n"
    return text.encode("utf-8") + block


def plan_install(package_root, home):
    version = (package_root / "VERSION").read_text(encoding="utf-8").strip()
    state = read_state(home)
    if state and version_number(version) < version_number(state["version"]):
        raise InstallError("拒绝降级覆盖；请使用不低于当前安装版本的发布包。")
    version_number(version)
    files, agents, block = payload(package_root)
    check_agent_names(home, agents)
    previous = state["files"] if state else {}
    changes = {}
    for relative in sorted(files.keys() | previous.keys()):
        path = home / relative
        check_path(home, path)
        original = read_bytes(path)
        desired = files.get(relative)
        if original is not None and original != desired and digest(original) != previous.get(relative):
            raise InstallError(f"文件已有不同内容或被用户修改，未覆盖：{path}")
        if original is None and relative in previous and desired is not None:
            raise InstallError(f"受管理文件已被移除，请先处理冲突：{path}")
        if original != desired:
            changes[path] = (original, desired)
    rules_path = home / "AGENTS.md"
    check_path(home, rules_path)
    original_rules = read_bytes(rules_path)
    desired_rules = merge_rules(original_rules, block, state)
    if original_rules != desired_rules:
        changes[rules_path] = (original_rules, desired_rules)
    desired_state = json.dumps({
        "schema_version": 1, "agent": "codex", "version": version,
        "files": {relative: digest(content) for relative, content in sorted(files.items())},
        "rules_sha256": digest(block),
    }, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    state_path = home / STATE_DIR / "state.json"
    original_state = read_bytes(state_path)
    if original_state != desired_state:
        changes[state_path] = (original_state, desired_state)
    return version, changes


def atomic_write(path, content):
    if content is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = (path.stat().st_mode & 0o777) if path.exists() else 0o600
    descriptor, temporary = tempfile.mkstemp(prefix=".subagent-delegation-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def install_lock(home):
    directory = home / STATE_DIR
    check_path(home, directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "install.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise InstallError("安装锁已存在；请确认没有其他安装在运行后再处理锁文件。") from None
    os.close(descriptor)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def install(package_root, home, dry_run=False):
    if dry_run:
        version, changes = plan_install(package_root, home)
        print(f"预览 Codex 安装 {version}：将更新 {len(changes)} 个文件；未写入。")
        return
    with install_lock(home):
        version, changes = plan_install(package_root, home)
        applied = []
        try:
            for path, (original, desired) in changes.items():
                check_path(home, path)
                if read_bytes(path) != original:
                    raise InstallError(f"安装期间文件发生变化，停止覆盖：{path}")
                atomic_write(path, desired)
                applied.append(path)
        except Exception:
            for path in reversed(applied):
                original, desired = changes[path]
                check_path(home, path)
                if read_bytes(path) != desired:
                    raise InstallError("安装失败，且出现并发修改；已保留该修改，请人工核对。") from None
                atomic_write(path, original)
            raise
        print(f"Codex 配置 {version} 安装完成：更新 {len(changes)} 个文件。")
        print("请在新会话核对 Skill 与四个代理角色；实际模型生效尚未验证。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=["codex"], default="codex")
    parser.add_argument("--codex-home", type=Path, help="默认使用 CODEX_HOME 或 ~/.codex")
    parser.add_argument("--dry-run", action="store_true", help="检查冲突并预览，不写入")
    args = parser.parse_args()
    home = args.codex_home or Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        install(PACKAGE_ROOT, home.expanduser().resolve(), args.dry_run)
    except (InstallError, OSError, UnicodeError, tomllib.TOMLDecodeError):
        # Exception text from parsing protected files can contain their contents.
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, InstallError) else "文件读取或写入失败；请检查路径、权限或文件格式。"
        print(f"安装未完成：{message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
